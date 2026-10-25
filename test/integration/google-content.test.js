import crypto from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ queue: vi.fn(), env: {
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused', DB_POOL_MAX: 5,
  JWT_ACCESS_SECRET: 'google-content-fixture-only-01234567890123456789', JWT_ISSUER: 'test', JWT_AUDIENCE: 'test', JWT_ACCESS_EXPIRES_IN: '15m',
  DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', FRONTEND_URL: 'https://example.test',
  GOOGLE_WORKSPACE_ENABLED: true, GOOGLE_WORKSPACE_CALENDAR_ENABLED: true, GOOGLE_WORKSPACE_DRIVE_ENABLED: true, GOOGLE_WORKSPACE_SHEETS_ENABLED: true,
  GOOGLE_WORKSPACE_CLIENT_ID: '123456789-fixture.apps.googleusercontent.com', GOOGLE_WORKSPACE_CLIENT_SECRET: 'fixture-secret', GOOGLE_WORKSPACE_PROJECT_NUMBER: '123456789',
  GOOGLE_WORKSPACE_REDIRECT_URI: 'https://example.test/api/google/oauth/callback', GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
} }))
vi.mock('../../src/config/env.js', () => ({ env: fixture.env }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: fixture.queue }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: vi.fn() }))
import { prisma } from '../../src/db/prisma.js'
import { googleWorkspaceRoutes } from '../../src/routes/googleWorkspace.routes.js'
import { errorHandler } from '../../src/middlewares/errorHandler.js'
import { signAccessToken } from '../../src/services/token.service.js'
import { currentContext } from '../../src/integrations/google/access.js'
import { googleProvider } from '../../src/integrations/google/provider.js'
import { sealValue, workspaceContext } from '../../src/integrations/google/envelope.js'
import { CONSENT_VERSION, fingerprint, googleError, SERVICE_SCOPES } from '../../src/integrations/google/config.js'
import { syncCalendarEvent } from '../../src/integrations/google/calendar.js'
import { runGoogleSheet } from '../../src/integrations/google/sheets.js'
import { fakeGoogleContent } from '../fixtures/google-content-provider.js'

let server, base, org, other, users, sessions, connection, lead, fake
const call = async (path, { user = 0, tenant, method = 'GET', body } = {}) => {
  const response = await fetch(`${base}/api/google${path}`, { method, headers: { authorization: `Bearer ${signAccessToken(users[user], tenant || org.id, sessions[user]).accessToken}`, 'content-type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) })
  const json = await response.json()
  return { status: response.status, data: json.data, error: json.error }
}
const meetingInput = (overrides = {}) => ({ requestId: crypto.randomUUID(), title: 'Lead discussion', startAt: '2027-03-14T10:00:00+05:30', endAt: '2027-03-14T10:45:00+05:30', timeZone: 'Asia/Kolkata', includeMeet: true, ...overrides })
const sheetInput = (overrides = {}) => ({ requestId: crypto.randomUUID(), title: 'CRM notes', kind: 'blank', ...overrides })
const createMeeting = async (overrides) => { const result = await call('/calendar/events', { method: 'POST', body: meetingInput(overrides) }); expect(result.status, JSON.stringify(result)).toBe(200); return result.data }
const createSheet = async (overrides) => { const result = await call('/sheets', { method: 'POST', body: sheetInput(overrides) }); expect(result.status, JSON.stringify(result)).toBe(200); return result.data }
const eventRow = (id) => prisma.googleCalendarEvent.findUnique({ where: { id } })
const sheetRow = (id) => prisma.googleSheet.findUnique({ where: { id } })
const remoteEvent = () => [...fake.events.values()][0]
describe.skipIf(!process.env.TEST_DATABASE_URL)('Calendar, Meet and Sheets with real Postgres and synthetic Google', () => {
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && process.env.TEST_DATABASE_DISPOSABLE !== 'true') throw new Error('Disposable test database required')
    users = await Promise.all(['owner', 'sales_rep', 'manager', 'viewer', 'admin'].map((role) => prisma.user.create({ data: { fullName: role, email: `${crypto.randomUUID()}@example.test`, emailVerifiedAt: new Date() } })))
    sessions = users.map(() => crypto.randomUUID())
    await prisma.refreshToken.createMany({ data: users.map((user, i) => ({ userId: user.id, sessionId: sessions[i], tokenHash: crypto.randomUUID(), expiresAt: new Date(Date.now() + 86400000) })) })
    org = await prisma.organization.create({ data: { name: 'Google tools', slug: `gc-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    other = await prisma.organization.create({ data: { name: 'Other Google tenant', slug: `gc-${crypto.randomUUID()}`, plan: 'growth', createdById: users[0].id } })
    await prisma.membership.createMany({ data: users.map((user, i) => ({ organizationId: org.id, userId: user.id, role: ['owner', 'sales_rep', 'manager', 'viewer', 'admin'][i] })).concat([{ organizationId: other.id, userId: users[0].id, role: 'owner' }]) })
    vi.spyOn(googleProvider, 'refresh').mockResolvedValue({ access_token: 'fixture-access', expiry_date: Date.now() + 3600000 })
    vi.spyOn(googleProvider, 'request')
    const app = express(); app.use(express.json(), cookieParser()); app.use('/api/google', googleWorkspaceRoutes); app.use(errorHandler)
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)) }); base = `http://127.0.0.1:${server.address().port}`
  })
  async function connect(user = 0) {
    const row = { id: crypto.randomUUID(), organizationId: org.id, userId: users[user].id, googleSubject: `fixture-subject-${user}`, email: `work-${user}@example.test`, projectNumber: fixture.env.GOOGLE_WORKSPACE_PROJECT_NUMBER, clientFingerprint: fingerprint(fixture.env.GOOGLE_WORKSPACE_CLIENT_ID), grantHash: fingerprint(`fixture-${user}`), grantedScopes: [...new Set(Object.values(SERVICE_SCOPES))] }
    const key = await googleProvider.newKey(row)
    return prisma.googleConnection.create({ data: { ...row, wrappedKey: key.wrappedKey, keyVersion: key.keyVersion, credentialEnc: sealValue(key.key, workspaceContext(row), 'credentials', { refreshToken: 'fixture-refresh' }), services: { create: ['calendar', 'sheets'].map((service) => ({ service, enabled: true, consentVersion: CONSENT_VERSION })) } } })
  }
  beforeEach(async () => {
    vi.clearAllMocks(); fixture.queue.mockResolvedValue('fixture-job')
    fake = fakeGoogleContent(); googleProvider.request.mockImplementation(fake.request)
    fixture.env.GOOGLE_WORKSPACE_CALENDAR_ENABLED = true
    await prisma.googleConnection.deleteMany({ where: { organizationId: org.id } })
    await prisma.task.deleteMany({ where: { organizationId: org.id } })
    await prisma.lead.deleteMany({ where: { organizationId: org.id } })
    for (const [i, role] of ['owner', 'sales_rep', 'manager', 'viewer', 'admin'].entries()) await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: users[i].id } }, data: { role } })
    await prisma.googleWorkspaceSettings.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, calendarEnabled: true, sheetsEnabled: true, exportsEnabled: true }, update: { calendarEnabled: true, sheetsEnabled: true, exportsEnabled: true } })
    connection = await connect()
    lead = await prisma.lead.create({ data: { organizationId: org.id, displayName: '=SUM(A1:A2)', primaryEmail: 'lead@example.test', primaryPhoneE164: '+919876543210', budgetMinor: 12345n, ownerId: users[0].id, createdById: users[0].id } })
    expect((await call('/calendar/setup', { method: 'POST', body: {} })).status).toBe(200)
    fake.calls = []
  })
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (org) await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } })
    if (users) await prisma.user.deleteMany({ where: { id: { in: users.map((row) => row.id) } } })
    await prisma.$disconnect()
  })
  it('keeps viewer connection controls readable while denying content tools', async () => {
    expect((await call('/connections/me', { user: 3 })).status).toBe(200)
    expect((await call('/calendar', { user: 3 })).status).toBe(403)
    expect((await call('/sheets', { user: 3 })).status).toBe(403)
    expect(fake.calls).toHaveLength(0)
  })
  it('creates a lead meeting and CRM reminder atomically, with idempotent requests', async () => {
    const input = meetingInput({ leadId: lead.id })
    const first = await call('/calendar/events', { method: 'POST', body: input }), repeat = await call('/calendar/events', { method: 'POST', body: input })
    expect(first.status, JSON.stringify(first)).toBe(200); expect(repeat.data.id).toBe(first.data.id)
    expect(await prisma.task.count({ where: { organizationId: org.id } })).toBe(1)
    const task = await prisma.task.findUnique({ where: { id: first.data.taskId } })
    expect(task.entityId).toBe(lead.id); expect(task.type).toBe('meeting'); expect(task.dueAt.toISOString()).toBe('2027-03-14T04:30:00.000Z'); expect(+task.dueAt - +task.remindAt).toBe(900000)
    expect((await call('/calendar/events', { method: 'POST', body: { ...input, title: 'Changed payload' } })).status).toBe(409)
    expect(fake.calls).toHaveLength(0)
  })
  it('requires explicit guest consent and rejects invalid time zones and durations', async () => {
    for (const override of [{ attendees: ['guest@example.test'] }, { timeZone: 'Nowhere/Invalid' }, { endAt: '2027-03-14T09:00:00+05:30' }, { endAt: '2027-03-24T10:00:00+05:30' }]) expect((await call('/calendar/events', { method: 'POST', body: meetingInput(override) })).status).toBe(400)
    expect(await prisma.task.count({ where: { organizationId: org.id } })).toBe(0)
  })
  it('requires current per-service consent before creating tasks or spreadsheet jobs', async () => {
    await prisma.googleServiceConsent.updateMany({ where: { connectionId: connection.id }, data: { consentVersion: 'previous-release' } })
    expect((await call('/calendar/events', { method: 'POST', body: meetingInput() })).error.code).toBe('GOOGLE_CONSENT_REQUIRED')
    expect((await call('/sheets', { method: 'POST', body: sheetInput() })).error.code).toBe('GOOGLE_CONSENT_REQUIRED')
    expect(await prisma.task.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await prisma.googleSheet.count({ where: { organizationId: org.id } })).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
  it('creates one stable Google event and Meet link without inviting the lead automatically', async () => {
    const meeting = await createMeeting({ leadId: lead.id })
    await syncCalendarEvent(meeting.id); await syncCalendarEvent(meeting.id)
    expect(fake.events.size).toBe(1); expect(remoteEvent().attendees).toEqual([])
    expect(remoteEvent().conferenceData.createRequest.requestId).toBe(meeting.id)
    const row = await eventRow(meeting.id); expect(row.status).toBe('ready'); expect(row.meetUrl).toBe('https://meet.google.com/abc-defg-hij')
    expect(fake.calls.find((call) => call.method === 'POST').query).toEqual({ conferenceDataVersion: 1, sendUpdates: 'none' })
    const list = await call('/calendar/events?from=2027-03-01T00:00:00Z&to=2027-04-01T00:00:00Z')
    expect(list.data.items[0].meetUrl).toBe(row.meetUrl); expect(JSON.stringify(list)).not.toMatch(/credentialEnc|googleSubject|wrappedKey|fixture-refresh/)
  })
  it('sends invitations only to explicitly entered guests', async () => {
    const row = await createMeeting({ attendees: ['GUEST@example.test'], sendInvites: true })
    await syncCalendarEvent(row.id)
    expect(remoteEvent().attendees).toEqual([{ email: 'guest@example.test' }]); expect(fake.calls.find((call) => call.method === 'POST').query.sendUpdates).toBe('all')
  })
  it('reconciles an event committed by Google before a lost response without duplication', async () => {
    const row = await createMeeting()
    fake.after = ({ api, method }) => { if (api === 'calendar' && method === 'POST') throw googleError('GOOGLE_REMOTE_UNCERTAIN', 'Lost fixture response.') }
    await syncCalendarEvent(row.id); expect((await eventRow(row.id)).status).toBe('failed')
    fake.after = null; await syncCalendarEvent(row.id)
    expect(fake.events.size).toBe(1); expect((await eventRow(row.id)).status).toBe('ready')
  })
  it('updates the meeting and linked task with optimistic revision checks', async () => {
    const row = await createMeeting(); await syncCalendarEvent(row.id)
    const { requestId: _request, ...input } = meetingInput({ title: 'Revised meeting', revision: row.revision })
    expect((await call(`/calendar/events/${row.id}`, { method: 'PATCH', body: input })).status).toBe(200)
    expect((await call(`/calendar/events/${row.id}`, { method: 'PATCH', body: input })).status).toBe(409)
    await syncCalendarEvent(row.id)
    expect(remoteEvent().summary).toBe('Revised meeting'); expect((await prisma.task.findUnique({ where: { id: row.taskId } })).title).toBe('Revised meeting')
    expect(fake.calls.find((call) => call.method === 'PATCH').headers['If-Match']).toBeTruthy()
  })
  it('preserves edits made directly in Google Calendar as conflicts', async () => {
    const row = await createMeeting(); await syncCalendarEvent(row.id)
    remoteEvent().summary = 'External Google change'
    const { requestId: _request, ...input } = meetingInput({ title: 'CRM change', revision: 1 })
    await call(`/calendar/events/${row.id}`, { method: 'PATCH', body: input }); await syncCalendarEvent(row.id)
    expect((await eventRow(row.id)).status).toBe('conflict'); expect(remoteEvent().summary).toBe('External Google change')
  })
  it('cancels the Google event and CRM task, including guest updates', async () => {
    const row = await createMeeting({ attendees: ['guest@example.test'], sendInvites: true }); await syncCalendarEvent(row.id)
    expect((await call(`/calendar/events/${row.id}/cancel`, { method: 'POST' })).status).toBe(200)
    await syncCalendarEvent(row.id); expect(fake.events.size).toBe(0); expect((await eventRow(row.id)).status).toBe('cancelled')
    expect((await prisma.task.findUnique({ where: { id: row.taskId } })).status).toBe('cancelled')
    expect(fake.calls.find((call) => call.method === 'DELETE').query.sendUpdates).toBe('all')
  })
  it('never deletes an event whose ownership marker was changed', async () => {
    const row = await createMeeting(); await syncCalendarEvent(row.id); remoteEvent().extendedProperties.private.techsyncOperation = crypto.randomUUID()
    await call(`/calendar/events/${row.id}/cancel`, { method: 'POST' }); await syncCalendarEvent(row.id)
    expect(fake.events.size).toBe(1); expect((await eventRow(row.id)).status).toBe('conflict')
  })
  it('propagates task reassignment as cancellation without transferring Google credentials', async () => {
    const row = await createMeeting(); await syncCalendarEvent(row.id)
    await prisma.task.update({ where: { id: row.taskId }, data: { assigneeId: users[1].id } }); await syncCalendarEvent(row.id)
    expect(fake.events.size).toBe(0); expect((await eventRow(row.id)).status).toBe('cancelled')
  })
  it('reschedules after a task due time changes and keeps its meeting duration', async () => {
    const row = await createMeeting(); await syncCalendarEvent(row.id)
    await prisma.task.update({ where: { id: row.taskId }, data: { dueAt: new Date('2027-03-15T04:30:00Z') } }); await syncCalendarEvent(row.id); await syncCalendarEvent(row.id)
    expect(remoteEvent().start.dateTime).toBe('2027-03-15T04:30:00.000Z'); expect(remoteEvent().end.dateTime).toBe('2027-03-15T05:15:00.000Z')
  })
  it('fences queued meetings after reconnecting and rejects resources of another account', async () => {
    const row = await createMeeting()
    await prisma.googleConnection.update({ where: { id: connection.id }, data: { generation: { increment: 1 }, googleSubject: 'another-account' } })
    await syncCalendarEvent(row.id); expect((await eventRow(row.id)).status).toBe('paused'); expect(fake.calls).toHaveLength(0)
    expect((await call(`/calendar/events/${row.id}/cancel`, { method: 'POST' })).error.code).toBe('GOOGLE_ACCOUNT_CHANGED')
    expect((await call(`/calendar/events/${row.id}/retry`, { method: 'POST' })).error.code).toBe('GOOGLE_ACCOUNT_CHANGED')
  })
  it('prevents cross-tenant and cross-member access to meetings and sheets', async () => {
    const event = await createMeeting(), sheet = await createSheet(); await connect(1)
    expect((await call(`/calendar/events/${event.id}/cancel`, { user: 1, method: 'POST' })).status).toBe(404)
    expect((await call(`/sheets/${sheet.id}`, { user: 1 })).status).toBe(404)
    expect((await call(`/sheets/${sheet.id}`, { tenant: other.id })).status).toBe(403)
    expect(fake.calls).toHaveLength(0)
  })
  it('rechecks role and tenant flags before queued operations contact Google', async () => {
    const event = await createMeeting(), sheet = await createSheet()
    await prisma.membership.update({ where: { organizationId_userId: { organizationId: org.id, userId: users[0].id } }, data: { role: 'viewer' } })
    await syncCalendarEvent(event.id); await runGoogleSheet(sheet.id)
    expect((await eventRow(event.id)).status).toBe('paused'); expect((await sheetRow(sheet.id)).status).toBe('paused'); expect(fake.calls).toHaveLength(0)
  })
  it('creates one spreadsheet, preserves default tabs and edits RAW cells from the CRM', async () => {
    const input = sheetInput(), first = await call('/sheets', { method: 'POST', body: input }), repeated = await call('/sheets', { method: 'POST', body: input })
    expect(repeated.data.id).toBe(first.data.id); await runGoogleSheet(first.data.id); await runGoogleSheet(first.data.id)
    expect(fake.files.size).toBe(1)
    const row = await sheetRow(first.data.id), read = await call(`/sheets/${row.id}`)
    expect(read.data.editable).toBe(true); expect(read.data.sheet.url).toMatch(/^https:\/\/docs.google.com\/spreadsheets\//)
    const change = { row: 1, column: 1, previous: '', value: '=SUM(A2:A3)' }
    expect((await call(`/sheets/${row.id}/cells`, { method: 'PATCH', body: { changes: [change] } })).status).toBe(200)
    expect(fake.sheets.get(row.providerFileId).values[0][0]).toBe(change.value)
    expect(fake.calls.find((call) => call.path.endsWith('values:batchUpdate')).body.valueInputOption).toBe('RAW')
    expect(JSON.stringify(read)).not.toMatch(/credentialEnc|wrappedKey|googleSubject|fixture-refresh/)
  })
  it('rejects stale cell edits and never writes other cells', async () => {
    const row = await createSheet(); await runGoogleSheet(row.id)
    const file = fake.sheets.get((await sheetRow(row.id)).providerFileId); file.values = [['External edit', 'Untouched']]
    expect((await call(`/sheets/${row.id}/cells`, { method: 'PATCH', body: { changes: [{ row: 1, column: 1, previous: '', value: 'Overwrite' }] } })).error.code).toBe('GOOGLE_CELL_CONFLICT')
    expect(file.values).toEqual([['External edit', 'Untouched']])
  })
  it('bounds sheet reads and writes, rejects duplicate coordinates and excessive page spans', async () => {
    const row = await createSheet(); await runGoogleSheet(row.id)
    expect((await call(`/sheets/${row.id}?offset=1`)).status).toBe(400)
    expect((await call(`/sheets/${row.id}/cells`, { method: 'PATCH', body: { changes: [{ row: 1, column: 11, previous: '', value: '' }] } })).status).toBe(400)
    const change = { row: 1, column: 1, previous: '', value: 'A' }
    expect((await call(`/sheets/${row.id}/cells`, { method: 'PATCH', body: { changes: [change, change] } })).error.code).toBe('GOOGLE_DUPLICATE_CELL')
    expect((await call(`/sheets/${row.id}/cells`, { method: 'PATCH', body: { changes: [change, { ...change, row: 51 }] } })).status).toBe(400)
  })
  it('reconciles an uncertain Drive creation without a second file', async () => {
    const row = await createSheet()
    fake.after = ({ api, method }) => { if (api === 'drive' && method === 'POST') throw googleError('GOOGLE_REMOTE_UNCERTAIN', 'Lost response') }
    await runGoogleSheet(row.id); expect((await sheetRow(row.id)).status).toBe('unknown'); expect(fake.files.size).toBe(1)
    fake.after = null; await runGoogleSheet(row.id); expect((await sheetRow(row.id)).status).toBe('ready'); expect(fake.files.size).toBe(1)
  })
  it('does not repeat an uncertain file creation when reconciliation finds no file', async () => {
    const row = await createSheet(); await prisma.googleSheet.update({ where: { id: row.id }, data: { createAttempted: true } })
    await runGoogleSheet(row.id); expect((await sheetRow(row.id)).status).toBe('unknown'); expect(fake.files.size).toBe(0); expect(fake.calls.some((call) => call.method === 'POST')).toBe(false)
  })
  it('reconciles an addSheet response that was lost after Google committed it', async () => {
    const row = await createSheet()
    fake.after = ({ api, path }) => { if (api === 'sheets' && path.endsWith(':batchUpdate')) throw googleError('GOOGLE_REMOTE_UNCERTAIN', 'Lost tab response') }
    await runGoogleSheet(row.id)
    const saved = await sheetRow(row.id); expect(saved.status).toBe('ready'); expect(fake.sheets.get(saved.providerFileId).sheets).toHaveLength(1)
  })
  it('exports selected lead fields as RAW text with exact phones and monetary decimals', async () => {
    const row = await createSheet({ kind: 'leads', leadId: lead.id, columns: ['displayName', 'primaryPhoneE164', 'budgetMinor'] }); await runGoogleSheet(row.id)
    const saved = await sheetRow(row.id); expect(saved.status).toBe('ready'); expect(saved.rowCount).toBe(1)
    expect(fake.sheets.get(saved.providerFileId).values).toEqual([['Name', 'Phone', 'Budget'], ['=SUM(A1:A2)', '+919876543210', '123.45']])
    expect(fake.calls.find((call) => call.method === 'PUT').query.valueInputOption).toBe('RAW')
  })
  it('requires export permission and current tenant export enablement for queued copies', async () => {
    await connect(1)
    expect((await call('/sheets', { user: 1, method: 'POST', body: sheetInput({ kind: 'leads' }) })).status).toBe(403)
    const row = await createSheet({ kind: 'leads' })
    await prisma.googleWorkspaceSettings.update({ where: { organizationId: org.id }, data: { exportsEnabled: false } }); await runGoogleSheet(row.id)
    expect((await sheetRow(row.id)).status).toBe('paused'); expect(fake.calls).toHaveLength(0)
  })
  it('restricts manager exports to their managed team, including single-lead copies', async () => {
    await connect(2)
    expect((await call('/sheets', { user: 2, method: 'POST', body: sheetInput({ kind: 'leads', leadId: lead.id }) })).status).toBe(404)
    const empty = await call('/sheets', { user: 2, method: 'POST', body: sheetInput({ kind: 'leads' }) }); expect(empty.status).toBe(200)
    await runGoogleSheet(empty.data.id); expect((await sheetRow(empty.data.id)).rowCount).toBe(0)
  })
  it('serializes concurrent jobs so a spreadsheet is created once', async () => {
    const row = await createSheet(); await Promise.all([runGoogleSheet(row.id), runGoogleSheet(row.id)])
    expect(fake.files.size).toBe(1); expect((await sheetRow(row.id)).status).toBe('ready')
  })
  it('checks current lead visibility before reading its linked spreadsheet', async () => {
    await connect(1)
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: users[1].id } })
    const row = await call('/sheets', { user: 1, method: 'POST', body: sheetInput({ leadId: lead.id }) }); expect(row.status).toBe(200); await runGoogleSheet(row.data.id)
    await prisma.lead.update({ where: { id: lead.id }, data: { ownerId: users[0].id } }); fake.calls = []
    expect((await call(`/sheets/${row.data.id}`, { user: 1 })).status).toBe(404); expect(fake.calls).toHaveLength(0)
  })
  it('allows only matching marked calendars to recover uncertain calendar setup', async () => {
    const ctx = await currentContext(org.id, users[0].id), link = await prisma.googleCalendarLink.findFirst({ where: { organizationId: org.id } })
    await prisma.googleCalendarLink.update({ where: { id: link.id }, data: { status: 'unknown', providerCalendarId: null } })
    expect((await call('/calendar/setup', { method: 'POST', body: {} })).error.code).toBe('GOOGLE_CALENDAR_UNCERTAIN')
    const calendarId = [...fake.calendars.keys()][0]
    expect((await call('/calendar/setup', { method: 'POST', body: { calendarId } })).status).toBe(200)
    expect(ctx.userId).toBe(users[0].id); expect(fake.calendars.size).toBe(1)
  })
  it('polls an asynchronous Meet request without creating another conference', async () => {
    const row = await createMeeting()
    fake.after = ({ method, api, result }) => { if (api === 'calendar' && method === 'POST') { delete result.hangoutLink; result.conferenceData.createRequest.status = { statusCode: 'pending' } } }
    await syncCalendarEvent(row.id); expect((await eventRow(row.id)).meetStatus).toBe('pending')
    fake.after = null; remoteEvent().hangoutLink = 'https://meet.google.com/abc-defg-hij'
    await syncCalendarEvent(row.id); expect((await eventRow(row.id)).meetStatus).toBe('ready')
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })
  it('does not recreate a calendar after an uncertain successful insertion', async () => {
    await prisma.googleCalendarLink.deleteMany({ where: { organizationId: org.id } }); fake.calendars.clear()
    fake.after = ({ api, method }) => { if (api === 'calendar' && method === 'POST') throw googleError('GOOGLE_REMOTE_UNCERTAIN', 'Lost response', 503) }
    expect((await call('/calendar/setup', { method: 'POST', body: {} })).status).toBe(503)
    fake.after = null
    expect((await call('/calendar/setup', { method: 'POST', body: {} })).error.code).toBe('GOOGLE_CALENDAR_UNCERTAIN')
    expect(fake.calendars.size).toBe(1)
    expect((await call('/calendar/setup', { method: 'POST', body: { calendarId: [...fake.calendars.keys()][0] } })).status).toBe(200)
  })
  it('keeps task state intact when an edit or cancellation races an active sync', async () => {
    const row = await createMeeting()
    await prisma.googleCalendarEvent.update({ where: { id: row.id }, data: { leaseUntil: new Date(Date.now() + 60000), leaseToken: crypto.randomUUID() } })
    const { requestId: _request, ...input } = meetingInput({ title: 'Racing edit', revision: 1 })
    expect((await call(`/calendar/events/${row.id}`, { method: 'PATCH', body: input })).status).toBe(409)
    expect((await call(`/calendar/events/${row.id}/cancel`, { method: 'POST' })).status).toBe(409)
    const task = await prisma.task.findUnique({ where: { id: row.taskId } }); expect(task.title).toBe('Lead discussion'); expect(task.status).toBe('open')
  })
  it('allows the final header-plus-5000-lead row to be read', async () => {
    const row = await createSheet(); await runGoogleSheet(row.id)
    fake.sheets.get((await sheetRow(row.id)).providerFileId).values[5000] = ['Last lead']
    const page = await call(`/sheets/${row.id}?offset=5000`)
    expect(page.status).toBe(200); expect(page.data.values).toEqual([['Last lead']])
  })
  it('retries a definitively rejected file insertion without treating it as an uncertain creation', async () => {
    const row = await createSheet(), original = fake.request
    googleProvider.request.mockImplementationOnce(original).mockImplementationOnce(async () => { throw Object.assign(googleError('GOOGLE_RATE_LIMITED', 'Rate limited', 503), { providerStatus: 429 }) })
    await runGoogleSheet(row.id); expect((await sheetRow(row.id)).createAttempted).toBe(false)
    await runGoogleSheet(row.id); expect((await sheetRow(row.id)).status).toBe('ready'); expect(fake.files.size).toBe(1)
  })
})
