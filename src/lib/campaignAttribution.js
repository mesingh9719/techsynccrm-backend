/** Stable identifiers only: names and substring matches can attribute a lead twice. */
export async function resolveCampaignId(db, orgId, { utm, sourceDetail } = {}) {
  const campaignCode = String(utm?.utm_campaign ?? '')
    .trim()
    .toLowerCase()
  const providerId = String(utm?.campaign_id ?? utm?.campaign ?? '').trim()
  const code =
    campaignCode ||
    (!providerId
      ? String(sourceDetail ?? '')
          .trim()
          .toLowerCase()
      : '')
  if (!code && !providerId) return null
  const matches = await db.campaign.findMany({
    where: {
      organizationId: orgId,
      deletedAt: null,
      OR: [
        ...(code ? [{ code }] : []),
        ...(providerId
          ? [
              { externalPlatform: 'facebook', externalCampaignId: providerId },
              ...(/^[0-9a-f-]{36}$/i.test(providerId) ? [{ id: providerId }] : []),
            ]
          : []),
      ],
    },
    select: { id: true, code: true },
    take: 2,
  })
  // An explicit UTM code wins if a provider ID disagrees with it.
  return campaignCode
    ? (matches.find((campaign) => campaign.code === campaignCode)?.id ?? null)
    : matches.length === 1
      ? matches[0].id
      : null
}
