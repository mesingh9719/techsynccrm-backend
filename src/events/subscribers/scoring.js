import { subscribe } from '../registry.js'
import { rescoreLead } from '../../services/lead.service.js'

/**
 * Lead scoring (M08). Lead writes already rescore synchronously; this subscriber reacts to
 * engagement from other modules — activities (M10) and messages (M19) — whose events carry the
 * lead in `payload.leadId` or as the entity. Recomputing is idempotent, so redelivery is harmless.
 */
subscribe('scoring', ['activity.*', 'message.*', 'lead.repeat_enquiry'], async (event) => {
  const leadId = event.entityType === 'lead' ? event.entityId : event.payload?.leadId
  if (leadId) await rescoreLead(leadId)
})
