/** Compile the single shared import implementation for the independently deployed JS API.
 * This emits JavaScript only; it does not type-check or run tests.
 * Frontend consumes the source directly; backend commits the generated runtime alongside it.
 */
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const ts = require('typescript')
const source = await readFile(new URL('../../frontend/src/lib/importCore.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } })
await writeFile(new URL('../src/lib/importCore.js', import.meta.url), '// Generated from frontend/src/lib/importCore.ts by npm run import:sync. Edit the source, then regenerate.\n' + outputText)
console.log('Emitted shared import core for the backend (no tests or type checking).')
