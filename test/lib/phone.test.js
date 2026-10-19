import { describe, expect, it } from 'vitest'
import { normalizePhone } from '../../src/lib/phone.js'

describe('normalizePhone', () => {
  it.each([
    ['098765 43210', '+919876543210'],
    ['9876543210', '+919876543210'],
    ['+91-98765-43210', '+919876543210'],
    ['+91 98450 12345', '+919845012345'],
    ['080 4567 8901', '+918045678901'],
  ])('normalises %s', (raw, e164) => {
    expect(normalizePhone(raw)).toEqual({ e164, raw, valid: true })
  })

  it('keeps international numbers', () => {
    expect(normalizePhone('+1 415 555 2671').e164).toBe('+14155552671')
  })

  it('keeps the raw value when invalid', () => {
    expect(normalizePhone('12345')).toEqual({ e164: null, raw: '12345', valid: false })
    expect(normalizePhone('   ')).toEqual({ e164: null, raw: null, valid: false })
    expect(normalizePhone(null)).toEqual({ e164: null, raw: null, valid: false })
  })
})
