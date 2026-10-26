import crypto from 'node:crypto'
import { prisma } from '../../db/prisma.js'
import { googleError, fingerprint } from './config.js'
import { currentContext, auditGoogle } from './access.js'
import { ownResourceContext, resourceRequest, requireExport, providerId, sheetUrl, retryAt, safeCode } from './resourceAccess.js'
import { loadRecord } from '../../services/recordRef.service.js'
import { visibilityWhere } from '../../lib/visibility.js'
import { googleLeadRows } from '../../services/transfer.service.js'
import { enqueue } from '../../jobs/queue.js'

const dto = (row) => ({ id: row.id, title: row.title, kind: row.kind, leadId: row.leadId, status: row.status, rowCount: row.rowCount, lastError: row.lastError, createdAt: row.createdAt, updatedAt: row.updatedAt, url: sheetUrl(row.providerFileId) })
const kick = (id) => enqueue('google.sheets.create', { id }).catch(() => {})
const quote = (title) => `'${title.replaceAll("'", "''")}'`
const filePath = (row) => `spreadsheets/${row.providerFileId}`
async function ownSheet(ctx, id) {
  const row = await prisma.googleSheet.findFirst({ where: { id, organizationId: ctx.orgId, connection: { userId: ctx.userId } }, include: { connection: true } })
  if (!row) throw googleError('GOOGLE_SHEET_NOT_FOUND', 'Spreadsheet not found.', 404)
  if (row.leadId) await loadRecord(ctx, 'lead', row.leadId)
  if (row.googleSubject !== row.connection.googleSubject || row.projectNumber !== row.connection.projectNumber) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'This spreadsheet belongs to a previous Google account. Open it with that account in Google Sheets.')
  return row
}
export async function listGoogleSheets(ctx, { leadId, page = 1, q, kind, status }) {
  const { connection } = await ownResourceContext(ctx, 'sheets')
  if (leadId) await loadRecord(ctx, 'lead', leadId)
  const where = { organizationId: ctx.orgId, connectionId: connection.id, googleSubject: connection.googleSubject, projectNumber: connection.projectNumber, ...(leadId && { leadId }), ...(q && { title: { contains: q, mode: 'insensitive' } }), ...(kind && { kind }), ...(status && { status }), OR: [{ leadId: null }, { lead: { is: { AND: [{ deletedAt: null }, visibilityWhere(ctx, 'leads')] } } }] }
  const [total, items] = await Promise.all([prisma.googleSheet.count({ where }), prisma.googleSheet.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25, skip: (page - 1) * 25 })])
  return { items: items.map(dto), total, page, pageSize: 25 }
}
export async function createGoogleSheet(ctx, input) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'sheets')
  if (input.leadId) await loadRecord(fresh, 'lead', input.leadId)
  if (input.kind === 'leads') { await requireExport(fresh); await googleLeadRows(fresh, input) }
  const source = { filters: input.filters, columns: input.columns, ...(input.leadId && { leadId: input.leadId }) }
  const hash = fingerprint(JSON.stringify({ title: input.title, kind: input.kind, source }))
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM memberships WHERE organization_id = ${ctx.orgId}::uuid AND user_id = ${ctx.userId}::uuid FOR UPDATE`
    await currentContext(ctx.orgId, ctx.userId, tx)
    const key = { organizationId: ctx.orgId, connectionId: connection.id, requestId: input.requestId }
    const existing = await tx.googleSheet.findUnique({ where: { organizationId_connectionId_requestId: key } })
    if (existing) { if (existing.requestHash !== hash) throw googleError('GOOGLE_REQUEST_CHANGED', 'This request was already used for a different spreadsheet.'); return existing }
    const result = await tx.googleSheet.create({ data: { ...key, requestHash: hash, googleSubject: connection.googleSubject, projectNumber: connection.projectNumber, connectionGeneration: connection.generation,
      leadId: input.leadId || null, title: input.title, kind: input.kind, source, sheetId: crypto.randomInt(1, 2147483647) } })
    await auditGoogle(tx, ctx, input.kind === 'leads' ? 'sheet_export_queued' : 'sheet_create_queued', { connectionId: connection.id, service: 'sheets', status: 'pending' })
    return result
  })
  await kick(row.id); return dto(row)
}
export async function retryGoogleSheet(ctx, id) {
  const { ctx: fresh, connection } = await ownResourceContext(ctx, 'sheets'), row = await ownSheet(fresh, id)
  if (row.kind === 'leads') await requireExport(fresh)
  if (row.status === 'ready') return dto(row)
  const changed = await prisma.googleSheet.updateMany({ where: { id, organizationId: ctx.orgId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { status: 'queued', connectionGeneration: connection.generation, nextAttemptAt: new Date(), attempts: 0, lastError: null } })
  if (!changed.count) throw googleError('GOOGLE_OPERATION_BUSY', 'Spreadsheet work is already running. Try again shortly.')
  const updated = await prisma.googleSheet.findUnique({ where: { id, organizationId: ctx.orgId } })
  await kick(id); return dto(updated)
}
async function managedTab(ctx, row, connection) {
  const metadata = await resourceRequest(ctx, connection, 'sheets', 'sheets', filePath(row), { query: { fields: 'sheets.properties' } })
  const tab = metadata.sheets?.find((sheet) => sheet.properties?.sheetId === row.sheetId)?.properties
  if (!tab) throw googleError('GOOGLE_TAB_MISSING', 'The CRM tab was removed from Google Sheets. Open the spreadsheet to review it.')
  return tab
}
export async function readGoogleSheet(ctx, id, offset = 0) {
  const { connection } = await ownResourceContext(ctx, 'sheets'), row = await ownSheet(ctx, id)
  if (row.status !== 'ready' || !providerId(row.providerFileId)) return { sheet: dto(row), values: [], offset, editable: false }
  const tab = await managedTab(ctx, row, connection)
  const range = `${quote(tab.title)}!A${offset + 1}:J${Math.min(5001, offset + 50)}`
  const data = await resourceRequest(ctx, connection, 'sheets', 'sheets', `${filePath(row)}/values/${encodeURIComponent(range)}`, { query: { valueRenderOption: 'FORMULA' } })
  return { sheet: dto(row), values: (data.values || []).map((values) => values.map((value) => String(value ?? ''))), offset, editable: true, tabTitle: tab.title }
}
export async function editGoogleSheet(ctx, id, changes) {
  const { connection } = await ownResourceContext(ctx, 'sheets'), row = await ownSheet(ctx, id)
  if (row.status !== 'ready') throw googleError('GOOGLE_SHEET_NOT_READY', 'Wait for spreadsheet creation to finish.')
  const leaseToken = crypto.randomUUID(), now = new Date()
  if (!(await prisma.googleSheet.updateMany({ where: { id, organizationId: ctx.orgId, status: 'ready', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken, leaseUntil: new Date(Date.now() + 90000) } })).count) throw googleError('GOOGLE_OPERATION_BUSY', 'This spreadsheet is being saved. Try again shortly.')
  try {
    const tab = await managedTab(ctx, row, connection), minimum = Math.min(...changes.map((c) => c.row)), maximum = Math.max(...changes.map((c) => c.row))
    if (maximum - minimum >= 50) throw googleError('GOOGLE_RANGE_TOO_LARGE', 'Save one page of spreadsheet changes at a time.', 400)
    const range = `${quote(tab.title)}!A${minimum}:J${maximum}`
    const existing = await resourceRequest(ctx, connection, 'sheets', 'sheets', `${filePath(row)}/values/${encodeURIComponent(range)}`, { query: { valueRenderOption: 'FORMULA' } })
    const keys = new Set()
    for (const change of changes) {
      const key = `${change.row}:${change.column}`
      if (keys.has(key)) throw googleError('GOOGLE_DUPLICATE_CELL', 'A cell can only be edited once in a save.', 400)
      keys.add(key)
      if (String(existing.values?.[change.row - minimum]?.[change.column - 1] ?? '') !== change.previous) throw googleError('GOOGLE_CELL_CONFLICT', 'Some cells changed in Google Sheets. Refresh this page before saving your edits.')
    }
    await resourceRequest(ctx, connection, 'sheets', 'sheets', `${filePath(row)}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'RAW', data: changes.map((change) => ({ range: `${quote(tab.title)}!${String.fromCharCode(64 + change.column)}${change.row}`, values: [[change.value]] })) } })
    await auditGoogle(prisma, ctx, 'sheet_cells_saved', { connectionId: connection.id, service: 'sheets' })
    return { saved: changes.length }
  } finally { await prisma.googleSheet.updateMany({ where: { id, organizationId: ctx.orgId, leaseToken }, data: { leaseToken: null, leaseUntil: null } }) }
}
export async function runGoogleSheet(id) {
  let row = await prisma.googleSheet.findUnique({ where: { id }, include: { connection: true } })
  if (!row || !['queued', 'failed', 'unknown'].includes(row.status)) return
  const leaseToken = crypto.randomUUID(), now = new Date()
  if (!(await prisma.googleSheet.updateMany({ where: { id, status: { in: ['queued', 'failed', 'unknown'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken, leaseUntil: new Date(Date.now() + 90000) } })).count) return
  const update = (data) => prisma.googleSheet.updateMany({ where: { id, organizationId: row.organizationId, leaseToken }, data })
  try {
    const ctx = await currentContext(row.organizationId, row.connection.userId), connection = { ...row.connection, generation: row.connectionGeneration }
    if (row.googleSubject !== connection.googleSubject || row.projectNumber !== connection.projectNumber) throw googleError('GOOGLE_ACCOUNT_CHANGED', 'Google account changed. Create a spreadsheet with the current account.')
    if (row.leadId) await loadRecord(ctx, 'lead', row.leadId)
    if (row.kind === 'leads') await requireExport(ctx)
    const values = row.kind === 'leads' ? await googleLeadRows(ctx, row.source) : []
    const request = async (api, path, options) => {
      if (!(await update({ leaseUntil: new Date(Date.now() + 90000) })).count) throw googleError('GOOGLE_OPERATION_BUSY', 'Spreadsheet operation changed.')
      const fresh = await currentContext(ctx.orgId, ctx.userId)
      if (row.leadId) await loadRecord(fresh, 'lead', row.leadId)
      if (row.kind === 'leads') await requireExport(fresh)
      return resourceRequest(fresh, connection, 'sheets', api, path, options)
    }
    if (!row.providerFileId) {
      const found = await request('drive', 'files', { query: { q: `trashed = false and appProperties has { key='techsyncOperation' and value='${row.id}' }`, fields: 'files(id,mimeType)', pageSize: 10 } })
      if (found.files?.length > 1) throw googleError('GOOGLE_CREATE_UNCERTAIN', 'Multiple spreadsheet results need review in Google Drive.')
      let file = found.files?.[0]
      if (!file && row.createAttempted) { await update({ status: 'unknown', lastError: 'GOOGLE_CREATE_UNCERTAIN', nextAttemptAt: new Date(Date.now() + 15 * 60000) }); return }
      if (!file) {
        await update({ createAttempted: true })
        row.createAttempted = true
        try {
          file = await request('drive', 'files', { method: 'POST', query: { fields: 'id,mimeType' }, body: { name: row.title, mimeType: 'application/vnd.google-apps.spreadsheet', appProperties: { techsyncOperation: row.id, techsyncWorkspace: row.organizationId } } })
        } catch (error) {
          if (error.providerStatus && error.providerStatus < 500) { await update({ createAttempted: false }); row.createAttempted = false }
          throw error
        }
      }
      if (!providerId(file?.id) || file.mimeType !== 'application/vnd.google-apps.spreadsheet') throw googleError('GOOGLE_CREATE_UNCERTAIN', 'Google did not confirm a spreadsheet.', 503)
      await update({ providerFileId: file.id }); row.providerFileId = file.id
    }
    const metadata = await request('sheets', filePath(row), { query: { fields: 'sheets.properties' } })
    let tab = metadata.sheets?.find((sheet) => sheet.properties?.sheetId === row.sheetId)?.properties
    if (!tab) {
      try { await request('sheets', `${filePath(row)}:batchUpdate`, { method: 'POST', body: { requests: [{ addSheet: { properties: { sheetId: row.sheetId, title: `CRM Data`, gridProperties: { rowCount: 5001, columnCount: 10, frozenRowCount: row.kind === 'leads' ? 1 : 0 } } } }] } }) }
      catch (error) {
        // A lost addSheet response is reconciled by its deterministic numeric sheetId.
        const check = await request('sheets', filePath(row), { query: { fields: 'sheets.properties' } })
        tab = check.sheets?.find((sheet) => sheet.properties?.sheetId === row.sheetId)?.properties
        if (!tab) throw error
      }
      tab ||= { sheetId: row.sheetId, title: 'CRM Data' }
    }
    if (values.length) {
      const fresh = await currentContext(ctx.orgId, ctx.userId), latest = await googleLeadRows(fresh, row.source)
      if (fingerprint(JSON.stringify(latest)) !== fingerprint(JSON.stringify(values))) throw googleError('GOOGLE_SOURCE_CHANGED', 'Lead data or access changed while exporting. Review and retry the export.')
      // Only this app-owned tab is cleared while an export is pending; other tabs are untouched.
      await request('sheets', `${filePath(row)}/values/${encodeURIComponent(`${quote(tab.title)}!A1:J5001`)}:clear`, { method: 'POST', body: {} })
      await request('sheets', `${filePath(row)}/values/${encodeURIComponent(`${quote(tab.title)}!A1`)}`, { method: 'PUT', query: { valueInputOption: 'RAW' }, body: { values } })
    }
    await update({ status: 'ready', rowCount: Math.max(0, values.length - 1), lastError: null, attempts: 0 })
    await auditGoogle(prisma, { orgId: row.organizationId, userId: row.connection.userId }, row.kind === 'leads' ? 'sheet_export_completed' : 'sheet_created', { connectionId: row.connectionId, service: 'sheets' })
  } catch (error) {
    const code = safeCode(error), paused = ['GOOGLE_ACCOUNT_CHANGED', 'GOOGLE_ACCESS_DENIED', 'GOOGLE_EXPORT_DISABLED', 'GOOGLE_SOURCE_CHANGED', 'GOOGLE_RECONNECT_REQUIRED', 'GOOGLE_CONSENT_REQUIRED', 'GOOGLE_TENANT_DISABLED', 'GOOGLE_SERVICE_DISABLED'].includes(code)
    await update({ status: paused ? 'paused' : row.createAttempted && !row.providerFileId ? 'unknown' : 'failed', lastError: code, attempts: { increment: 1 }, nextAttemptAt: retryAt(row.attempts) })
  } finally { await prisma.googleSheet.updateMany({ where: { id, organizationId: row.organizationId, leaseToken }, data: { leaseToken: null, leaseUntil: null } }) }
}
export async function recoverGoogleSheets() {
  const rows = await prisma.googleSheet.findMany({ where: { status: { in: ['queued', 'failed', 'unknown'] }, nextAttemptAt: { lte: new Date() } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 25, select: { id: true } })
  for (const row of rows) await runGoogleSheet(row.id)
}
