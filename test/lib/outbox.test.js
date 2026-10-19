import { describe, expect, it, vi } from 'vitest'
import { diff, emit } from '../../src/events/outbox.js'
import { clearSubscribers, subscribe, subscribersFor } from '../../src/events/registry.js'

describe('outbox', () => {
  it('writes the event through the given transaction client', async () => {
    const tx = { domainEvent: { create: vi.fn().mockResolvedValue({ id: 'e1' }) } }
    await emit(tx, { orgId: 'o1', userId: 'u1' }, 'lead.created', { entityType: 'lead', entityId: 'l1' }, { source: 'web' })
    expect(tx.domainEvent.create).toHaveBeenCalledWith({
      data: { organizationId: 'o1', actorId: 'u1', type: 'lead.created', entityType: 'lead', entityId: 'l1', payload: { source: 'web' } },
      select: { id: true },
    })
  })

  it('rejects badly named events', async () => {
    await expect(emit({}, null, 'LeadCreated', { entityType: 'lead', entityId: 'x' })).rejects.toThrow(/Invalid event type/)
  })

  it('diffs only changed fields', () => {
    const before = { status: 'new', ownerId: null, tags: ['a'], at: new Date(1) }
    const after = { status: 'contacted', ownerId: null, tags: ['a'], at: new Date(1) }
    expect(diff(before, after, ['status', 'ownerId', 'tags', 'at'])).toEqual({ status: ['new', 'contacted'] })
    expect(diff(before, before, ['status'])).toBeNull()
  })
})

describe('event registry', () => {
  it('matches exact, wildcard and catch-all patterns', () => {
    clearSubscribers()
    subscribe('a', ['lead.created'], async () => {})
    subscribe('b', ['lead.*'], async () => {})
    subscribe('c', ['*'], async () => {})
    expect(subscribersFor('lead.created').map((s) => s.name)).toEqual(['a', 'b', 'c'])
    expect(subscribersFor('lead.assigned').map((s) => s.name)).toEqual(['b', 'c'])
    expect(subscribersFor('deal.won').map((s) => s.name)).toEqual(['c'])
    expect(() => subscribe('a', ['x.y'], async () => {})).toThrow(/already registered/)
    clearSubscribers()
  })
})
