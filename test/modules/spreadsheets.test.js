import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { decodeCsv, parseImportDate, parseIndianMoney, parseSpreadsheet, safeCell, suggestMapping, writeSpreadsheet } from '../../src/lib/spreadsheet.js'
import { sniffFile, downloadDisposition, assertFileSize } from '../../src/lib/fileSafety.js'

describe('spreadsheet input and output', () => {
  it.each([['₹1,85,000', 18500000], ['Rs. 1,000.50', 100050], ['1.2 L', 12000000], ['2 Cr', 2000000000], ['0.01', 1]])('parses %s to exact minor units', (s, n) => expect(parseIndianMoney(s)).toBe(n))
  it.each(['-1', '100garbage', '1.234', '9999999999999999999999999'])('rejects malformed or unsafe money %s', (s) => expect(() => parseIndianMoney(s)).toThrow())
  it('parses Indian/ISO/Excel dates with explicit ambiguity and calendar validation', () => {
    expect(parseImportDate('31/03/2026')).toBe('2026-03-31')
    expect(parseImportDate('03/04/2026', 'MDY')).toBe('2026-03-04')
    expect(parseImportDate('2026-10-20')).toBe('2026-10-20')
    expect(parseImportDate('25569')).toBe('1970-01-01')
    for (const s of ['31/02/2026', '60', '0', '13/31/2026']) expect(() => parseImportDate(s)).toThrow()
  })
  it('handles UTF-8 Hindi, UTF-16 BOM and Windows-1252 without corrupting names', async () => {
    const utf8 = Buffer.from('Name,City\nआशा,दिल्ली\n')
    expect((await parseSpreadsheet('input.csv', utf8)).rows[0][0]).toBe('आशा')
    expect(decodeCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name,City\nAsha,Delhi', 'utf16le')]))).toContain('Asha,Delhi')
    expect(decodeCsv(Buffer.from([0x4a, 0x6f, 0x73, 0xe9]))).toBe('José')
  })
  it('detects headers, semicolon delimiter and maps common synonyms', async () => {
    const parsed = await parseSpreadsheet('input.csv', Buffer.from('Mobile;Customer Name;Email ID;Firm;Deal Value\n9876543210;Asha Sharma;a@example.test;Saffron;1.2 L'))
    expect(suggestMapping(parsed.headers, 'lead')).toEqual({ Mobile: 'phone', 'Customer Name': 'fullName', 'Email ID': 'email', Firm: 'companyName', 'Deal Value': 'budgetMinor' })
    expect(suggestMapping(['Sector'], 'lead', [{ label: 'Sector', key: 'sector' }])).toEqual({ Sector: 'cf.sector' })
  })
  it('reads XLSX sheet/header overrides and refuses formulas', async () => {
    const book = new ExcelJS.Workbook(), a = book.addWorksheet('Empty'), b = book.addWorksheet('Customers')
    a.addRow(['Notes']); b.addRow(['Customer Name', 'Email']); b.addRow(['Asha', 'a@example.test'])
    let bytes = Buffer.from(await book.xlsx.writeBuffer())
    expect((await parseSpreadsheet('input.xlsx', bytes, { sheetName: 'Customers' })).rows).toEqual([['Asha', 'a@example.test']])
    b.addRow([{ formula: '1+1', result: 2 }, 'a@example.test']); bytes = Buffer.from(await book.xlsx.writeBuffer())
    await expect(parseSpreadsheet('input.xlsx', bytes, { sheetName: 'Customers' })).rejects.toThrow('formulas')
  })
  it('bounds cell and row sizes and rejects duplicate headers', async () => {
    await expect(parseSpreadsheet('x.csv', Buffer.from('Name,Name\na,b'))).rejects.toThrow('unique')
    await expect(parseSpreadsheet('x.csv', Buffer.from(`Name,Email\n${'a'.repeat(10001)},x`))).rejects.toThrow('10,000')
    await expect(parseSpreadsheet('x.csv', Buffer.from('Name,Email\n' + 'A,a@b.test\n'.repeat(50001)))).rejects.toThrow('50,000')
  })
  it('neutralizes spreadsheet formulas in CSV and XLSX including leading controls', async () => {
    for (const s of ['=CMD()', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1+1', '\r+1']) expect(safeCell(s)).toBe(`'${s}`)
    const bytes = await writeSpreadsheet(['Name', 'City'], [['=1+1', 'Delhi']], 'csv')
    expect(bytes.toString()).toContain("'=1+1")
    const book = new ExcelJS.Workbook(); await book.xlsx.load(await writeSpreadsheet(['Name'], [['=1+1']], 'xlsx'))
    expect(book.worksheets[0].getCell('A2').value).toBe("'=1+1")
  })
})
describe('attachment content validation', () => {
  it('rejects SVG/HTML and executable or text renamed to PDF', async () => {
    for (const name of ['image.svg', 'page.html', 'x.exe']) await expect(sniffFile(name, Buffer.from('<html>'))).rejects.toThrow()
    await expect(sniffFile('x.pdf', Buffer.from('MZ' + 'x'.repeat(100)))).rejects.toThrow('extension')
    await expect(sniffFile('x.pdf', Buffer.from('plain text pretending to be PDF'))).rejects.toThrow('extension')
    await expect(sniffFile('x.txt', Buffer.from('<svg onload="alert(1)">'))).rejects.toThrow()
  })
  it('accepts actual PNG/PDF and forces documents to download', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZ8AAAAASUVORK5CYII=', 'base64')
    expect(await sniffFile('x.png', png)).toBe('image/png')
    expect(await sniffFile('x.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n'))).toBe('application/pdf')
    expect(downloadDisposition('a.csv', 'text/csv')).toMatch(/^attachment/)
    expect(downloadDisposition('a.png', 'image/png')).toMatch(/^inline/)
    expect(downloadDisposition('a\r\n.txt', 'text/plain')).not.toContain('\r\n')
    expect(() => assertFileSize('a.png', 26 * 1024 ** 2)).toThrow()
  })
})
