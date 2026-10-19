import { z } from 'zod'
import { ApiError } from '../utils/ApiError.js'

/**
 * Cursor pagination for every list endpoint:
 *   GET /api/things?limit=50&cursor=<opaque>&sort=-createdAt  →  { items, nextCursor }
 *
 * The cursor encodes the last row's sort value and id, so pages stay stable while rows are added.
 * Usage in a service:
 *
 *   const page = parseListQuery(query, { sortable: { createdAt: 'date', name: 'string' }, defaultSort: '-createdAt' })
 *   const rows = await prisma.thing.findMany({ where: { ...filters, ...page.cursorWhere }, orderBy: page.orderBy, take: page.take })
 *   return buildPage(rows, page)
 */

export const MAX_LIMIT = 100
export const DEFAULT_LIMIT = 50

/** zod fragment for list query params; merge into a module's query schema. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(500).optional(),
  sort: z.string().max(60).optional(),
})

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

function decode(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (parsed && typeof parsed.id === 'string' && 'v' in parsed && typeof parsed.s === 'string') return parsed
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'Invalid cursor', { code: 'VALIDATION_ERROR', details: { fields: { cursor: 'Invalid cursor' } } })
}

const toSortValue = (value, type) => (value == null ? null : type === 'date' ? new Date(value).toISOString() : type === 'bigint' ? String(value) : value)
const fromSortValue = (value, type) => (value == null ? null : type === 'date' ? new Date(value) : type === 'bigint' ? BigInt(value) : value)

/**
 * @param {{ limit?: number, cursor?: string, sort?: string }} query
 * @param {{ sortable: Record<string, 'date' | 'string' | 'number' | 'bigint'>, defaultSort: string }} options
 */
export function parseListQuery(query, { sortable, defaultSort }) {
  const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const sort = query.sort || defaultSort
  const direction = sort.startsWith('-') ? 'desc' : 'asc'
  const field = sort.replace(/^[-+]/, '')
  const type = sortable[field]
  if (!type) {
    throw new ApiError(400, 'Validation failed', {
      code: 'VALIDATION_ERROR',
      details: { fields: { sort: `Sort by one of: ${Object.keys(sortable).join(', ')}` } },
    })
  }

  let cursorWhere = {}
  if (query.cursor) {
    const c = decode(query.cursor)
    // A cursor from a different sort order would silently skip or repeat rows.
    if (c.s !== sort) throw new ApiError(400, 'Cursor does not match the sort order', { code: 'VALIDATION_ERROR' })
    const value = fromSortValue(c.v, type)
    const cmp = direction === 'desc' ? 'lt' : 'gt'
    cursorWhere = { OR: [{ [field]: { [cmp]: value } }, { [field]: value, id: { [cmp]: c.id } }] }
  }

  return {
    limit,
    take: limit + 1,
    sort,
    field,
    type,
    cursorWhere,
    orderBy: [{ [field]: direction }, { id: direction }],
  }
}

/** Trims the look-ahead row and builds `{ items, nextCursor }`. */
export function buildPage(rows, { limit, sort, field, type }) {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last ? encode({ s: sort, v: toSortValue(last[field], type), id: last.id }) : null,
  }
}
