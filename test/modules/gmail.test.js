import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/config/env.js', () => ({ env: {} }))
import { cleanHtml, plainText, fillTemplate, addresses, excluded, mimeMessage, decodeMessage, contentFingerprint, permanentDeliveryFailure } from '../../src/integrations/gmail/content.js'
import { open, seal } from '../../src/integrations/gmail/vault.js'

describe('Gmail content and encrypted boundaries', () => {
  it('removes active content, remote pixels and unsafe links while retaining simple formatting', () => {
    const html = cleanHtml('<p onclick="steal()"><strong>Hello</strong><img src="https://tracker.invalid/pixel"><script>steal()</script><a href="javascript:steal()">link</a></p>')
    expect(html).toContain('<strong>Hello</strong>'); expect(html).not.toMatch(/script|onclick|img|javascript/)
  })
  it('expands allowlisted fields with HTML escaping and rejects missing or executable template syntax', () => {
    expect(fillTemplate('<p>{{name}}</p>', { name: '<Customer>' }, true)).toBe('<p>&lt;Customer&gt;</p>')
    expect(() => fillTemplate('{{company}}', { company: '' })).toThrow('Complete or replace')
    expect(() => fillTemplate('{{user.password}}', {})).toThrow('unknown')
  })
  it('parses actual addresses without guessing dots/plus aliases or matching customer domains', () => {
    expect(addresses('Customer <a.b+sales@example.test>')).toEqual(['a.b+sales@example.test'])
    expect(excluded('a@example.test', { excludedDomains: ['example.test'] })).toBe(true)
    expect(excluded('a@sub.example.test', { excludedDomains: ['example.test'] })).toBe(false)
  })
  it('binds encrypted content to its tenant, account, purpose and authentication tag', () => {
    const key = Buffer.alloc(32, 7), account = { organizationId: 'one', id: 'mailbox' }
    const value = seal(key, account, 'credentials', { refreshToken: 'fixture-refresh-only' })
    expect(value).not.toContain('fixture-refresh-only')
    expect(open(key, account, 'credentials', value)).toEqual({ refreshToken: 'fixture-refresh-only' })
    expect(() => open(key, { ...account, organizationId: 'two' }, 'credentials', value)).toThrow()
    expect(() => open(key, account, 'message:one', value)).toThrow()
  })
  it('builds MIME with stable threading headers, text/HTML alternatives and no header injection', async () => {
    const raw = await mimeMessage({ from: 'rep@example.test', to: 'lead@example.test', subject: 'Re: Enquiry', html: '<b>Hello</b>', text: 'Hello', rfcMessageId: '<one@example.test>', inReplyTo: '<parent@example.test>', references: ['<parent@example.test>'], date: '2026-10-23T01:00:00Z' })
    const mime = Buffer.from(raw, 'base64url').toString()
    expect(mime).toContain('In-Reply-To: <parent@example.test>'); expect(mime).toContain('multipart/alternative')
    await expect(mimeMessage({ from: 'x\r\nBcc: secret@example.test', to: 'a@example.test', subject: 'x', html: 'Hi', text: 'Hi', rfcMessageId: '<x@example.test>' })).rejects.toThrow('line breaks')
  })
  it('bounds MIME rendering, strips images, and records attachment metadata without reading bytes', () => {
    const result = decodeMessage({ payload: { mimeType: 'multipart/mixed', parts: [ { mimeType: 'text/html', body: { data: Buffer.from('<p>Hello<img src="https://remote.invalid"></p>').toString('base64url') } }, { filename: 'brochure.pdf', mimeType: 'application/pdf', body: { attachmentId: 'not-downloaded', size: 123 } } ] } })
    expect(result.html).toBe('<p>Hello</p>'); expect(result.attachments[0]).toMatchObject({ name: 'brochure.pdf', size: 123 })
    expect(plainText(result.html)).toBe('Hello')
  })
  it('keeps deduplication scoped to tenant and complete message identity', () => {
    const content = { rfcMessageId: '<id>', from: 'a@example.test', to: ['b@example.test'], date: 'today', text: 'Hi', subject: 'Offer' }
    expect(contentFingerprint('one', content)).not.toBe(contentFingerprint('two', content))
    expect(contentFingerprint('one', content)).not.toBe(contentFingerprint('one', { ...content, text: 'Different' }))
  })
})

describe('Gmail delivery reports', () => {
  it('requires structured permanent recipient failure correlated to the exact original message', () => {
    const original = { rfcMessageId: '<known@example.test>', to: ['lead@example.test'] }
    const report = { payload: { headers: [{ name: 'In-Reply-To', value: original.rfcMessageId }], parts: [{ mimeType: 'message/delivery-status', body: { data: Buffer.from('Reporting-MTA: dns; googlemail.com\r\n\r\nFinal-Recipient: rfc822; lead@example.test\r\nAction: failed\r\nStatus: 5.1.1').toString('base64url') } }] } }
    expect(permanentDeliveryFailure(report, original)).toBe(true)
    expect(permanentDeliveryFailure(report, { ...original, rfcMessageId: '<different@example.test>' })).toBe(false)
    expect(permanentDeliveryFailure(report, { ...original, to: ['unrelated@example.test'] })).toBe(false)
    const transient = structuredClone(report)
    transient.payload.parts[0].body.data = Buffer.from('Final-Recipient: rfc822; lead@example.test\nAction: delayed\nStatus: 4.1.1').toString('base64url')
    expect(permanentDeliveryFailure(transient, original)).toBe(false)
    expect(permanentDeliveryFailure({ payload: { body: { data: Buffer.from('Mail failed').toString('base64url') } } }, original)).toBe(false)
  })
})
