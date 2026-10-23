import crypto from 'node:crypto'
import sanitizeHtml from 'sanitize-html'
import addressParser from 'nodemailer/lib/addressparser/index.js'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { gmailError } from './config.js'

export const cleanHtml = (html = '') => sanitizeHtml(String(html), {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'rel', 'target'] }, allowedSchemes: ['https', 'http', 'mailto'],
  allowProtocolRelative: false, transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
})
export const plainText = (html = '') => sanitizeHtml(String(html).replace(/<br\s*\/?\s*>|<\/p>|<\/li>/gi, '\n'), { allowedTags: [], allowedAttributes: {} }).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
export const escapeHtml = (text = '') => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
export const normalizeEmail = (value) => String(value || '').trim().toLowerCase()
export const addresses = (value) => addressParser(String(value || ''), { flatten: true }).map((a) => normalizeEmail(a.address)).filter(Boolean)
export function safeHeader(value) {
  if (/[\r\n\0]/.test(String(value))) throw gmailError('EMAIL_RECIPIENT_INVALID', 'Email headers cannot contain line breaks.', 422)
  return String(value)
}
export function excluded(address, account) {
  const email = normalizeEmail(address), domain = email.split('@')[1]
  return !email || (account.excludedAddresses || []).includes(email) || (account.excludedDomains || []).includes(domain)
}
export const mergeFields = ['firstName', 'lastName', 'name', 'company', 'owner', 'workspace']
export function fillTemplate(text, fields, html = false) {
  const rendered = String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    if (!mergeFields.includes(key) || !String(fields[key] ?? '').trim()) throw gmailError('EMAIL_TEMPLATE_FIELD_MISSING', `Complete or replace the ${mergeFields.includes(key) ? key : 'unknown'} template field before sending.`, 422)
    return html ? escapeHtml(fields[key]) : String(fields[key])
  })
  if (/\{\{|\}\}/.test(rendered)) throw gmailError('EMAIL_TEMPLATE_FIELD_MISSING', 'Check the remaining template fields.', 422)
  return rendered
}
export function decodeMessage(message) {
  let bytes = 0, parts = 0
  const out = { html: '', text: '', attachments: [] }
  function walk(part, depth = 0) {
    if (!part || ++parts > 100 || depth > 12) return
    if (part.filename || part.body?.attachmentId) {
      if (out.attachments.length < 30) out.attachments.push({ name: String(part.filename || 'Attachment').slice(0, 200), contentType: part.mimeType, size: part.body?.size || 0 })
      return
    }
    if (part.body?.data && ['text/plain', 'text/html'].includes(part.mimeType)) {
      const remaining = Math.max(0, 200000 - bytes), value = Buffer.from(part.body.data, 'base64url').subarray(0, remaining).toString('utf8')
      bytes += Buffer.byteLength(value)
      if (part.mimeType === 'text/html') out.html += value
      else out.text += value
    }
    for (const child of (part.parts || []).slice(0, 100)) walk(child, depth + 1)
  }
  walk(message.payload)
  out.html = cleanHtml(out.html || `<p>${escapeHtml(out.text).replace(/\n/g, '<br>')}</p>`)
  out.text = out.text || plainText(out.html)
  return out
}
export function headerMap(message) {
  return Object.fromEntries((message.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]))
}
/** Only a structured permanent failure for the exact original message and sole recipient is actionable. */
export function permanentDeliveryFailure(message, original) {
  const reports = [], originalIds = []; let count = 0
  function walk(part, depth = 0) {
    if (!part || ++count > 100 || depth > 12) return
    if (part.body?.data && ['message/delivery-status', 'text/rfc822-headers', 'message/rfc822'].includes(part.mimeType)) {
      const text = Buffer.from(part.body.data, 'base64url').subarray(0, 64000).toString('utf8')
      if (part.mimeType === 'message/delivery-status') reports.push(text)
      else originalIds.push(...(text.match(/^Message-ID:\s*(<[^>\r\n]+>)/gmi) || []).map((line) => line.replace(/^Message-ID:\s*/i, '').trim()))
    }
    for (const child of (part.parts || []).slice(0, 100)) walk(child, depth + 1)
  }
  walk(message.payload)
  const headers = headerMap(message), refs = `${headers['in-reply-to'] || ''} ${headers.references || ''}`.match(/<[^<>\r\n]+>/g) || []
  if (![...refs, ...originalIds].includes(original.rfcMessageId) || original.to.length !== 1) return false
  return reports.some((report) => report.split(/\r?\n\r?\n/).some((block) => {
    const values = Object.fromEntries(block.split(/\r?\n/).map((line) => { const colon = line.indexOf(':'); return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] }))
    const recipient = values['final-recipient']?.replace(/^rfc822\s*;\s*/i, '')
    return normalizeEmail(recipient) === normalizeEmail(original.to[0]) && values.action?.toLowerCase() === 'failed' && /^5\.\d{1,3}\.\d{1,3}$/.test(values.status || '')
  }))
}
export const contentFingerprint = (orgId, content) => crypto.createHash('sha256').update(JSON.stringify([orgId, content.rfcMessageId, normalizeEmail(content.from), [...content.to].sort(), content.date, content.subject, content.text.trim()])).digest('hex')
export async function mimeMessage({ from, to, subject, html, text, rfcMessageId, inReplyTo, references, date, attachments = [] }) {
  const mail = new MailComposer({
    from: safeHeader(from), to: safeHeader(to), subject: safeHeader(subject), html: cleanHtml(html), text,
    messageId: safeHeader(rfcMessageId), ...(date && { date: new Date(date) }), ...(inReplyTo && { inReplyTo: safeHeader(inReplyTo) }),
    ...(references?.length && { references: references.map(safeHeader) }), attachments,
    disableFileAccess: true, disableUrlAccess: true,
  })
  return (await mail.compile().build()).toString('base64url')
}
