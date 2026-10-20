import { applyOverlay, emptyOverlay, overlayStats } from './importCore.js'
import { ApiError } from '../utils/ApiError.js'

const invalid = (message) => new ApiError(400, message, { code: 'VALIDATION_ERROR' })
export function mergeEditBatch(original, batch, parsed, job) {
  if (!batch) return original ?? emptyOverlay()
  const overlay = batch.reset ? emptyOverlay() : structuredClone(original ?? emptyOverlay())
  const ids = new Set([...parsed.sourceRows.map((row) => row.id), ...overlay.addedRows.map((row) => row.id)])
  for (const row of batch.addedRows ?? []) {
    if (ids.has(row.id)) throw invalid('This added row already exists. Refresh the draft.')
    if (row.values.length > parsed.columnCount) throw invalid('An added row has too many columns.')
    overlay.addedRows.push(row); ids.add(row.id)
  }
  const firstData = job.headerRow + (job.hasHeader === false ? 0 : 1)
  const valid = (id) => {
    if (!ids.has(id)) throw invalid('An edited row no longer exists. Reload the sheet.')
    if (id.startsWith('r:') && Number(id.slice(2)) < firstData) throw invalid('Header and introductory rows cannot be edited. Change the header selection instead.')
  }
  for (const { rowId, column, value } of batch.cells ?? []) {
    valid(rowId)
    if (column >= parsed.columnCount) throw invalid('An edited column no longer exists.')
    const changes = { ...overlay.cells[rowId] }
    if (value === null) delete changes[column]
    else changes[column] = value
    if (Object.keys(changes).length) overlay.cells[rowId] = changes
    else delete overlay.cells[rowId]
  }
  const removed = new Set(overlay.deletedRows)
  for (const { rowId, deleted } of batch.deletedRows ?? []) { valid(rowId); if (deleted) removed.add(rowId); else removed.delete(rowId) }
  overlay.deletedRows = [...removed]
  const stats = overlayStats(overlay)
  if (stats.editedCells > 20000 || stats.addedRows > 5000 || stats.removedRows > 50000 || Buffer.byteLength(JSON.stringify(overlay)) > 8 * 1024 ** 2) throw invalid('This draft exceeds the edit limit (20,000 cells, 5,000 added rows, or 8 MB of edits). Split it into smaller imports.')
  return overlay
}
export function editedDataset(parsed, edits) {
  const dataStart = parsed.headerRow + (parsed.hasHeader ? 1 : 0)
  const effective = applyOverlay(parsed.sourceRows, edits).filter((row) => (row.sourceRow === null || row.sourceRow >= dataStart) && row.values.some((value) => value.trim()))
  if (effective.length > 50000) throw invalid('Use at most 50,000 data rows after edits.')
  return { ...parsed, rows: effective.map((row) => row.values), rowIds: effective.map((row) => row.id), sourceNumbers: effective.map((row) => row.sourceRow) }
}
export function sourceIssues(parsed, job, rowId) {
  return (parsed.issueRows?.get(rowId) ?? Object.entries(parsed.cellIssues).filter(([key]) => key.startsWith(`${rowId}:`))).flatMap(([key, issue]) => {
    const column = Number(key.slice(key.lastIndexOf(':') + 1))
    if (issue.onlyFields && !issue.onlyFields.includes(job.mapping[parsed.headers[column]])) return []
    if (job.edits?.cells?.[rowId]?.[column] !== undefined || !job.mapping[parsed.headers[column]]) return []
    return [{ ...issue, column, field: job.mapping[parsed.headers[column]] }]
  })
}
