import { z } from 'zod'
import { listQuerySchema } from '../lib/pagination.js'
import { expectedUpdatedAt } from './crm.validators.js'

export const campaignTypes = ['meta_ads', 'google_ads', 'email', 'sms', 'website', 'referral', 'offline', 'other']
export const campaignObjectives = [
  'lead_generation',
  'brand_awareness',
  'conversion',
  'retargeting',
  'event',
  'retention',
]
export const campaignStatuses = ['draft', 'scheduled', 'active', 'paused', 'completed', 'archived']
const text = (max) => z.string().trim().max(max).nullable()
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
const fields = {
  name: z.string().trim().min(1).max(160),
  code: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'Use lowercase letters, numbers, hyphens or underscores'),
  type: z.enum(campaignTypes),
  objective: z.enum(campaignObjectives),
  status: z.enum(campaignStatuses),
  startDate: z.iso.date(),
  endDate: z.iso.date().nullable(),
  budgetMinor: money,
  actualSpendMinor: money,
  currency: z.enum(['INR', 'USD']),
  sourceId: z.uuid().nullable(),
  ownerId: z.uuid().nullable(),
  externalAccountId: text(100),
  externalCampaignId: text(100),
  externalPlatform: z.enum(['facebook', 'google']).nullable(),
  landingUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable(),
  targetAudience: text(2000),
  description: text(10000),
  utm: z
    .object({
      utm_source: z.string().trim().max(200).optional(),
      utm_medium: z.string().trim().max(200).optional(),
      utm_campaign: z.string().trim().max(80).optional(),
      utm_content: z.string().trim().max(200).optional(),
      utm_term: z.string().trim().max(200).optional(),
    })
    .strict(),
}
const dates = (value) => !value.endDate || !value.startDate || value.endDate >= value.startDate
export const createCampaignSchema = z
  .object({ ...fields, status: fields.status.default('draft') })
  .partial({
    endDate: true,
    budgetMinor: true,
    actualSpendMinor: true,
    currency: true,
    sourceId: true,
    ownerId: true,
    externalAccountId: true,
    externalCampaignId: true,
    externalPlatform: true,
    landingUrl: true,
    targetAudience: true,
    description: true,
    utm: true,
  })
  .strict()
  .refine(dates, { path: ['endDate'], message: 'End date must be on or after start date' })
export const updateCampaignSchema = z
  .object({ ...fields, expectedUpdatedAt })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedUpdatedAt'), 'Nothing to update')
  .refine(dates, { path: ['endDate'], message: 'End date must be on or after start date' })
export const campaignListQuery = listQuerySchema
  .extend({
    q: z.string().trim().max(100).optional(),
    status: z.enum(campaignStatuses).optional(),
    type: z.enum(campaignTypes).optional(),
  })
  .strict()
export const campaignStatusSchema = z.object({ status: z.enum(campaignStatuses), expectedUpdatedAt }).strict()
export const campaignSyncSchema = z
  .object({
    adAccountId: z.string().regex(/^act_\d{1,30}$/, 'Choose a Meta ad account'),
    after: z.string().max(1000).optional(),
  })
  .strict()
