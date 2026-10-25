/** Local CRM campaign lifecycle (M22). Linked Meta delivery uses provider-specific controls. */
export const campaignTypes = ['meta_ads', 'google_ads', 'email', 'sms', 'website', 'referral', 'offline', 'other']
export const campaignObjectives = ['lead_generation', 'brand_awareness', 'conversion', 'retargeting', 'event', 'retention']
export const campaignTransitions = Object.freeze({
  draft: ['scheduled', 'active', 'archived'],
  scheduled: ['draft', 'active', 'paused', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'completed', 'archived'],
  completed: ['active', 'archived'],
  archived: ['draft', 'active', 'paused'],
})
export const campaignStatuses = Object.keys(campaignTransitions)
