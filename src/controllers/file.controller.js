import * as fileService from '../services/file.service.js'
import { ApiError } from '../utils/ApiError.js'

export async function upload(req, res) {
  if (!req.file) throw ApiError.badRequest('Attach a file in the "file" form field')
  res.status(201).json({ success: true, data: { file: await fileService.uploadFile(req.user.id, req.file, req.user.orgId) } })
}

export async function list(req, res) {
  res.json({ success: true, data: { files: await fileService.listFiles(req.user.id) } })
}

export async function getOne(req, res) {
  res.json({ success: true, data: { file: await fileService.getFileWithUrl(req.user.id, req.validated.params.id) } })
}

export async function remove(req, res) {
  await fileService.deleteFile(req.user.id, req.validated.params.id)
  res.status(204).end()
}
