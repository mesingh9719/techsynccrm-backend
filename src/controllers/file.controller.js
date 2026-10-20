import * as files from '../services/file.service.js'
import { ApiError } from '../utils/ApiError.js'
export async function upload(req, res) {
  if (!req.file) throw ApiError.badRequest('Attach a file in the "file" form field')
  res.status(201).json({ success: true, data: { file: await files.uploadFile(req.ctx, req.file, req.body) } })
}
export async function intent(req, res) { res.status(201).json({ success: true, data: await files.createUploadIntent(req.ctx, req.body) }) }
export async function complete(req, res) { res.json({ success: true, data: { file: await files.completeUpload(req.ctx, req.validated.params.id) } }) }
export async function list(req, res) { res.json({ success: true, data: { files: await files.listFiles(req.ctx, req.validated.query) } }) }
export async function getOne(req, res) { res.json({ success: true, data: { file: await files.getFileWithUrl(req.ctx, req.validated.params.id) } }) }
export async function remove(req, res) { await files.deleteFile(req.ctx, req.validated.params.id); res.status(204).end() }
export async function restore(req, res) { res.json({ success: true, data: { file: await files.restoreFile(req.ctx, req.validated.params.id) } }) }
export async function link(req, res) { await files.linkFile(req.ctx, req.validated.params.id, req.body); res.status(204).end() }
export async function unlink(req, res) { const { id, entityType, entityId } = req.validated.params; await files.unlinkFile(req.ctx, id, { entityType, entityId }); res.status(204).end() }
