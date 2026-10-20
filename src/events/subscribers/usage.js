import { subscribe } from '../registry.js'
import { refreshUsage } from '../../services/entitlements.service.js'

/**
 * Keeps the organization_usage display cache (Settings → Plan) current. A full recount is
 * naturally idempotent, so re-delivered events are harmless. Modules that add counted records
 * (leads, contacts, pipelines) add their event types here.
 */
const PATTERNS = [
  'member.*',
  'file.uploaded',
  'organization.created',
  'organization.plan_changed',
  'contact.created',
  'contact.deleted',
  'contact.restored',
  'contact.merged',
  'lead.created',
  'lead.deleted',
  'lead.restored',
  'lead.converted',
]

subscribe('usage', PATTERNS, async (event) => {
  if (event.organizationId) await refreshUsage(event.organizationId)
})
