/**
 * Client-bundle smoke test: execute lib/client.js against a minimal
 * window.__ModuleLoader__ shim (the browser's frozen module table) and verify
 * the handoff registers with the right id and the factory materializes
 * apply/inject exports. Catches script-level breakage (syntax, wrapper
 * format, wrong external specifiers) without a browser.
 *
 * Usage: node scripts/smoke-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'lib', 'client.js')

/** Stub one external platform module (module-table answer). */
function stub() {
  return { __esModule: true, apply() {}, inject: [], writeClipboard: async () => {}, createWorkspaceViewStore() {}, Button() {}, Input() {}, FishLogo() {}, default: {} }
}

const handoffs = []
globalThis.window = globalThis
globalThis.__ModuleLoader__ = {
  load: (handoff) => { handoffs.push(handoff) },
}
// Materialization-time require stub: any registered platform module resolves.
const require = (specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') {
    return { jsx: () => null, jsxs: () => null, Fragment: null, createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() }
  }
  return stub()
}

const code = readFileSync(BUNDLE).toString('utf8')
// The bundle only registers; strip the sourceMappingURL before eval.
const body = code.replace(/\/\/# sourceMappingURL=.*$/m, '')
try {
  // eslint-disable-next-line no-eval -- smoke test executes the artifact under test
  (0, eval)(body)
} catch (error) {
  console.error('smoke-client: bundle execution failed:', error)
  process.exit(1)
}

if (handoffs.length !== 1) throw new Error(`expected 1 handoff, got ${handoffs.length}`)
const handoff = handoffs[0]
if (handoff.id !== 'whaletv-workbench') throw new Error(`wrong handoff id: ${handoff.id}`)
const exports = handoff.factory(require)
if (typeof exports.apply !== 'function') throw new Error('factory exports missing apply()')
if (!Array.isArray(exports.inject)) throw new Error('factory exports missing inject[]')
console.log(`smoke-client: OK — id=${handoff.id}, inject=[${exports.inject.join(', ')}], apply=${typeof exports.apply}`)
