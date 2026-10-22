import { hasPermission } from '../../config/permissions.js'
import { decrypt } from '../../lib/crypto.js'
import { ApiError } from '../../utils/ApiError.js'
import { connectionFor } from './connection.js'
import { graph } from './graph.js'

export const isMetaCampaign = (campaign) => campaign.externalPlatform === 'facebook' && Boolean(campaign.externalCampaignId)

// Configured on/off status and actual delivery are separate Meta concepts.
export function metaConfiguredStatus(remote) {
  return { ACTIVE: 'active', PAUSED: 'paused', ARCHIVED: 'archived', DELETED: 'archived' }[remote.status ?? remote.configured_status ?? remote.effective_status] ?? 'draft'
}

export function presentMetaState(remote) {
  return {
    configuredStatus: remote.status ?? remote.configured_status ?? null,
    effectiveStatus: remote.effective_status ?? null,
    startsAt: remote.start_time ?? null,
    stopsAt: remote.stop_time ?? null,
  }
}

async function metaAccess(ctx, campaign) {
  if (!hasPermission(ctx.permissions, 'settings.workspace.manage')) throw ApiError.forbidden('A workspace owner or integration administrator must manage Meta campaign delivery.')
  if (!isMetaCampaign(campaign) || !/^\d{1,40}$/.test(campaign.externalCampaignId) || !/^act_\d{1,40}$/.test(campaign.externalAccountId ?? ''))
    throw ApiError.badRequest('Sync this campaign from its Meta ad account before managing its status.')
  const connection = await connectionFor(ctx)
  return decrypt(connection.tokenEnc)
}

async function read(campaign, token) {
  const remote = await graph(campaign.externalCampaignId, token, { fields: 'id,account_id,status,effective_status,start_time,stop_time' })
  if (remote.id !== campaign.externalCampaignId || `act_${remote.account_id}` !== campaign.externalAccountId)
    throw ApiError.forbidden('Meta returned a campaign outside the linked ad account. Sync the correct account before retrying.')
  return remote
}

export async function readMetaCampaign(ctx, campaign) {
  return read(campaign, await metaAccess(ctx, campaign))
}

export async function changeMetaCampaignStatus(ctx, campaign, status) {
  if (!['active', 'paused'].includes(status)) throw ApiError.badRequest('Linked Meta campaigns support Enable and Pause here. Manage other lifecycle changes in Meta Ads Manager.')
  const token = await metaAccess(ctx, campaign)
  const before = await read(campaign, token)
  if (['ARCHIVED', 'DELETED'].includes(before.status)) throw ApiError.badRequest('This Meta campaign is archived or deleted. Manage it in Meta Ads Manager.')
  if (status === 'active' && before.stop_time && new Date(before.stop_time) <= new Date())
    throw ApiError.badRequest('This campaign’s Meta schedule has ended. Update its campaign/ad set schedule in Meta Ads Manager, then sync before enabling it.')
  const requested = status === 'active' ? 'ACTIVE' : 'PAUSED'
  if (before.status === requested) return before
  const result = await graph(campaign.externalCampaignId, token, { status: requested }, 'POST')
  if (result.success !== true) throw new ApiError(502, 'Meta did not confirm this status change. Refresh the Meta status before retrying.', { code: 'META_STATUS_UNCONFIRMED' })
  const after = await read(campaign, token)
  if (after.status !== requested) throw new ApiError(409, 'Meta has not confirmed the requested status yet. Refresh the Meta status before retrying.', { code: 'META_STATUS_UNCONFIRMED' })
  return after
}
