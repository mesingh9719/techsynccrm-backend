/**
 * Lead scoring v1 (M08, decision D7) — a pure function so it's cheap to recompute and easy to test.
 *
 * Fit (max 50): source weight + phone 10 + email 5 + company 5 + budget 10, capped at 50.
 * Engagement (max 50): inbound message in the last 7 days +15; completed calls/meetings in the last
 *   14 days +5 each (max 20); status `qualified` +15.
 * Decay: −5 per full 7 days without activity (score never below 0).
 * Converted, lost and junk leads keep their last score (frozen).
 */

export const FROZEN_STATUSES = ['converted', 'lost', 'junk']
const WEEK_MS = 7 * 86_400_000

/**
 * @param {{ status: string, primaryPhoneE164?: string|null, phones?: any[], primaryEmail?: string|null, companyName?: string|null, budgetMinor?: bigint|number|null, lastActivityAt: Date }} lead
 * @param {{ sourceWeight?: number, lastInboundAt?: Date|null, completedTouches14d?: number, now?: Date }} signals
 *   `lastInboundAt` / `completedTouches14d` come from activities and messages (M10/M19); 0/null until then.
 * @returns {{ score: number, breakdown: { fit: object, engagement: object, decay: number, total: number } }}
 */
export function computeLeadScore(lead, { sourceWeight = 5, lastInboundAt = null, completedTouches14d = 0, now = new Date() } = {}) {
  const hasPhone = Boolean(lead.primaryPhoneE164 || lead.phones?.length)
  const fitParts = {
    source: sourceWeight,
    phone: hasPhone ? 10 : 0,
    email: lead.primaryEmail ? 5 : 0,
    company: lead.companyName ? 5 : 0,
    budget: lead.budgetMinor !== null && lead.budgetMinor !== undefined && Number(lead.budgetMinor) > 0 ? 10 : 0,
  }
  const fit = Math.min(50, Object.values(fitParts).reduce((a, b) => a + b, 0))

  const engagementParts = {
    recentInbound: lastInboundAt && now >= lastInboundAt && now - lastInboundAt <= WEEK_MS ? 15 : 0,
    touches: Math.min(20, Math.max(0, completedTouches14d) * 5),
    qualified: lead.status === 'qualified' ? 15 : 0,
  }
  const engagement = Math.min(50, Object.values(engagementParts).reduce((a, b) => a + b, 0))

  const idleWeeks = Math.max(0, Math.floor((now - new Date(lead.lastActivityAt ?? lead.createdAt ?? now)) / WEEK_MS))
  const decay = idleWeeks * 5
  const total = Math.max(0, Math.min(100, fit + engagement - decay))

  return {
    score: total,
    breakdown: { fit: { ...fitParts, total: fit }, engagement: { ...engagementParts, total: engagement }, decay, total },
  }
}
