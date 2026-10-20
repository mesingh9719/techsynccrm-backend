import path from 'node:path'
import { fileTypeFromBuffer } from 'file-type'
import { ApiError } from '../utils/ApiError.js'

export const FILE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', csv: 'text/csv', txt: 'text/plain',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4',
}
const invalid = (message) => new ApiError(400, message, { code: 'INVALID_FILE_TYPE' })
export function fileTypeForName(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  if (!FILE_TYPES[ext]) throw invalid('Choose an image, PDF, Office document, CSV, text, audio or MP4 file. HTML and SVG are not allowed.')
  return FILE_TYPES[ext]
}
export function assertFileSize(name, size, maxMb = 25) {
  const type = fileTypeForName(name)
  const max = (type === 'video/mp4' ? 50 : maxMb) * 1024 ** 2
  if (!Number.isSafeInteger(size) || size < 1 || size > max) throw new ApiError(413, `Choose a file up to ${max / 1024 ** 2} MB.`, { code: 'FILE_TOO_LARGE' })
  return type
}
export async function sniffFile(name, bytes) {
  const expected = fileTypeForName(name)
  const detected = await fileTypeFromBuffer(bytes).catch(() => null)
  if (expected.startsWith('text/')) {
    // Permit UTF-8/UTF-16/Windows-1252 spreadsheets; reject binary controls and active markup.
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff
    const sample = utf16 ? bytes.subarray(2, 8192).toString(bytes[0] === 0xff ? 'utf16le' : 'latin1').replace(/\0/g, '') : bytes.subarray(0, 8192).toString('latin1')
    if (detected || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(sample) || /^\s*<(?:!doctype|html|svg|script|iframe|object|embed)\b/i.test(sample.replace(/^(?:ï»¿|\uFEFF)/, ''))) throw invalid('The file contents do not match a plain text or CSV file.')
    return expected
  }
  // Legacy Office files share OLE signatures. file-type returns application/x-cfb for that family.
  const legacyOffice = ['application/msword', 'application/vnd.ms-excel'].includes(expected) && detected?.mime === 'application/x-cfb'
  const aliases = { 'audio/wav': ['audio/vnd.wave'], 'audio/mp4': ['audio/x-m4a'], 'audio/ogg': ['application/ogg'] }
  if (!detected || !(detected.mime === expected || aliases[expected]?.includes(detected.mime) || legacyOffice)) throw invalid('The file contents do not match its extension.')
  return expected
}
export function downloadDisposition(name, contentType) {
  const inline = contentType.startsWith('image/') || contentType === 'application/pdf'
  return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`
}
