/**
 * Plans and what each one includes — the single source of truth for limits and feature flags
 * (docs/modules/M06). The marketing copy in frontend/src/data/pricing.json must agree with these
 * numbers; change both together.
 *
 * Limits are per workspace. `Infinity` means unlimited (serialised as null in JSON).
 * `customFields` is per entity type. `storageGb` for Enterprise is contracted per customer.
 */

export const PLAN_ORDER = /** @type {const} */ (['starter', 'growth', 'business', 'enterprise'])

/** Plans that start with a free trial at signup. */
export const TRIAL_PLANS = ['growth', 'business']
export const TRIAL_DAYS = 14
/** A staff extension adds at most this many days. */
export const MAX_TRIAL_EXTENSION_DAYS = 14

const STARTER_FEATURES = ['core', 'webforms', 'import', 'tasks', 'basicDashboards', 'twoFactor']
const GROWTH_FEATURES = [
  ...STARTER_FEATURES,
  'marketplaceSync',
  'whatsapp',
  'emailSync',
  'automation',
  'quotes',
  'standardReports',
  'scheduledReports',
  'basicRbac',
]
const BUSINESS_FEATURES = [
  ...GROWTH_FEATURES,
  'sequences',
  'aiAssistant',
  'customReports',
  'forecasting',
  'approvals',
  'territories',
  'accountingSync',
  'advancedRbac',
  'require2fa',
  'callRecording',
]
const ENTERPRISE_FEATURES = [...BUSINESS_FEATURES, 'sso', 'auditLogUi', 'sandbox', 'dataResidency']

/**
 * @typedef {'users' | 'records' | 'pipelines' | 'customFields' | 'workflowRules' | 'webForms' | 'storageGb'} LimitKey
 * @typedef {{ id: string, name: string, trial: boolean, limits: Record<LimitKey, number>, features: string[] }} PlanDefinition
 */

/** @type {Record<string, PlanDefinition>} */
export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    trial: false,
    limits: { users: 2, records: 1000, pipelines: 1, customFields: 10, workflowRules: 0, webForms: 1, storageGb: 1 },
    features: STARTER_FEATURES,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    trial: true,
    limits: { users: 25, records: Infinity, pipelines: 5, customFields: 50, workflowRules: 25, webForms: 10, storageGb: 10 },
    features: GROWTH_FEATURES,
  },
  business: {
    id: 'business',
    name: 'Business',
    trial: true,
    limits: { users: 200, records: Infinity, pipelines: Infinity, customFields: Infinity, workflowRules: Infinity, webForms: Infinity, storageGb: 50 },
    features: BUSINESS_FEATURES,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    trial: false,
    limits: { users: Infinity, records: Infinity, pipelines: Infinity, customFields: Infinity, workflowRules: Infinity, webForms: Infinity, storageGb: Infinity },
    features: ENTERPRISE_FEATURES,
  },
}

export const LIMIT_KEYS = /** @type {LimitKey[]} */ (Object.keys(PLANS.starter.limits))
export const ALL_FEATURES = ENTERPRISE_FEATURES

/** @param {string} plan */
export function planDefinition(plan) {
  return PLANS[plan] ?? PLANS.starter
}

export function planName(plan) {
  return planDefinition(plan).name
}

/** The cheapest plan that includes `feature`, or null if no plan does. */
export function requiredPlanFor(feature) {
  return PLAN_ORDER.find((id) => PLANS[id].features.includes(feature)) ?? null
}

/** The cheapest plan whose `limit` is above `atLeast` (used to suggest an upgrade). */
export function planWithLimitAbove(limit, atLeast) {
  return PLAN_ORDER.find((id) => PLANS[id].limits[limit] > atLeast) ?? null
}

export function planHasFeature(plan, feature) {
  return planDefinition(plan).features.includes(feature)
}

/** Plan ids that include `feature` (for database filters). */
export function plansWithFeature(feature) {
  return PLAN_ORDER.filter((id) => PLANS[id].features.includes(feature))
}

const finite = (n) => (Number.isFinite(n) ? n : null)

/**
 * JSON-safe entitlements for a plan: unlimited → null. `upgrades` maps each feature the plan lacks
 * to the cheapest plan that has it, so the UI can label locked items without a second request.
 */
export function presentEntitlements(plan) {
  const def = planDefinition(plan)
  const limits = Object.fromEntries(Object.entries(def.limits).map(([k, v]) => [k, finite(v)]))
  const upgrades = Object.fromEntries(ALL_FEATURES.filter((f) => !def.features.includes(f)).map((f) => [f, requiredPlanFor(f)]))
  return { limits, features: def.features, upgrades }
}

/** Public catalogue (GET /api/meta/plans). */
export function planCatalogue() {
  return PLAN_ORDER.map((id) => {
    const def = PLANS[id]
    return {
      id,
      name: def.name,
      trialDays: def.trial ? TRIAL_DAYS : 0,
      limits: Object.fromEntries(Object.entries(def.limits).map(([k, v]) => [k, finite(v)])),
      features: def.features,
    }
  })
}
