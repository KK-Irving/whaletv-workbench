/**
 * Apply-level smoke test: materialize the client bundle and run apply()
 * against a mock ClientContext whose slots registry records the registration
 * options. Verifies the slot contract that bit us once:
 *   - injections target exactly 'sidebar.footer.action' and 'shell.overlay'
 *   - each register carries name = the declared slot key and a unique id
 *     (list slots require options.id)
 *   - both registrations share one store handle
 * Usage: node scripts/smoke-apply.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'lib', 'client.js')

const code = readFileSync(BUNDLE).toString('utf8')
// The bundle only registers; strip the sourceMappingURL before eval.
const body = code.replace(/\/\/# sourceMappingURL=.*$/m, '')

const injections = []
const registrations = []
const slots = {
  inject: (key, callback) => {
    injections.push(key)
    callback() // declaration already live in the mock
    return () => {}
  },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const workspaces = { openPath: async () => {}, startSession: () => {} }
const ctx = { slots, workspaces }

const handoffs = []
globalThis.window = globalThis
globalThis.__ModuleLoader__ = { load: (handoff) => { handoffs.push(handoff) } }
const mockRequire = (specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') {
    return { jsx: () => null, jsxs: () => null, Fragment: null, createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f() }
  }
  if (specifier === '@deepseek-ai/dsh-client-runtime/client') {
    return { __esModule: true, defineStore: () => ({ spec: {}, create: () => ({ actions: {}, getSnapshot: () => ({}), subscribe: () => () => {}, store: {}, clearPersisted: () => {} }) }) }
  }
  return { __esModule: true, writeClipboard: async () => {}, Button() {}, Input() {} }
}

try {
  // eslint-disable-next-line no-eval -- smoke test executes the artifact under test
  (0, eval)(body)
} catch (error) {
  console.error('smoke-apply: bundle execution failed:', error)
  process.exit(1)
}

if (handoffs.length !== 1) throw new Error(`expected 1 handoff, got ${handoffs.length}`)
const exports = handoffs[0].factory(mockRequire)
exports.apply(ctx)

const expected = [
  ['sidebar.footer.action', 'whaletv-workbench.sidebar'],
  ['shell.overlay', 'whaletv-workbench.panel'],
]
const injectKeys = [...injections].sort()
if (injectKeys.join(',') !== ['shell.overlay', 'sidebar.footer.action'].join(',')) {
  throw new Error(`unexpected injections: ${injectKeys.join(', ')}`)
}
for (const [slotName, entryId] of expected) {
  const hit = registrations.find(r => r.options.name === slotName)
  if (hit === undefined) throw new Error(`no registration for declared slot "${slotName}"`)
  if (hit.options.id !== entryId) throw new Error(`entry id for "${slotName}" is "${hit.options.id}", expected "${entryId}"`)
  if (typeof hit.options.inject !== 'function') throw new Error(`registration for "${slotName}" lacks the inject factory`)
}
const storeHandles = new Set(registrations.map(r => r.options.store))
if (storeHandles.size !== 1) throw new Error(`expected one shared store handle, got ${storeHandles.size}`)
console.log(`smoke-apply: OK — slots=[${expected.map(([s, id]) => `${s}(id=${id})`).join(', ')}], shared store, inject factories present`)
