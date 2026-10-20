import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { prisma } from '../../db/prisma.js'
import { encrypt, decrypt, sha256, safeEqual } from '../../lib/crypto.js'
import { recordAudit } from '../../lib/audit.js'
import { hasPermission } from '../../config/permissions.js'
import { planHasFeature } from '../../config/plans.js'
import { assertFeature } from '../../services/entitlements.service.js'
import { notificationContext } from '../../services/notificationAccess.service.js'
import { ApiError } from '../../utils/ApiError.js'
import { graph, graphPage, managedPages, facebookConfiguration, requireFacebookConfiguration } from './graph.js'
import { lockFacebookSubject, parseFacebookSignedRequest, verifyFacebookUserToken } from './identity.js'

export const FACEBOOK_COOKIE = 'techsync_facebook_oauth'
export const facebookCookieOptions = () => ({ httpOnly: true, secure: env.isProduction || env.FACEBOOK_REDIRECT_URI.startsWith('https:'), sameSite: 'lax', path: '/api/integrations/facebook', maxAge: 10 * 60000 })
const pageSelect = { id: true, facebookPageId: true, name: true, enabled: true, createdAt: true }
export const formSelect = { id: true, pageId: true, facebookFormId: true, name: true, mapping: true, enabled: true, defaultOwnerId: true, dedupe: true, syncStatus: true, lastSyncedAt: true, lastError: true, updatedAt: true }
export async function connectorContext(connection, db = prisma) {
  const ctx = connection.connectedById && await notificationContext(connection.organizationId, connection.connectedById, db)
  if (!ctx || !hasPermission(ctx.permissions, 'settings.workspace.manage')) throw new ApiError(403, 'The person who connected Facebook no longer has workspace integration access. An owner or admin must reconnect.', { code: 'FACEBOOK_RECONNECT_REQUIRED' })
  assertFeature({ plan: ctx.organization.plan }, 'marketplaceSync')
  const org = await db.organization.findUnique({ where: { id: ctx.orgId }, select: { country: true, currency: true } })
  return { ...ctx, ...org, plan: ctx.organization.plan, actorType: 'system' }
}
export async function connectionFor(ctx) {
  requireFacebookConfiguration()
  const row = await prisma.facebookConnection.findUnique({ where: { organizationId: ctx.orgId } })
  if (!row?.tokenEnc) throw new ApiError(409, 'Connect Facebook first.', { code: 'FACEBOOK_NOT_CONNECTED' })
  if (row.tokenExpiresAt && row.tokenExpiresAt <= new Date()) throw new ApiError(409, 'Facebook access expired. Reconnect Facebook.', { code: 'FACEBOOK_RECONNECT_REQUIRED' })
  await connectorContext(row)
  return row
}
export async function facebookStatus(ctx) {
  const config = facebookConfiguration()
  const connection = await prisma.facebookConnection.findUnique({ where: { organizationId: ctx.orgId }, select: { id: true, name: true, facebookUserId: true, tokenExpiresAt: true, tokenEnc: true, connectedById: true, organizationId: true } })
  let needsReconnect = Boolean(connection?.tokenEnc && connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date())
  if (connection?.tokenEnc) { try { await connectorContext(connection) } catch (err) { if (err.code !== 'FEATURE_NOT_IN_PLAN') needsReconnect = true } }
  const pages = await prisma.facebookPage.findMany({ where: { organizationId: ctx.orgId }, select: { ...pageSelect, forms: { select: formSelect, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } })
  return { ...config, sdk: { appId: env.FACEBOOK_APP_ID, version: env.FACEBOOK_API_VERSION, configId: env.FACEBOOK_LOGIN_CONFIG_ID || null, scope: env.FACEBOOK_SCOPES }, available: planHasFeature(ctx.plan, 'marketplaceSync'), connected: Boolean(connection?.tokenEnc), needsReconnect, account: connection?.tokenEnc ? { name: connection.name, facebookUserId: connection.facebookUserId, tokenExpiresAt: connection.tokenExpiresAt } : null, pages }
}
export async function startFacebookLogin(ctx) {
  requireFacebookConfiguration()
  assertFeature(ctx, 'marketplaceSync')
  const state = crypto.randomBytes(32).toString('base64url'), browser = crypto.randomBytes(32).toString('base64url')
  await prisma.facebookOAuthState.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, stateHash: sha256(state), browserHash: sha256(browser), expiresAt: new Date(Date.now() + 10 * 60000) } })
  const url = new URL(`https://www.facebook.com/${env.FACEBOOK_API_VERSION}/dialog/oauth`)
  url.search = new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, redirect_uri: env.FACEBOOK_REDIRECT_URI, state, response_type: 'code', ...(env.FACEBOOK_LOGIN_CONFIG_ID ? { config_id: env.FACEBOOK_LOGIN_CONFIG_ID } : { scope: env.FACEBOOK_SCOPES, auth_type: 'rerequest' }) }).toString()
  return { url: url.toString(), browser }
}
export async function finishFacebookLogin(query, browser) {
  requireFacebookConfiguration()
  if (typeof query.state !== 'string' || query.state.length > 200 || typeof browser !== 'string') throw ApiError.badRequest('Facebook login expired. Start again.')
  const state = await prisma.$transaction(async (tx) => {
    const row = await tx.facebookOAuthState.findUnique({ where: { stateHash: sha256(query.state) } })
    if (!row || row.purpose !== 'redirect' || row.expiresAt <= new Date() || !safeEqual(row.browserHash, sha256(browser))) throw ApiError.badRequest('Facebook login expired. Start again.')
    const claimed = await tx.facebookOAuthState.deleteMany({ where: { id: row.id, expiresAt: { gt: new Date() }, browserHash: sha256(browser) } })
    if (!claimed.count) throw ApiError.badRequest('Facebook login already used.')
    return row
  })
  if (query.error || typeof query.code !== 'string' || query.code.length > 4096) throw new ApiError(400, 'Facebook connection was cancelled.', { code: 'FACEBOOK_LOGIN_CANCELLED' })
  const ctx = await connectorContext({ organizationId: state.organizationId, connectedById: state.userId })
  const short = await graph('oauth/access_token', null, { client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri: env.FACEBOOK_REDIRECT_URI, code: query.code })
  if (!short.access_token) throw ApiError.badRequest('Facebook did not return an access token.')
  return persistFacebookAuthorization(ctx, short.access_token)
}

/** Shared by redirect and SDK login: never trust the browser's user ID, expiry or profile. */
async function persistFacebookAuthorization(ctx, shortToken, expectedUserId) {
  const initial = await verifyFacebookUserToken(shortToken, expectedUserId)
  const token = await graph('oauth/access_token', null, { grant_type: 'fb_exchange_token', client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, fb_exchange_token: shortToken })
  if (!token.access_token) throw ApiError.badRequest('Facebook did not return an access token.')
  const verified = await verifyFacebookUserToken(token.access_token, initial.user_id)
  const profile = await graph('me', token.access_token, { fields: 'id,name' })
  if (profile.id !== verified.user_id) throw ApiError.badRequest('Facebook account verification failed.')
  const expiries = [verified.expires_at, verified.data_access_expires_at].filter((value) => Number.isSafeInteger(value) && value > 0)
  const tokenExpiresAt = expiries.length ? new Date(Math.min(...expiries) * 1000) : null
  await prisma.$transaction(async (tx) => {
    const subjectHash = await lockFacebookSubject(tx, profile.id)
    const pending = await tx.facebookDeletionRequest.count({ where: { subjectHash, status: { not: 'completed' } } })
    if (pending) throw new ApiError(409, 'Facebook data deletion is still processing. Connect again after it completes.', { code: 'FACEBOOK_DELETION_PENDING' })
    await connectorContext({ organizationId: ctx.orgId, connectedById: ctx.userId }, tx)
    await tx.$queryRaw`SELECT id FROM facebook_connections WHERE organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    // Selected Pages must be explicitly reconnected to obtain fresh Page tokens.
    await tx.facebookPage.updateMany({ where: { organizationId: ctx.orgId }, data: { enabled: false, tokenEnc: '' } })
    const credentials = { connectedById: ctx.userId, facebookUserId: profile.id, name: profile.name ?? 'Facebook', tokenEnc: encrypt(token.access_token), tokenExpiresAt, authorizedAt: new Date() }
    const row = await tx.facebookConnection.upsert({ where: { organizationId: ctx.orgId }, create: { organizationId: ctx.orgId, ...credentials }, update: credentials })
    await recordAudit(tx, ctx, { action: 'facebook.connected', entityType: 'facebook_connection', entityId: row.id })
  })
  return ctx.orgId
}

export async function prepareFacebookSdkLogin(ctx) {
  requireFacebookConfiguration()
  assertFeature(ctx, 'marketplaceSync')
  if (!ctx.sessionId) throw ApiError.unauthorized('Sign into TechSync again before connecting Facebook.')
  const nonce = crypto.randomBytes(32).toString('base64url')
  await prisma.facebookOAuthState.create({ data: { organizationId: ctx.orgId, userId: ctx.userId, purpose: 'sdk', stateHash: sha256(nonce), browserHash: sha256(`sdk:${ctx.sessionId}`), expiresAt: new Date(Date.now() + 10 * 60000) } })
  return { nonce, expiresIn: 600 }
}
export async function finishFacebookSdkLogin(ctx, input) {
  requireFacebookConfiguration()
  assertFeature(ctx, 'marketplaceSync')
  if (!ctx.sessionId) throw ApiError.unauthorized('Sign into TechSync again before connecting Facebook.')
  const claimed = await prisma.facebookOAuthState.deleteMany({ where: { stateHash: sha256(input.nonce), purpose: 'sdk', organizationId: ctx.orgId, userId: ctx.userId, browserHash: sha256(`sdk:${ctx.sessionId}`), expiresAt: { gt: new Date() } } })
  if (!claimed.count) throw new ApiError(409, 'Facebook login challenge expired. Click Connect again.', { code: 'FACEBOOK_CHALLENGE_EXPIRED' })
  const signed = parseFacebookSignedRequest(input.signedRequest)
  if (!safeEqual(signed.user_id, input.userId)) throw ApiError.badRequest('Facebook identity did not match its signed response.')
  const orgId = await persistFacebookAuthorization(ctx, input.accessToken, signed.user_id)
  return { organizationId: orgId, connected: true }
}

export async function availablePages(ctx, after) {
  const row = await connectionFor(ctx), data = await managedPages(decrypt(row.tokenEnc), after)
  const connected = await prisma.facebookPage.findMany({ where: { organizationId: ctx.orgId }, select: pageSelect })
  return { ...data, items: data.items.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks ?? [], connected: connected.some((c) => c.facebookPageId === p.id && c.enabled) })) }
}
export async function connectPage(ctx, facebookPageId) {
  const row = await connectionFor(ctx), token = decrypt(row.tokenEnc)
  let cursor, selected
  for (let i = 0; i < 50; i++) {
    const page = await managedPages(token, cursor)
    selected = page.items.find((p) => p.id === facebookPageId)
    if (selected || !page.nextCursor) break
    cursor = page.nextCursor
  }
  if (!selected?.access_token) throw ApiError.badRequest('This Page was not granted to the Facebook connection. Reconnect and select the Page.')
  const existing = await prisma.facebookPage.findUnique({ where: { facebookPageId } })
  if (existing && existing.organizationId !== ctx.orgId) throw ApiError.conflict('This Facebook Page is already connected to another workspace. Disconnect it there first.')
  // A Page is globally unique here, so one webhook cannot route private leads to two workspaces.
  const saved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM facebook_connections WHERE id = ${row.id}::uuid FOR UPDATE`
    const current = await tx.facebookConnection.findUnique({ where: { id: row.id } })
    if (!current?.tokenEnc || current.updatedAt.getTime() !== row.updatedAt.getTime()) throw ApiError.conflict('Facebook connection changed. Reload and try again.')
    let page
    try { page = await tx.facebookPage.upsert({ where: { facebookPageId }, create: { organizationId: ctx.orgId, connectionId: row.id, facebookPageId, name: selected.name, tokenEnc: encrypt(selected.access_token) }, update: { name: selected.name, tokenEnc: encrypt(selected.access_token), enabled: true } }) }
    catch (err) { if (err.code === 'P2002') throw ApiError.conflict('This Page was connected elsewhere. Reload and try again.'); throw err }
    if (page.organizationId !== ctx.orgId) throw ApiError.conflict('This Page is already connected to another workspace.')
    await recordAudit(tx, ctx, { action: 'facebook.page_connected', entityType: 'facebook_page', entityId: page.id })
    return page
  })
  try { await graph(`${facebookPageId}/subscribed_apps`, selected.access_token, { subscribed_fields: 'leadgen' }, 'POST') }
  catch (err) { await prisma.facebookPage.updateMany({ where: { id: saved.id, tokenEnc: saved.tokenEnc }, data: { enabled: false } }); throw err }
  return Object.fromEntries(Object.keys(pageSelect).map((key) => [key, saved[key]]))
}
export async function pageFor(ctx, id) {
  const page = await prisma.facebookPage.findFirst({ where: { id, organizationId: ctx.orgId, enabled: true }, include: { connection: true } })
  if (!page?.tokenEnc || !page.connection.tokenEnc) throw ApiError.notFound('Connected Facebook Page not found.')
  await connectorContext(page.connection)
  return page
}
export async function listForms(ctx, pageId, after) {
  const page = await pageFor(ctx, pageId)
  const data = graphPage(await graph(`${page.facebookPageId}/leadgen_forms`, decrypt(page.tokenEnc), { fields: 'id,name,status,questions', limit: 100, after }))
  const settings = await prisma.facebookForm.findMany({ where: { pageId, organizationId: ctx.orgId }, select: formSelect })
  return { ...data, items: data.items.map((form) => ({ ...form, settings: settings.find((s) => s.facebookFormId === form.id) ?? null })) }
}
export async function configureForm(ctx, pageId, facebookFormId, input) {
  const page = await pageFor(ctx, pageId)
  const form = await graph(facebookFormId, decrypt(page.tokenEnc), { fields: 'id,name,page_id,questions' })
  if (String(form.page_id) !== page.facebookPageId) throw ApiError.notFound('Form does not belong to this Page.')
  const questions = new Set((form.questions ?? []).map((q) => q.key).filter(Boolean))
  for (const key of Object.keys(input.mapping ?? {})) if (!questions.has(key)) throw ApiError.badRequest(`Unknown Facebook form field: ${key}`)
  if (input.enabled && !Object.values(input.mapping).some((value) => ['fullName', 'firstName', 'email', 'phone'].includes(value))) throw ApiError.badRequest('Map at least a name, email or phone before enabling capture.')
  if (input.defaultOwnerId && !await prisma.membership.count({ where: { organizationId: ctx.orgId, userId: input.defaultOwnerId, status: 'active' } })) throw ApiError.badRequest('Choose an active workspace member as owner.')
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM facebook_pages WHERE id = ${pageId}::uuid FOR UPDATE`
    const current = await tx.facebookPage.findFirst({ where: { id: pageId, organizationId: ctx.orgId, enabled: true } })
    if (!current) throw ApiError.notFound('Connected Page no longer available.')
    const row = await tx.facebookForm.upsert({ where: { pageId_facebookFormId: { pageId, facebookFormId } }, create: { organizationId: ctx.orgId, pageId, facebookFormId, name: form.name, ...input }, update: { name: form.name, ...input }, select: formSelect })
    await recordAudit(tx, ctx, { action: 'facebook.form_configured', entityType: 'facebook_form', entityId: row.id, changes: { enabled: row.enabled } })
    return row
  })
}
export async function disconnectPage(ctx, id) {
  const page = await prisma.facebookPage.findFirst({ where: { id, organizationId: ctx.orgId } })
  if (!page) throw ApiError.notFound('Page not found.')
  await prisma.$transaction(async (tx) => {
    await tx.facebookPage.delete({ where: { id, organizationId: ctx.orgId } })
    await recordAudit(tx, ctx, { action: 'facebook.page_disconnected', entityType: 'facebook_page', entityId: id })
  })
  // Local disconnection takes effect even if the provider token has already been revoked.
  if (page.tokenEnc) await graph(`${page.facebookPageId}/subscribed_apps`, decrypt(page.tokenEnc), {}, 'DELETE').catch(() => {})
}
export async function disconnectFacebook(ctx) {
  const pages = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM facebook_connections WHERE organization_id = ${ctx.orgId}::uuid FOR UPDATE`
    const currentPages = await tx.facebookPage.findMany({ where: { organizationId: ctx.orgId } })
    await tx.facebookConnection.updateMany({ where: { organizationId: ctx.orgId }, data: { tokenEnc: '', connectedById: null } })
    await tx.facebookPage.deleteMany({ where: { organizationId: ctx.orgId } })
    await tx.facebookOAuthState.deleteMany({ where: { organizationId: ctx.orgId } })
    await recordAudit(tx, ctx, { action: 'facebook.disconnected', entityType: 'organization', entityId: ctx.orgId })
    return currentPages
  })
  for (const page of pages) if (page.tokenEnc) await graph(`${page.facebookPageId}/subscribed_apps`, decrypt(page.tokenEnc), {}, 'DELETE').catch(() => {})
}
