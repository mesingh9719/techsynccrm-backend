import { describe, expect, it } from 'vitest'
import { contactSchema, demoSchema, newsletterSchema } from '../../src/validators/public.validators.js'
import { isSpam } from '../../src/lib/spam.js'
import { buildIcs } from '../../src/lib/ics.js'

const errors = (result) => Object.fromEntries(result.error.issues.map((i) => [i.path.join('.'), i.message]))

const contact = {
  name: 'Ritika Sharma',
  email: ' Ritika@Saffron.in ',
  company: '',
  phone: '',
  topic: 'sales',
  message: 'We have 12 sales reps and want to move off Excel.',
  consent: true,
}

const demo = {
  firstName: 'Deepak',
  lastName: 'Menon',
  email: 'deepak@northwindsteel.com',
  phone: '+91 98450 12345',
  company: 'Northwind Steel',
  companySize: '51–200',
  role: 'Sales Manager',
  interests: ['Lead management'],
  date: '2026-10-21',
  slot: '2:00 PM',
  notes: '',
}

describe('contact form validation (mirrors the frontend)', () => {
  it('accepts a valid submission and normalises it', () => {
    const r = contactSchema.safeParse({ ...contact, website: '', elapsedMs: 9000, utm: { utm_source: 'google', junk: 'x' } })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ email: 'ritika@saffron.in', company: null, phone: null, utm: { utm_source: 'google' } })
    expect(r.data.utm).not.toHaveProperty('junk')
  })

  it('uses the frontend messages', () => {
    const r = contactSchema.safeParse({ ...contact, name: 'R', message: 'short', consent: false, topic: 'nope', phone: 'abc' })
    expect(errors(r)).toEqual({
      name: 'Enter at least 2 characters',
      message: 'Tell us a bit more (at least 20 characters)',
      consent: 'Please agree so we can respond to you',
      topic: 'Choose a topic',
      phone: 'Enter a valid phone number',
    })
  })
})

describe('demo form validation', () => {
  it('accepts a valid booking', () => {
    expect(demoSchema.safeParse(demo).success).toBe(true)
  })

  it('requires a work email, phone, interests and a known slot', () => {
    const r = demoSchema.safeParse({ ...demo, email: 'deepak@gmail.com', phone: '', interests: [], slot: '9:00 AM' })
    expect(errors(r)).toEqual({
      email: 'Please use your work email',
      phone: 'Phone number is required',
      interests: 'Pick at least one area',
      slot: 'Choose a time slot',
    })
  })

  it('rejects unknown interests', () => {
    expect(demoSchema.safeParse({ ...demo, interests: ['Hacking'] }).success).toBe(false)
  })
})

describe('newsletter validation', () => {
  it('lowercases the email', () => {
    expect(newsletterSchema.parse({ email: 'A@B.CO' }).email).toBe('a@b.co')
  })
})

describe('spam detection', () => {
  it('flags honeypots and instant submissions only', () => {
    expect(isSpam({ website: 'http://spam.example' })).toBe(true)
    expect(isSpam({ elapsedMs: 300 })).toBe(true)
    expect(isSpam({ website: '', elapsedMs: 5000 })).toBe(false)
    expect(isSpam({})).toBe(false)
  })
})

describe('ics', () => {
  it('builds a single-event calendar with escaped, folded text', () => {
    const ics = buildIcs({
      uid: 'demo-1@techsynccrm.com',
      start: new Date('2026-10-21T08:30:00Z'),
      durationMinutes: 30,
      summary: 'TechSync CRM demo',
      description: 'Demo for Kaveri Foods, Pvt; Ltd. '.repeat(4),
    })
    expect(ics).toContain('DTSTART:20261021T083000Z')
    expect(ics).toContain('DTEND:20261021T090000Z')
    expect(ics.replace(/\r\n /g, '')).toContain('Kaveri Foods\\, Pvt\\; Ltd.')
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
  })
})
