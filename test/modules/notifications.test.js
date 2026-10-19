import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/db/prisma.js', () => ({ prisma: {}, DB_NULL: 'DB_NULL', UNIQUE_VIOLATION: 'P2002' }))
import { notificationChannels } from '../../src/config/notifications.js'
import { dayBounds, digestDay, emailAllowedAt } from '../../src/lib/notificationTime.js'
import { notificationPreferencesSchema, streamQuery } from '../../src/validators/notification.validators.js'
import { startNotificationConnection } from '../../../frontend/src/features/notifications/notificationConnection.ts'

afterEach(() => vi.useRealTimers())

describe('M11 preferences and user-time rules', () => {
  it('keeps mandatory inbox channels enabled and optional admin alerts disabled by default', () => {
    expect(notificationChannels('mention', { inApp: false, email: false })).toEqual({ inApp: true, email: false })
    expect(notificationChannels('task_reminder', { inApp: false, email: true }).inApp).toBe(true)
    expect(notificationChannels('deal_won')).toEqual({ inApp: false, email: false })
    expect(notificationChannels('task_overdue')).toEqual({ inApp: false, email: false })
  })
  it.each([
    ['2026-10-19T16:30:00Z', { start: '21:00', end: '08:00' }, 'Asia/Kolkata', '2026-10-20T02:30:00.000Z'],
    ['2026-10-19T01:00:00Z', { start: '21:00', end: '08:00' }, 'Asia/Kolkata', '2026-10-19T02:30:00.000Z'],
    ['2026-10-19T02:30:00Z', { start: '21:00', end: '08:00' }, 'Asia/Kolkata', '2026-10-19T02:30:00.000Z'],
    ['2026-10-19T06:00:00Z', { start: '10:00', end: '12:00' }, 'Asia/Kolkata', '2026-10-19T06:30:00.000Z'],
    ['2026-03-08T06:30:00Z', { start: '21:00', end: '08:00' }, 'America/New_York', '2026-03-08T12:00:00.000Z'],
  ])('defers quiet-hour email correctly for %s', (at, hours, timezone, expected) => {
    expect(emailAllowedAt(new Date(at), hours, timezone).toISOString()).toBe(expected)
  })
  it('uses local midnight boundaries across DST and fires digest at 08:30', () => {
    const { start, end } = dayBounds(new Date('2026-03-08T14:00:00Z'), 'America/New_York')
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z')
    expect(digestDay(new Date('2026-10-19T02:59:00Z'), 'Asia/Kolkata')).toBeNull()
    expect(digestDay(new Date('2026-10-19T03:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-19')
  })
  it('rejects invalid hours, duplicate preferences, mandatory disable and access tokens in SSE URLs', () => {
    const parse = (changes) => notificationPreferencesSchema.safeParse({ preferences: [], quietHours: null, digestEnabled: true, ...changes }).success
    expect(parse({ quietHours: { start: '25:00', end: '08:00' } })).toBe(false)
    expect(parse({ quietHours: { start: '08:00', end: '08:00' } })).toBe(false)
    expect(parse({ preferences: [{ type: 'mention', inApp: false, email: false }] })).toBe(false)
    expect(parse({ preferences: [{ type: 'system', inApp: true, email: true }, { type: 'system', inApp: true, email: true }] })).toBe(false)
    expect(streamQuery.safeParse({ ticket: 'a'.repeat(43), access_token: 'secret' }).success).toBe(false)
  })
})

describe('M11 browser stream lifecycle and polling fallback', () => {
  const options = () => ({ requestTicket: vi.fn().mockResolvedValue({ ticket: 'ticket-one' }), makeUrl: (ticket) => `/stream?ticket=${ticket}`, isActive: () => true, onNotification: vi.fn(), onPoll: vi.fn() })
  it('keeps polling every 60 seconds when EventSource is unavailable and stops on cleanup', async () => {
    vi.useFakeTimers()
    const opts = options()
    const stop = startNotificationConnection(opts)
    await vi.advanceTimersByTimeAsync(60000)
    expect(opts.onPoll).toHaveBeenCalledTimes(1)
    expect(opts.requestTicket).not.toHaveBeenCalled()
    stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(opts.onPoll).toHaveBeenCalledTimes(1)
  })
  it('reconnects with a new ticket and ignores invalid frames', async () => {
    vi.useFakeTimers()
    const sources = []
    const opts = options()
    opts.requestTicket.mockResolvedValueOnce({ ticket: 'one' }).mockResolvedValueOnce({ ticket: 'two' })
    const createSource = vi.fn((url) => { const source = { url, onmessage: null, onerror: null, close: vi.fn() }; sources.push(source); return source })
    const stop = startNotificationConnection({ ...opts, createSource })
    await vi.advanceTimersByTimeAsync(0)
    sources[0].onmessage({ data: '{"type":"notification","unreadCount":2}' })
    sources[0].onmessage({ data: 'invalid' })
    sources[0].onmessage({ data: '{"type":"notification","unreadCount":-1}' })
    expect(opts.onNotification).toHaveBeenCalledExactlyOnceWith(2)
    sources[0].onerror()
    expect(sources[0].close).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10000)
    expect(createSource.mock.calls.map(([url]) => url)).toEqual(['/stream?ticket=one', '/stream?ticket=two'])
    stop()
    expect(sources[1].close).toHaveBeenCalled()
  })
  it('does not open an old workspace stream when a ticket resolves after cleanup', async () => {
    let resolve
    const opts = options()
    opts.requestTicket.mockImplementation(() => new Promise((r) => { resolve = r }))
    const createSource = vi.fn()
    const stop = startNotificationConnection({ ...opts, createSource })
    stop(); resolve({ ticket: 'late-ticket' })
    await Promise.resolve(); await Promise.resolve()
    expect(createSource).not.toHaveBeenCalled()
  })
})
