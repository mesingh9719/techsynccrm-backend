/**
 * Makes a value safe for a JSONB column: BigInt → Number (money in minor units is far below
 * 2^53), Date → ISO string, undefined dropped. Prisma rejects BigInt and Date inside Json inputs,
 * and audit/event payloads often carry raw record values (diffs, merge snapshots).
 */
export function toJsonValue(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v)))
}
