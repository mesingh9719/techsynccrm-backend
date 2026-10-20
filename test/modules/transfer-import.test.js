import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

const { db, storage, sourceFile } = vi.hoisted(() => ({
  db: {
    importJob: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    importMapping: { findUnique: vi.fn() },
    customFieldDefinition: { findMany: vi.fn() },
    file: { findFirst: vi.fn() },
    fileLink: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
  storage: { bytes: vi.fn() },
  sourceFile: vi.fn(),
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db, DB_NULL: 'DB_NULL', UNIQUE_VIOLATION: 'P2002' }))
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test' } }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue: vi.fn() }))
vi.mock('../../src/storage/objectStore.js', () => ({ objectStore: storage }))
vi.mock('../../src/services/file.service.js', () => ({ accessibleFile: sourceFile, getFileWithUrl: vi.fn(), storeGeneratedFile: vi.fn() }))

import { createImport, updateImport } from '../../src/services/transfer.service.js'
import { updateImport as updateImportController } from '../../src/controllers/transfer.controller.js'
import { updateImportSchema } from '../../src/validators/transfer.validators.js'
import { validate } from '../../src/middlewares/validate.js'
const updateImportClient = (importId, body) => fetch(`/imports/${importId}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.json()).then((d) => d.data)

const id = 'ee8cc2c1-0af9-4469-88b8-2cf4b9558f73'
const fileId = '11111111-1111-4111-8111-111111111111'
const ctx = { orgId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333', role: 'owner', permissions: ['records.import'] }
let job

beforeEach(() => {
  vi.resetAllMocks()
  job = { id, fileId, entityType: 'lead', status: 'draft', sheetName: null, headerRow: 1, totalRows: 1, mapping: { 'Customer Name': 'fullName', Mobile: 'phone', 'Email ID': 'email' }, options: { duplicateStrategy: 'skip', updateMode: 'empty', dateFormat: 'DMY' } }
  storage.bytes.mockResolvedValue(Buffer.from('Customer Name,Mobile,Email ID\nAsha,9876543210,asha@example.test\n'))
  sourceFile.mockResolvedValue({ status: 'ready', originalName: 'lead-template.csv', storageKey: 'test.csv' })
  db.importJob.findFirst.mockImplementation(async () => ({ ...job }))
  db.importJob.create.mockImplementation(async ({ data }) => (job = { ...job, ...data }))
  db.importJob.updateMany.mockImplementation(async ({ data }) => { job = { ...job, ...data }; return { count: 1 } })
  db.customFieldDefinition.findMany.mockResolvedValue([])
  db.importMapping.findUnique.mockResolvedValue(null)
  db.file.findFirst.mockResolvedValue({ id: fileId })
  db.$transaction = vi.fn(async (fn) => fn(db))
})

describe('import request contract and detection', () => {
  it('accepts CSV null sheet names without weakening header validation', () => {
    expect(updateImportSchema.parse({ sheetName: null, headerRow: 1 })).toEqual({ sheetName: null, headerRow: 1 })
    for (const headerRow of [0, 101, 1.5, '1', null]) expect(updateImportSchema.safeParse({ headerRow }).success).toBe(false)
    expect(updateImportSchema.safeParse({ sheetName: 123 }).success).toBe(false)
  })

  it('round-trips the actual client PATCH through middleware, controller and spreadsheet service', async () => {
    const created = await createImport(ctx, { entityType: 'lead', fileId })
    expect(created.sheetName).toBeNull()
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const req = { body: JSON.parse(options.body), ctx, validated: { params: { id } } }
      let failure, response
      validate(updateImportSchema)(req, {}, (err) => { failure = err })
      if (failure) return new Response(JSON.stringify({ success: false, error: { message: failure.message, details: failure.details } }), { status: 400 })
      await updateImportController(req, { json: (value) => { response = value } })
      return new Response(JSON.stringify(response), { status: 200 })
    })
    try {
      const updated = await updateImportClient(created.id, { sheetName: created.sheetName, headerRow: created.headerRow })
      expect(updated).toMatchObject({ sheetName: null, headerRow: 1, totalRows: 1, headers: ['Customer Name', 'Mobile', 'Email ID'] })
    } finally { fetch.mockRestore() }
  })

  it('re-detects layout and persists the new header and matching columns', async () => {
    storage.bytes.mockResolvedValue(Buffer.from('Customer report,October\n\nCustomer Name,Mobile,Email ID\nAsha,9876543210,asha@example.test\n'))
    const updated = await updateImport(ctx, id, updateImportSchema.parse({ autoDetect: true }))
    expect(updated).toMatchObject({ sheetName: null, headerRow: 3, totalRows: 1, mapping: { 'Customer Name': 'fullName', Mobile: 'phone', 'Email ID': 'email' } })
    expect(db.importJob.updateMany.mock.calls[0][0].data).not.toHaveProperty('autoDetect')
  })

  it('selects an XLSX data sheet automatically and re-detects headers on manual sheet changes', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Instructions').addRow(['Read me'])
    const first = workbook.addWorksheet('Customers')
    first.addRow(['Customer Name', 'Mobile', 'Email ID']); first.addRow(['Asha', '9876543210', 'asha@example.test'])
    const second = workbook.addWorksheet('Other')
    second.addRow(['Another report']); second.addRow(['Name', 'Email']); second.addRow(['Rohan', 'rohan@example.test'])
    sourceFile.mockResolvedValue({ status: 'ready', originalName: 'customers.xlsx', storageKey: 'test.xlsx' })
    storage.bytes.mockResolvedValue(Buffer.from(await workbook.xlsx.writeBuffer()))
    const detected = await updateImport(ctx, id, { autoDetect: true })
    expect(detected).toMatchObject({ sheetName: 'Customers', headerRow: 1 })
    const changed = await updateImport(ctx, id, { sheetName: 'Other' })
    expect(changed).toMatchObject({ sheetName: 'Other', headerRow: 2, headers: ['Name', 'Email'], mapping: { Name: 'fullName', Email: 'email' } })
  })

  it('keeps manually edited mappings when the layout has not changed', async () => {
    await updateImport(ctx, id, { mapping: { 'Customer Name': 'fullName', Mobile: '', 'Email ID': 'email' } })
    expect(job.mapping.Mobile).toBe('')
    expect(db.customFieldDefinition.findMany).not.toHaveBeenCalled()
  })
})
