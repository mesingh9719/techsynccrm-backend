import { parse } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import { Open } from 'unzipper'
import { ApiError } from '../utils/ApiError.js'

export const MAX_IMPORT_ROWS = 50_000
const invalid = (message) => new ApiError(400, message, { code: 'INVALID_SPREADSHEET' })
export function decodeCsv(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('windows-1252').decode(bytes) }
}
const cellText = (v) => {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) throw invalid('Spreadsheet formulas are not imported. Paste their values first.')
    if (v.richText) return v.richText.map((x) => x.text).join('')
    if (v.text) return String(v.text)
    throw invalid('Unsupported cell value.')
  }
  return String(v)
}
export async function parseSpreadsheet(name, bytes, { sheetName, headerRow } = {}) {
  if (bytes.length > 25 * 1024 ** 2) throw invalid('The import limit is 25 MB.')
  let rows, sheets
  if (/\.xlsx$/i.test(name)) {
    // Check the ZIP directory before ExcelJS expands XML/shared strings.
    const zip = await Open.buffer(bytes)
    if (zip.files.length > 2000 || zip.files.reduce((n, f) => n + f.uncompressedSize, 0) > 100 * 1024 ** 2 || zip.files.some((f) => f.uncompressedSize > 50 * 1024 ** 2)) throw invalid('The expanded spreadsheet is too large.')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    sheets = workbook.worksheets.map((s) => s.name)
    const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0]
    if (!sheet) throw invalid('Choose an existing sheet.')
    if (sheet.rowCount > MAX_IMPORT_ROWS + 100 || sheet.columnCount > 200) throw invalid('Use at most 50,000 rows and 200 columns.')
    rows = []
    sheet.eachRow({ includeEmpty: true }, (row) => rows.push(Array.from({ length: sheet.columnCount }, (_, i) => cellText(row.getCell(i + 1).value))))
    sheetName = sheet.name
  } else if (/\.csv$/i.test(name)) {
    const text = decodeCsv(bytes)
    const first = text.split(/\r?\n/).find((r) => r.trim()) ?? ''
    const delimiter = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0]
    try { rows = parse(text, { bom: true, delimiter, relax_column_count: true, skip_empty_lines: true, max_record_size: 2_000_000, to: MAX_IMPORT_ROWS + 101 }) }
    catch { throw invalid('CSV could not be read. Check quoting and cell sizes.') }
    sheets = []
  } else throw invalid('Choose a CSV or XLSX file.')
  if (rows.some((r) => r.length > 200 || r.some((v) => v.length > 10_000))) throw invalid('Use at most 200 columns and 10,000 characters per cell.')
  const detected = rows.findIndex((r) => r.filter((v) => v.trim() && !/^[-+\d.,]+$/.test(v.trim())).length >= 2)
  const index = headerRow ? headerRow - 1 : Math.max(0, detected)
  if (!rows[index]) throw invalid('Choose a valid header row.')
  const headers = rows[index].map((h, i) => h.trim() || `Column ${i + 1}`)
  if (new Set(headers).size !== headers.length) throw invalid('Column headers must be unique.')
  const data = rows.slice(index + 1).filter((r) => r.some((v) => v.trim()))
  if (data.length > MAX_IMPORT_ROWS) throw invalid('Use at most 50,000 data rows.')
  return { sheets, sheetName: sheetName ?? null, headerRow: index + 1, headers, rows: data.map((r) => headers.map((_, i) => r[i] ?? '')) }
}
export function parseIndianMoney(value) {
  let s = String(value).trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '').replace(/,/g, '').trim()
  const suffix = s.match(/\s*(lakh|lakhs|l|crore|crores|cr)$/i)
  const multiplier = suffix ? (/^(l|lakh|lakhs)$/i.test(suffix[1]) ? 100_000 : 10_000_000) : 1
  if (suffix) s = s.slice(0, suffix.index).trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw invalid('Enter a non-negative money amount, such as ₹1,85,000 or 1.2 L.')
  const [whole, fraction = ''] = s.split('.')
  const n = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * BigInt(multiplier)
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('Money amount is too large.')
  return Number(n)
}
export function parseImportDate(value, format = 'DMY') {
  const s = String(value).trim()
  let y, m, d
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const serial = Number(s)
    if (serial < 1 || serial > 2958465 || Math.floor(serial) === 60) throw invalid('Invalid Excel date.')
    return new Date(Date.UTC(1899, 11, 31) + (Math.floor(serial) - (serial > 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10)
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) [y, m, d] = s.split('-').map(Number)
  else {
    const match = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
    if (!match) throw invalid('Enter a valid calendar date.')
    const [a, b, year] = match.slice(1).map(Number)
    ;[y, m, d] = format === 'MDY' ? [year, a, b] : [year, b, a]
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (y < 1900 || y > 9999 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw invalid('Enter a valid calendar date.')
  return date.toISOString().slice(0, 10)
}
const clean = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const SYNONYMS = { fullName: ['name', 'full name', 'customer name', 'contact name'], firstName: ['first name'], lastName: ['last name'], phone: ['mobile', 'phone', 'phone no', 'contact no', 'mobile number'], email: ['email', 'email id', 'email address'], companyName: ['firm', 'company', 'company name'], source: ['lead source', 'source'], owner: ['assigned to', 'owner', 'owner email'], valueMinor: ['amount', 'deal value', 'value'], budgetMinor: ['budget'], title: ['deal title', 'title'], city: ['city'], stateCode: ['state code', 'state'], pincode: ['pincode', 'pin'], stage: ['stage', 'deal stage'], pipeline: ['pipeline'], expectedCloseDate: ['close date', 'expected close date'], domain: ['domain'], gstin: ['gstin'], industry: ['industry'], website: ['website'], requirement: ['requirement', 'notes'] }
export function suggestMapping(headers, entityType, definitions = []) {
  const choices = Object.entries(SYNONYMS).flatMap(([key, values]) => values.map((s) => [clean(s), key]))
  for (const d of definitions) choices.push([clean(d.label), `cf.${d.key}`])
  return Object.fromEntries(headers.map((header) => {
    let key = choices.find(([s]) => s === clean(header))?.[1] ?? ''
    if (entityType === 'company' && ['companyName', 'fullName'].includes(key)) key = 'name'
    if (entityType === 'company' && key === 'phone') key = 'phone'
    if (entityType === 'lead' && key === 'valueMinor') key = 'budgetMinor'
    return [header, key]
  }))
}
export const safeCell = (v) => {
  const s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(s) ? `'${s}` : s
}
export async function writeSpreadsheet(headers, rows, format) {
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Records')
    sheet.addRow(headers.map(safeCell)); for (const row of rows) sheet.addRow(row.map(safeCell))
    return Buffer.from(await workbook.xlsx.writeBuffer())
  }
  const quote = (v) => `"${safeCell(v).replace(/"/g, '""')}"`
  return Buffer.from('\uFEFF' + [headers, ...rows].map((r) => r.map(quote).join(',')).join('\r\n'), 'utf8')
}
