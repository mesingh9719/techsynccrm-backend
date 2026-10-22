import { beforeEach, describe, expect, it, vi } from 'vitest'

const { db, enqueue, graph, env } = vi.hoisted(() => ({
  db: {
    facebookOAuthState: { deleteMany: vi.fn() },
    facebookForm: { updateMany: vi.fn(), findMany: vi.fn() },
    facebookLeadDelivery: { findMany: vi.fn() },
  },
  enqueue: vi.fn(), graph: vi.fn(), env: { FACEBOOK_APP_ID: '123', FACEBOOK_APP_SECRET: 'test-secret', DATA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
}))
vi.mock('../../src/db/prisma.js', () => ({ prisma: db }))
vi.mock('../../src/config/env.js', () => ({ env }))
vi.mock('../../src/jobs/queue.js', () => ({ enqueue }))
vi.mock('../../src/services/lead.service.js', () => ({ createLeadFromCapture: vi.fn() }))
vi.mock('../../src/integrations/facebook/graph.js', () => ({ graph, graphPage: vi.fn() }))
vi.mock('../../src/integrations/facebook/connection.js', () => ({ connectorContext: vi.fn(), formSelect: {} }))

import { mapFacebookLead, recoverFacebookJobs } from '../../src/integrations/facebook/capture.js'

const form = { mapping: {}, defaultOwnerId: null, facebookFormId: '456' }
const page = { facebookPageId: '123' }
const data = (values) => ({ id: '789', field_data: Object.entries(values).map(([name, value]) => ({ name, values: [value] })) })

beforeEach(() => {
  vi.clearAllMocks()
  db.facebookLeadDelivery.findMany.mockResolvedValue([])
  db.facebookForm.findMany.mockResolvedValue([])
})

describe('Facebook lead mapping', () => {
  it('imports Meta test leads without storing placeholder phone or PIN values', () => {
    const lead = mapFacebookLead(data({ full_name: '<test lead: dummy data for full_name>', email: 'test@example.com', phone_number: '<test lead: dummy data for phone_number>', zip_code: '<test lead: dummy data for zip_code>' }), form, page)
    expect(lead.firstName).toBe('Facebook test')
    expect(lead.lastName).toBe('lead')
    expect(lead.emails[0].value).toBe('test@example.com')
    expect(lead.phones).toBeUndefined()
    expect(lead.pincode).toBeUndefined()
    expect(lead.requirement).toContain('phone_number, zip_code')
  })

  it('preserves real contact details and existing field validation', () => {
    const lead = mapFacebookLead(data({ full_name: 'Asha Sharma', email: 'asha@example.com', phone_number: '9876543210', zip_code: '110001' }), form, page)
    expect(lead.firstName).toBe('Asha')
    expect(lead.phones[0].raw).toBe('9876543210')
    expect(lead.pincode).toBe('110001')
    expect(() => mapFacebookLead(data({ full_name: 'Asha Sharma', zip_code: 'not-a-postcode' }), form, page)).toThrow('Lead fields do not match CRM validation')
  })

  it('respects ignored fields and does not treat arbitrary invalid contact values as test data', () => {
    const lead = mapFacebookLead(data({ full_name: 'Asha Sharma', phone_number: '<test lead: dummy data for phone_number>' }), { ...form, mapping: { phone_number: '' } }, page)
    expect(lead.requirement).toBeUndefined()
    expect(() => mapFacebookLead(data({ full_name: 'Asha Sharma', email: '<test lead: dummy data for a_different_field>' }), form, page)).toThrow('Lead fields do not match CRM validation')
  })
})

describe('Facebook polling recovery', () => {
  it('queues stale enabled forms without restarting paused, queued, or running syncs', async () => {
    db.facebookForm.findMany.mockResolvedValue([{ id: 'form-id' }])
    db.facebookLeadDelivery.findMany.mockResolvedValue([{ id: 'delivery-id' }])
    await recoverFacebookJobs()
    const update = db.facebookForm.updateMany.mock.calls[0][0]
    expect(update.where).toMatchObject({ enabled: true, syncStatus: { in: ['idle', 'completed', 'failed'] }, page: { enabled: true, tokenEnc: { not: '' }, connection: { tokenEnc: { not: '' } } } })
    expect(Date.now() - update.where.updatedAt.lte.getTime()).toBeGreaterThanOrEqual(5 * 60_000)
    expect(update.data).toMatchObject({ syncStatus: 'queued', syncAfter: null, syncLeaseUntil: null })
    expect(enqueue).toHaveBeenCalledWith('facebook.sync', { formId: 'form-id' }, { singletonKey: 'form-id' })
    expect(enqueue).toHaveBeenCalledWith('facebook.lead', { deliveryId: 'delivery-id' }, { singletonKey: 'delivery-id' })
    expect(graph).not.toHaveBeenCalled()
  })
})
