import * as transfer from '../services/transfer.service.js'
export const createImport = async (req, res) => res.status(201).json({ success: true, data: await transfer.createImport(req.ctx, req.body) })
export const updateImport = async (req, res) => res.json({ success: true, data: await transfer.updateImport(req.ctx, req.validated.params.id, req.body) })
export const previewImport = async (req, res) => res.json({ success: true, data: await transfer.previewImport(req.ctx, req.validated.params.id, req.validated?.query, req.method === 'POST') })
export const startImport = async (req, res) => res.json({ success: true, data: await transfer.startImport(req.ctx, req.validated.params.id, req.body) })
export const importStatus = async (req, res) => res.json({ success: true, data: await transfer.importStatus(req.ctx, req.validated.params.id) })
export const importHistory = async (req, res) => res.json({ success: true, data: { imports: await transfer.importHistory(req.ctx) } })
export const cancelImport = async (req, res) => res.json({ success: true, data: await transfer.cancelImport(req.ctx, req.validated.params.id) })
export const undoImport = async (req, res) => res.json({ success: true, data: await transfer.undoImport(req.ctx, req.validated.params.id) })
export const importErrors = async (req, res) => res.json({ success: true, data: await transfer.importErrors(req.ctx, req.validated.params.id) })
export const createExport = async (req, res) => res.status(201).json({ success: true, data: await transfer.createExport(req.ctx, req.body) })
export const exportStatus = async (req, res) => res.json({ success: true, data: await transfer.exportStatus(req.ctx, req.validated.params.id) })

export const exportHistory = async (req, res) => res.json({ success: true, data: { exports: await transfer.exportHistory(req.ctx) } })

export const importDataset = async (req, res) => res.json({ success: true, data: await transfer.importDataset(req.ctx, req.validated.params.id, req.validated.query) })
export const importAttention = async (req, res) => { const bytes = await transfer.importAttention(req.ctx, req.validated.params.id); res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="import-attention.csv"').send(bytes) }

export const importAttentionData = async (req, res) => res.json({ success: true, data: await transfer.importAttentionData(req.ctx, req.validated.params.id) })
