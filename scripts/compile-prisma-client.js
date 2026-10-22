import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Prisma emits TypeScript. Publish JavaScript beside it so plain-JS application
// imports survive Vercel's tracing and TypeScript file renaming. The generator's
// importFileExtension = "js" keeps the entire generated runtime graph on .js.
const root = fileURLToPath(new URL('../src/generated/prisma/', import.meta.url))
let count = 0

function compile(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) compile(filename)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const source = readFileSync(filename, 'utf8')
      const code = stripTypeScriptTypes(source, { mode: 'strip' })
      writeFileSync(filename.slice(0, -3) + '.js', code)
      count++
    }
  }
}

compile(root)
if (!count) throw new Error('No generated Prisma TypeScript files found to compile')
console.log(`[prisma] compiled ${count} client files to JavaScript`)
