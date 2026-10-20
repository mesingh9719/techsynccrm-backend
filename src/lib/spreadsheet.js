import { parse } from 'csv-parse/sync'
import ExcelJS from 'exceljs'
import { Open } from 'unzipper'
import { parseIndianMoney as coreMoney, parseImportDate as coreDate } from './importCore.js'
import { ApiError } from '../utils/ApiError.js'

export const MAX_IMPORT_ROWS = 50_000
const invalid = (message) => new ApiError(400, message, { code: 'INVALID_SPREADSHEET' })
const clean = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const SYNONYMS = { fullName: ['name', 'full name', 'customer name', 'contact name'], firstName: ['first name'], lastName: ['last name'], phone: ['mobile', 'phone', 'phone no', 'contact no', 'mobile number'], email: ['email', 'email id', 'email address'], companyName: ['firm', 'company', 'company name'], source: ['lead source', 'source'], owner: ['assigned to', 'owner', 'owner email'], valueMinor: ['amount', 'deal value', 'value'], budgetMinor: ['budget'], title: ['deal title', 'title'], city: ['city'], stateCode: ['state code', 'state'], pincode: ['pincode', 'pin'], stage: ['stage', 'deal stage'], pipeline: ['pipeline'], expectedCloseDate: ['close date', 'expected close date'], domain: ['domain'], gstin: ['gstin'], industry: ['industry'], website: ['website'], requirement: ['requirement', 'notes'], tags: ['tag', 'tags', 'labels'] }
const HEADER_NAMES = new Set(Object.entries(SYNONYMS).flatMap(([key, names]) => [key, ...names].map(clean)))

// Inspect a bounded sample. Known column names and consistent following rows outrank report titles.
function detectHeader(rows) {
  const sample = rows.slice(0, 100)
  const hasMultipleColumns = sample.some((row) => row.filter((value) => value.trim()).length > 1)
  let best = { index: 0, score: -1 }
  for (const [index, row] of sample.entries()) {
    const values = row.map((value) => value.trim()).filter(Boolean)
    if (!values.length || (hasMultipleColumns && values.length < 2)) continue
    const known = values.filter((value) => HEADER_NAMES.has(clean(value))).length
    const text = values.filter((value) => !/@|^[-+\d.,/\s]+$/.test(value)).length
    const following = rows.slice(index + 1, index + 6).filter((value) => value.some((cell) => cell.trim()))
    const consistent = following.filter((value) => value.filter((cell) => cell.trim()).length === values.length).length
    const score = known * 30 + Math.min(values.length, 10) + (text === values.length ? 10 : 0) + (following.length ? consistent / following.length * 12 : 0)
    if (score > best.score) best = { index, score }
  }
  return best
}

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
export async function parseSpreadsheet(name, bytes, { sheetName, headerRow, hasHeader = true } = {}) {
  if (bytes.length > 25 * 1024 ** 2) throw invalid('The import limit is 25 MB.')
  let rows, sheets
  const cellIssues = {}
  if (/\.xlsx$/i.test(name)) {
    // Check the ZIP directory before ExcelJS expands XML/shared strings.
    const zip = await Open.buffer(bytes)
    if (zip.files.length > 2000 || zip.files.reduce((n, f) => n + f.uncompressedSize, 0) > 100 * 1024 ** 2 || zip.files.some((f) => f.uncompressedSize > 50 * 1024 ** 2)) throw invalid('The expanded spreadsheet is too large.')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes)
    sheets = workbook.worksheets.map((s) => s.name)
    const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets
      .map((candidate) => {
        const sample = Array.from({ length: Math.min(candidate.rowCount, 105) }, (_, index) => Array.from({ length: Math.min(candidate.columnCount, 200) }, (_, column) => {
          const value = candidate.getRow(index + 1).getCell(column + 1).value
          // Selection only: formulas in the chosen sheet are rejected when reading below.
          return value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value) ? '' : cellText(value)
        }))
        const detected = detectHeader(sample)
        const hasData = sample.slice(detected.index + 1).some((row) => row.some((value) => value.trim()))
        return { sheet: candidate, hasData, score: detected.score }
      })
      .sort((a, b) => Number(b.hasData) - Number(a.hasData) || b.score - a.score)[0]?.sheet
    if (!sheet) throw invalid('Choose an existing sheet.')
    if (sheet.rowCount > MAX_IMPORT_ROWS + 100 || sheet.columnCount > 200) throw invalid('Use at most 50,000 rows and 200 columns.')
    rows = []
    for (let number = 1; number <= sheet.rowCount; number++) {
      rows.push(Array.from({ length: sheet.columnCount }, (_, i) => {
        const cell = sheet.getRow(number).getCell(i + 1)
        const address = `r:${number}:${i}`
        if (cell.isMerged && cell.master.address !== cell.address) { cellIssues[address] = { severity: 'warning', message: `Merged with ${cell.master.address}; only the anchor value is imported.` }; return '' }
        let value = cell.value
        if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
          if (value.result === undefined || value.result === null || typeof value.result === 'object' && !(value.result instanceof Date)) { cellIssues[address] = { severity: 'error', message: 'Formula has no usable cached value. Enter a value or recalculate and save the workbook.' }; return '' }
          value = value.result
        }
        if (typeof value === 'number') {
          if (/^0+$/.test(cell.numFmt || '') && Number.isInteger(value) && value >= 0) return String(value).padStart(cell.numFmt.length, '0')
          cellIssues[address] = { severity: 'warning', onlyFields: ['phone', 'pincode', 'gstin'], message: 'Excel stored this cell as a number. Check for missing leading zeros; digits already removed by Excel cannot be recovered.' }
          if (!Number.isSafeInteger(value) && Number.isInteger(value)) cellIssues[address] = { severity: 'warning', message: 'Excel may have rounded this long number. Check it against your source.' }
        }
        try { return cellText(value) }
        catch { cellIssues[address] = { severity: 'error', message: 'Unsupported Excel cell value. Enter plain text to replace it.' }; return '' }
      }))
    }
    sheetName = sheet.name
  } else if (/\.csv$/i.test(name)) {
    const text = decodeCsv(bytes)
    const options = { bom: true, relax_column_count: true, skip_empty_lines: false, max_record_size: 2_000_000 }
    const delimiters = [',', ';', '\t'].map((delimiter) => {
      try { return { delimiter, score: detectHeader(parse(text, { ...options, delimiter, to: 105 })).score } }
      catch { return { delimiter, score: -1 } }
    }).sort((a, b) => b.score - a.score)
    try { rows = parse(text, { ...options, delimiter: delimiters[0].delimiter, to: MAX_IMPORT_ROWS + 101 }) }
    catch { throw invalid('CSV could not be read. Check quoting and cell sizes.') }
    // Never silently truncate a file when the parsing limit is reached.
    if (rows.length > MAX_IMPORT_ROWS + 100) throw invalid('Use at most 50,000 data rows and 100 header rows.')
    sheets = []
  } else throw invalid('Choose a CSV or XLSX file.')
  if (rows.some((r) => r.length > 200 || r.some((v) => v.length > 10_000))) throw invalid('Use at most 200 columns and 10,000 characters per cell.')
  if (!rows.length || !rows.some((row) => row.some((value) => value.trim()))) throw invalid('This worksheet is empty. Choose a sheet with data.')
  const index = headerRow ? headerRow - 1 : hasHeader ? detectHeader(rows).index : 0
  if (!rows[index]) throw invalid('Choose a valid header row.')
  const columnCount = Math.max(...rows.map((row) => row.length), 1)
  const used = new Set()
  const originalHeaders = Array.from({ length: columnCount }, (_, i) => hasHeader ? rows[index][i]?.trim() || `Column ${i + 1}` : `Column ${i + 1}`)
  const headers = originalHeaders.map((value, i) => {
    let key = value
    while (used.has(key)) key = `${value} (${i + 1})${used.has(`${value} (${i + 1})`) ? ' ' + used.size : ''}`
    used.add(key)
    return key
  })
  const sourceRows = rows.map((values, i) => ({ id: `r:${i + 1}`, sourceRow: i + 1, values: Array.from({ length: columnCount }, (_, column) => values[column] ?? '') }))
  const data = sourceRows.slice(index + (hasHeader ? 1 : 0)).filter((row) => row.values.some((value) => value.trim()))
  if (data.length > MAX_IMPORT_ROWS) throw invalid('Use at most 50,000 data rows.')
  return { sheets, sheetName: sheetName ?? null, headerRow: index + 1, hasHeader, headers, originalHeaders, columnCount, sourceRows, cellIssues, rowIds: data.map((row) => row.id), sourceNumbers: data.map((row) => row.sourceRow), rows: data.map((row) => row.values) }
}

export function parseIndianMoney(value) { try { return coreMoney(value) } catch (error) { throw invalid(error.message) } }
export function parseImportDate(value, format = 'DMY') { try { return coreDate(value, format) } catch (error) { throw invalid(error.message) } }
export function suggestMapping(headers, entityType, definitions = [], allowedFields) {
  const choices = Object.entries(SYNONYMS).flatMap(([key, values]) => values.map((s) => [clean(s), key]))
  for (const d of definitions.filter((definition) => !definition.entityType || definition.entityType === entityType)) choices.push([clean(d.label), `cf.${d.key}`])
  const used = new Set()
  return Object.fromEntries(headers.map((header) => {
    let key = choices.find(([s]) => s === clean(header))?.[1] ?? ''
    if (entityType === 'company' && ['companyName', 'fullName'].includes(key)) key = 'name'
    if (entityType === 'deal' && key === 'fullName') key = 'title'
    if (entityType === 'lead' && key === 'valueMinor') key = 'budgetMinor'
    if ((allowedFields && key && !key.startsWith('cf.') && !allowedFields.includes(key)) || used.has(key)) key = ''
    if (key) used.add(key)
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
