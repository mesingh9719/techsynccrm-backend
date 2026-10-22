/**
 * Build check for the plain-JS backend: after `npm run db:generate` (see package.json), verify
 * that every source file parses (node --check). Fails the build on the first syntax error.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// Syntax checks do not resolve imports. Load the generated client too so a missing or
// unusable client fails the build before the API is deployed. This does not connect to DB.
const { PrismaClient, Prisma } = await import('../src/generated/prisma/client.js')
if (typeof PrismaClient !== 'function' || !Prisma?.DbNull) {
  throw new Error('Generated Prisma client is missing its runtime exports')
}
console.log('[build] generated Prisma client imports OK')

const roots = ['src', 'scripts']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (full.includes(`${path.sep}generated`)) continue // Generated client is checked by the import above.
    if (statSync(full).isDirectory()) walk(full)
    else if (full.endsWith('.js')) files.push(full)
  }
}
roots.forEach(walk)

for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
console.log(`[build] syntax OK: ${files.length} files`)
