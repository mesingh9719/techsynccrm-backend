// Run with --apply only after all runtimes have the current key and all previous keys.
// Default mode reports counts. Never prints credentials or encryption keys.
const { prisma } = await import('../src/db/prisma.js')
const { provider } = await import('../src/integrations/gmail/provider.js')
const { settings } = await import('../src/integrations/gmail/config.js')
const { keyring } = await import('../src/email-integration/crypto/tokenCrypto.js')
const apply = process.argv.includes('--apply')
const currentVersion = settings().kmsKey || `local:${keyring().version}`
try {
  let accounts = 0, revocations = 0
  for (const model of ['gmailAccount', 'emailTokenRevocation']) {
    let cursor
    for (;;) {
      const rows = await prisma[model].findMany({ where: { keyVersion: { not: currentVersion }, wrappedKey: { not: 'erased' } }, orderBy: { id: 'asc' }, take: 100, ...(cursor && { cursor: { id: cursor }, skip: 1 }) })
      if (!rows.length) break
      for (const row of rows) {
        if (apply) {
          const key = await provider.unwrapKey(row), wrapped = await provider.wrapKey(key)
          // CAS: a concurrent reconnect/rotation must not be overwritten.
          await prisma[model].updateMany({ where: { id: row.id, organizationId: row.organizationId, wrappedKey: row.wrappedKey, keyVersion: row.keyVersion }, data: wrapped })
          key.fill(0)
        }
        if (model === 'gmailAccount') accounts++; else revocations++
      }
      cursor = rows.at(-1).id
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', accounts, revocations }))
} finally { await prisma.$disconnect() }
