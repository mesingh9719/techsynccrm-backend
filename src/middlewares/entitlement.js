import { assertFeature } from '../services/entitlements.service.js'

/**
 * Use after requireOrg. Allows the request only if the workspace's plan includes `feature`
 * (config/plans.js); otherwise 403 FEATURE_NOT_IN_PLAN { feature, requiredPlan }.
 *
 *   router.use(requireOrg, requireFeature('automation'))
 */
export function requireFeature(feature) {
  return (req, _res, next) => {
    try {
      assertFeature(req.ctx, feature)
      next()
    } catch (err) {
      next(err)
    }
  }
}
