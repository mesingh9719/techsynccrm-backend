/**
 * Build check for the plain-JS backend: after `prisma7 generate` (see package.json), verify
 * that every source file parses (node --check). Fails the build on the first syntax error.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const roots = ['src', 'scripts']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (full.includes(`${path.sep}generated`)) continue // Prisma Client output (TypeScript, generated)
    if (statSync(full).isDirectory()) walk(full)
    else if (full.endsWith('.js')) files.push(full)
  }
}
roots.forEach(walk)

for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
console.log(`[build] syntax OK: ${files.length} files`)
