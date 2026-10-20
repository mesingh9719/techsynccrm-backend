import { z } from 'zod'
export const facebookId = z.string().regex(/^\d{1,40}$/, 'Use a Facebook numeric ID')
export const facebookPageParams = z.object({ pageId: z.uuid() })
export const facebookFormParams = z.object({ pageId: z.uuid(), formId: facebookId })
export const facebookUuidParams = z.object({ id: z.uuid() })
export const facebookCursorQuery = z.object({ after: z.string().max(4096).optional() })
export const facebookCampaignQuery = facebookCursorQuery.extend({ accountId: z.string().regex(/^act_\d{1,40}$/, 'Choose a Facebook ad account') })
export const facebookConnectPage = z.object({ facebookPageId: facebookId })
export const facebookMappingTargets = ['fullName', 'firstName', 'lastName', 'email', 'phone', 'companyName', 'city', 'pincode', 'requirement']
export const facebookFormSettings = z.object({
  enabled: z.boolean(),
  dedupe: z.boolean().default(true),
  defaultOwnerId: z.uuid().nullable().default(null),
  mapping: z.record(z.string().min(1).max(200), z.enum(['', ...facebookMappingTargets])).refine((mapping) => {
    const targets = Object.values(mapping).filter(Boolean)
    return new Set(targets).size === targets.length && !Object.keys(mapping).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k))
  }, 'Map each CRM field once; ignore extra columns mapped to the same field.'),
})
export const facebookDeliveryQuery = z.object({ before: z.uuid().optional() })
export const facebookSdkLogin = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  userId: facebookId,
  accessToken: z.string().min(10).max(8192),
  signedRequest: z.string().min(10).max(20000),
})
export const facebookDeletionCode = z.object({ code: z.string().regex(/^[a-f0-9]{64}$/) })
