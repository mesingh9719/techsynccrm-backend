import { describe, expect, it } from 'vitest'
import { buildPage, parseListQuery } from '../../src/lib/pagination.js'

const options = { sortable: { createdAt: 'date', name: 'string' }, defaultSort: '-createdAt' }
const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, name: `n${i}`, createdAt: new Date(Date.UTC(2026, 9, 10 - i)) }))

describe('pagination', () => {
  it('defaults to newest first with a look-ahead row', () => {
    const page = parseListQuery({}, options)
    expect(page).toMatchObject({ limit: 50, take: 51, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], cursorWhere: {} })
  })

  it('caps the limit', () => {
    expect(parseListQuery({ limit: 1000 }, options).limit).toBe(100)
  })

  it('builds a cursor that resumes after the last row', () => {
    const first = parseListQuery({ limit: 3 }, options)
    const { items, nextCursor } = buildPage(rows, first)
    expect(items).toHaveLength(3)
    expect(nextCursor).toBeTruthy()

    const second = parseListQuery({ limit: 3, cursor: nextCursor }, options)
    const last = rows[2]
    expect(second.cursorWhere).toEqual({
      OR: [{ createdAt: { lt: last.createdAt } }, { createdAt: last.createdAt, id: { lt: last.id } }],
    })
  })

  it('returns no cursor on the last page', () => {
    expect(buildPage(rows.slice(0, 2), parseListQuery({ limit: 3 }, options)).nextCursor).toBeNull()
  })

  it('supports ascending sorts', () => {
    expect(parseListQuery({ sort: 'name' }, options).orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }])
  })

  it('rejects unknown sorts, bad cursors and cursors from another sort', () => {
    expect(() => parseListQuery({ sort: 'password' }, options)).toThrow(/Validation failed/)
    expect(() => parseListQuery({ cursor: 'nope' }, options)).toThrow(/Invalid cursor/)
    const { nextCursor } = buildPage(rows, parseListQuery({ limit: 1 }, options))
    expect(() => parseListQuery({ cursor: nextCursor, sort: 'name' }, options)).toThrow(/sort order/)
  })
})
