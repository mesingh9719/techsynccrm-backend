// Synthetic Google APIs for integration/browser QA only. Production never imports this module.
import crypto from 'node:crypto'
import { googleError } from '../../src/integrations/google/config.js'

export function fakeGoogleContent() {
  const state = { calendars: new Map(), events: new Map(), files: new Map(), sheets: new Map(), calls: [], after: null }
  const missing = () => { throw googleError('GOOGLE_REMOTE_NOT_FOUND', 'Fixture resource not found.', 404) }
  const range = (value) => {
    const match = value.match(/!([A-J])(\d+)(?::([A-J])(\d+))?$/)
    if (!match) throw new Error(`Unsupported fixture range ${value}`)
    return { row: +match[2] - 1, col: match[1].charCodeAt(0) - 65, end: +(match[4] || match[2]) - 1, endCol: (match[3] || match[1]).charCodeAt(0) - 65 }
  }
  state.request = async (_token, api, path, options = {}) => {
    const method = options.method || 'GET', { body = {}, query = {}, headers = {} } = options
    state.calls.push({ api, path, method, body: structuredClone(body), query, headers })
    let result
    if (api === 'calendar') {
      if (path === 'calendars' && method === 'POST') {
        result = { ...body, id: `${crypto.randomUUID()}@group.calendar.google.com`, conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet'] } }
        state.calendars.set(result.id, result)
      } else {
        const parts = path.split('/').map(decodeURIComponent), calendar = state.calendars.get(parts[1])
        if (!calendar) missing()
        if (parts.length === 2) result = calendar
        else {
          const key = `${parts[1]}:${parts[3] || body.id}`, existing = state.events.get(key)
          if (method === 'POST') {
            if (existing) throw googleError('GOOGLE_REMOTE_EXISTS', 'Fixture event exists.')
            result = { ...body, etag: `"${crypto.randomUUID()}"`, ...(body.conferenceData && { hangoutLink: 'https://meet.google.com/abc-defg-hij' }) }
            state.events.set(key, result)
          } else if (!existing) missing()
          else if (method === 'GET') result = existing
          else {
            if (headers['If-Match'] !== existing.etag) throw googleError('GOOGLE_REMOTE_CONFLICT', 'Fixture version changed.')
            if (method === 'DELETE') { state.events.delete(key); result = {} }
            else { result = { ...existing, ...body, etag: `"${crypto.randomUUID()}"` }; state.events.set(key, result) }
          }
        }
      }
    } else if (api === 'drive') {
      if (method === 'GET') { const operation = query.q.match(/value='([^']+)'/)?.[1]; result = { files: [...state.files.values()].filter((file) => file.appProperties.techsyncOperation === operation) } }
      else { result = { ...body, id: `fixture_${crypto.randomUUID().replaceAll('-', '')}` }; state.files.set(result.id, result); state.sheets.set(result.id, { sheets: [], values: [] }) }
    } else if (api === 'sheets') {
      const parts = path.split('/'), fileId = parts[1].replace(':batchUpdate', ''), sheet = state.sheets.get(fileId)
      if (!sheet) missing()
      if (path.endsWith(':batchUpdate') && parts.length === 2) { sheet.sheets.push(...body.requests.map((request) => ({ properties: request.addSheet.properties }))); result = {} }
      else if (parts.length === 2) result = { sheets: sheet.sheets }
      else if (path.endsWith('values:batchUpdate')) {
        for (const cell of body.data) { const { row, col } = range(cell.range); sheet.values[row] ||= []; sheet.values[row][col] = cell.values[0][0] }
        result = {}
      } else if (path.endsWith(':clear')) { sheet.values = []; result = {} }
      else {
        const bounds = range(decodeURIComponent(parts.slice(3).join('/')))
        if (method === 'PUT') { body.values.forEach((row, index) => { sheet.values[bounds.row + index] = [...row] }); result = {} }
        else result = { values: Array.from({ length: bounds.end - bounds.row + 1 }, (_, i) => (sheet.values[bounds.row + i] || []).slice(bounds.col, bounds.endCol + 1)) }
      }
    } else throw new Error(`Unexpected fixture API ${api}`)
    if (state.after) await state.after({ api, path, method, body, result })
    return structuredClone(result)
  }
  return state
}
