import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/prisma.js', () => ({ prisma: {} }))
vi.mock('../../src/config/env.js', () => ({ env: { NODE_ENV: 'test', FRONTEND_URL: 'https://app.example.test' } }))
vi.mock('../../src/email/mailer.js', () => ({ queueEmail: vi.fn() }))

const { bucketStarts, intervalFor } = await import('../../src/services/report.service.js')
const { periodMonths } = await import('../../src/services/target.service.js')
const { periodFor } = await import('../../src/services/reportSchedule.service.js')
const { reportSummaryEmail } = await import('../../src/email/templates.js')
const { reportQuery, targetsBody } = await import('../../src/validators/report.validators.js')

describe('report trend buckets', () => {
  it('picks day, week or month from the period length unless one is requested', () => {
    expect(intervalFor('2026-10-01', '2026-10-31')).toBe('day')
    expect(intervalFor('2026-08-01', '2026-10-31')).toBe('week')
    expect(intervalFor('2026-01-01', '2026-10-31')).toBe('month')
    expect(intervalFor('2026-01-01', '2026-10-31', 'week')).toBe('week')
    expect(intervalFor('2026-10-01', '2026-10-31', 'auto')).toBe('day')
  })
  it('covers the whole period with Monday-start weeks and first-of-month months', () => {
    expect(bucketStarts('2026-10-30', '2026-11-02', 'day')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    // 2026-10-29 is a Thursday; its week starts Monday 2026-10-26.
    expect(bucketStarts('2026-10-29', '2026-11-10', 'week')).toEqual(['2026-10-26', '2026-11-02', '2026-11-09'])
    expect(bucketStarts('2026-10-15', '2027-01-03', 'month')).toEqual(['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01'])
  })
})

describe('target proration', () => {
  it('weights each month by the days of it inside the period', () => {
    expect(periodMonths('2026-11-01', '2026-11-30')).toEqual([{ month: '2026-11', fraction: 1 }])
    const [oct, nov] = periodMonths('2026-10-17', '2026-11-03')
    expect(oct).toEqual({ month: '2026-10', fraction: 15 / 31 })
    expect(nov).toEqual({ month: '2026-11', fraction: 3 / 30 })
    expect(periodMonths('2026-12-20', '2027-01-10').map((m) => m.month)).toEqual(['2026-12', '2027-01'])
  })
})

describe('scheduled report periods', () => {
  it('sends the previous Monday–Sunday from 08:00 workspace time', () => {
    // Tuesday 2026-11-03 10:30 IST
    expect(periodFor('weekly', new Date('2026-11-03T05:00:00Z'), 'Asia/Kolkata')).toMatchObject({ key: '2026-10-26', from: '2026-10-26', to: '2026-11-01', due: true })
    // Monday 2026-11-02 07:00 IST is before the send hour
    expect(periodFor('weekly', new Date('2026-11-02T01:30:00Z'), 'Asia/Kolkata')).toMatchObject({ key: '2026-10-26', due: false })
  })
  it('sends the previous calendar month, including across a year boundary', () => {
    expect(periodFor('monthly', new Date('2026-11-01T04:00:00Z'), 'Asia/Kolkata')).toMatchObject({ key: '2026-10', from: '2026-10-01', to: '2026-10-31', due: true })
    expect(periodFor('monthly', new Date('2027-01-05T04:00:00Z'), 'Asia/Kolkata')).toMatchObject({ key: '2026-12', from: '2026-12-01', to: '2026-12-31' })
  })
})

describe('report validation', () => {
  it('accepts auto/day/week intervals and rejects daily buckets over long periods', () => {
    expect(reportQuery.safeParse({ from: '2026-10-01', to: '2026-10-31', interval: 'auto' }).success).toBe(true)
    expect(reportQuery.safeParse({ from: '2026-01-01', to: '2026-10-31', interval: 'day' }).success).toBe(false)
    expect(reportQuery.safeParse({ from: '2026-01-01', to: '2026-10-31', interval: 'month' }).success).toBe(true)
  })
  it('validates target months and amounts', () => {
    const userId = '0e4f7d0a-7f1a-4d2b-9c55-1d6f1c2f3a4b'
    expect(targetsBody.safeParse({ month: '2026-11', targets: [{ userId, revenueMinor: 500000, dealsWon: null }] }).success).toBe(true)
    expect(targetsBody.safeParse({ month: '2026-13', targets: [{ userId }] }).success).toBe(false)
    expect(targetsBody.safeParse({ month: '2026-11', targets: [{ userId, revenueMinor: -1 }] }).success).toBe(false)
    expect(targetsBody.safeParse({ month: '2026-11', targets: [] }).success).toBe(false)
  })
})

describe('report summary email', () => {
  it('escapes workspace data and includes the report link', () => {
    const email = reportSummaryEmail({
      name: 'Asha Rao',
      organizationName: 'Rao & <Sons>',
      frequency: 'weekly',
      periodLabel: 'last week (26 Oct – 1 Nov)',
      kpis: [{ label: 'New leads', value: '12', delta: '+20.0%', positive: true, context: 'vs previous period' }],
      sources: [{ label: '<script>', value: '3 leads · ₹0.00' }],
      team: [],
      followUps: [{ label: 'Overdue tasks now', value: '2' }],
      reportUrl: 'https://app.example.test/app/reports?from=2026-10-26',
      settingsUrl: 'https://app.example.test/app/reports',
    })
    expect(email.subject).toBe('Weekly sales report · Rao & <Sons> · last week (26 Oct – 1 Nov)')
    expect(email.html).toContain('Rao &amp; &lt;Sons&gt;')
    expect(email.html).not.toContain('<script>')
    expect(email.html).not.toContain('Team performance')
    expect(email.text).toContain('https://app.example.test/app/reports?from=2026-10-26')
  })
})
