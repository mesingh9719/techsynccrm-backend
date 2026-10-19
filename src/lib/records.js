import { prisma } from '../db/prisma.js'
import { ApiError } from '../utils/ApiError.js'
import { toJsonValue } from './json.js'
import { normalizePhone } from './phone.js'
import { DEFAULT_TZ, parseIsoDate, startOfDayInTz, zonedTimeToUtc } from './time.js'

/**
 * Helpers shared by CRM record services (contacts, companies, leads; deals from M09): contact
 * points, display names, optimistic concurrency, soft delete and owner names.
 */

export const MAX_CONTACT_POINTS = 5
/** Merges may union more than the input limit; nothing is dropped up to this many. */
export const MAX_MERGED_CONTACT_POINTS = 10
export const RESTORE_WINDOW_DAYS = 30

export const validationError = (fields) => new ApiError(400, 'Validation failed', { code: 'VALIDATION_ERROR', details: { fields } })

/**
 * Emails as typed → stored shape `[{ value, label, primary }]` (lowercased, de-duplicated, exactly
 * one primary when there are any).
 * @param {{ value: string, label?: string|null, primary?: boolean }[]} input
 */
export function normalizeEmails(input = []) {
  const seen = new Set()
  const out = []
  for (const item of input) {
    const value = item.value?.trim().toLowerCase()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push({ value, label: item.label || null, primary: Boolean(item.primary) })
  }
  return withOnePrimary(out)
}

/**
 * Phones as typed → `[{ e164, raw, label, primary, whatsapp }]`. A number that can't be normalised
 * keeps `raw` with `e164: null`, so it's shown but never matched as a duplicate.
 * @param {{ raw?: string, value?: string, label?: string|null, primary?: boolean, whatsapp?: boolean }[]} input
 */
export function normalizePhones(input = [], defaultCountry = 'IN') {
  const seen = new Set()
  const out = []
  for (const item of input) {
    const { e164, raw } = normalizePhone(item.raw ?? item.value, defaultCountry)
    if (!raw) continue
    const key = e164 ?? `raw:${raw}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ e164, raw, label: item.label || null, primary: Boolean(item.primary), whatsapp: Boolean(item.whatsapp) })
  }
  return withOnePrimary(out)
}

function withOnePrimary(list) {
  if (!list.length) return list
  const first = Math.max(0, list.findIndex((x) => x.primary))
  return list.map((x, i) => ({ ...x, primary: i === first }))
}

export const primaryOf = (list) => list.find((x) => x.primary) ?? list[0] ?? null

/** Values for the indexed primary columns. */
export function primaryColumns(emails, phones) {
  return { primaryEmail: primaryOf(emails)?.value ?? null, primaryPhoneE164: phones.find((p) => p.primary && p.e164)?.e164 ?? phones.find((p) => p.e164)?.e164 ?? null }
}

/** "Ritika Sharma", or the primary email / phone when there's no name. */
export function buildDisplayName({ firstName, lastName }, emails = [], phones = []) {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim()
  if (name) return name.slice(0, 200)
  return primaryOf(emails)?.value ?? primaryOf(phones)?.raw ?? 'Unnamed'
}

/**
 * A phone-looking search ("98450 12345", "+91 98450…") → what to match in the phone lookup tables:
 * the full E.164 when it normalises, otherwise the digits (for partial matches). null if it isn't a phone.
 */
export function phoneSearchTerm(q, defaultCountry = 'IN') {
  const digits = q.replace(/[^\d]/g, '')
  if (digits.length < 5 || /[a-z@]/i.test(q)) return null
  const { e164 } = normalizePhone(q, defaultCountry)
  return e164 ? { equals: e164 } : { contains: digits.replace(/^0+/, '') }
}

/**
 * Optimistic concurrency (If-Match / expectedUpdatedAt): 409 STALE_UPDATE with the current record
 * when someone else saved since the client loaded it. Skipped when the client sent nothing.
 */
export function assertNotStale(current, expectedUpdatedAt, present = (r) => r) {
  if (!expectedUpdatedAt) return
  const expected = new Date(expectedUpdatedAt)
  if (Number.isNaN(expected.getTime()) || expected.getTime() !== current.updatedAt.getTime()) {
    throw new ApiError(409, 'This record was changed by someone else. Review the latest version and try again.', {
      code: 'STALE_UPDATE',
      details: { current: toJsonValue(present(current)) },
    })
  }
}

export function assertRestorable(record) {
  if (!record.deletedAt) throw new ApiError(400, 'This record isn’t deleted.', { code: 'NOT_DELETED' })
  if (record.mergedIntoId) throw new ApiError(400, 'This record was merged into another one and can’t be restored.', { code: 'MERGED' })
  if (Date.now() - record.deletedAt.getTime() > RESTORE_WINDOW_DAYS * 86_400_000) {
    throw new ApiError(400, `Deleted records can only be restored within ${RESTORE_WINDOW_DAYS} days.`, { code: 'RESTORE_EXPIRED' })
  }
}

/** Owner summaries for a page of records: Map<userId, { id, fullName, email }>. */
export async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true, avatarFileId: true } })
  return new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName, email: u.email }]))
}

/**
 * Who may be made a record's owner by this caller:
 * - yourself, always; nobody (unassigned) or anyone else needs `records.assign`;
 * - with only "team" assign scope, yourself or someone in a team you manage;
 * - the owner must be an active member of the workspace.
 * System callers (connectors, jobs) skip the permission part.
 */
export async function assertAssignableOwner(ctx, ownerId, db = prisma) {
  if (ctx.actorType !== 'system' && ownerId !== ctx.userId) {
    const perms = ctx.permissions ?? []
    if (!perms.includes('records.assign.all')) {
      const team = perms.includes('records.assign.team')
      if (!team || (ownerId && !(ctx.managedUserIds ?? []).includes(ownerId))) {
        throw new ApiError(403, team ? 'You can only assign records to members of teams you manage.' : 'You don’t have permission to assign records to others.', { code: 'FORBIDDEN' })
      }
    }
  }
  if (!ownerId) return
  const member = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: ctx.orgId, userId: ownerId } },
    select: { status: true },
  })
  if (member?.status !== 'active') throw validationError({ ownerId: 'Choose an active member of this workspace' })
}

/** BigInt → Number for JSON (money in minor units, sizes). */
export const bigToNumber = (v) => (v === null || v === undefined ? null : Number(v))

/** Splits "a,b,c" (query params) into a clean list. */
export const listParam = (value) => (value ? String(value).split(',').map((v) => v.trim()).filter(Boolean) : [])

/** ownerId filter: "me", "none" and ids, comma-separated. */
export function ownerFilter(ctx, value) {
  const parts = listParam(value)
  if (!parts.length) return {}
  const ids = parts.filter((p) => p !== 'none').map((p) => (p === 'me' ? ctx.userId : p))
  const wantsNone = parts.includes('none')
  if (wantsNone && ids.length) return { OR: [{ ownerId: null }, { ownerId: { in: ids } }] }
  if (wantsNone) return { ownerId: null }
  return { ownerId: { in: ids } }
}

/**
 * createdFrom/createdTo → Prisma range. Plain dates ("2026-10-19") are whole days in the workspace
 * time zone; full ISO instants are used as given.
 */
export function dateRange(from, to, tz = DEFAULT_TZ) {
  if (!from && !to) return undefined
  const dayStart = (value) => {
    const d = parseIsoDate(value)
    return d ? zonedTimeToUtc(d, tz) : null
  }
  const gte = from ? (dayStart(from) ?? new Date(from)) : null
  let lte = null
  if (to) {
    const start = dayStart(to)
    lte = start ? new Date(startOfDayInTz(new Date(start.getTime() + 36 * 3600_000), tz).getTime() - 1) : new Date(to)
  }
  return { ...(gte && { gte }), ...(lte && { lte }) }
}
