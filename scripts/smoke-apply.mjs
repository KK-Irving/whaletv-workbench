/**
 * Apply-level smoke test: materialize the client bundle and run apply()
 * against a mock ClientContext whose slots registry records the registration
 * options. Verifies the slot contract that bit us once:
 *   - injections target exactly the two declared slots
 *     ('sidebar.footer.action', 'shell.overlay')
 *   - each register carries name = the declared slot key and a unique id
 *     (both are `kind: 'list'` — list slots require options.id)
 *   - the sidebar entry and panel share one store handle.
 *
 * The settings card is gone since 0.7.1: preferences live on the dsh ≥ 0.1.7
 * auto-generated config page (Host Config schema projection).
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
const workspaces = undefined
const uiWorkspace = { startSession: () => {} }
const remote = { session: { openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) } }
const ctx = { slots, uiWorkspace, remote }

const handoffs = []
globalThis.window = globalThis
globalThis.__ModuleLoader__ = { load: (handoff) => { handoffs.push(handoff) } }
const mockRequire = (specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') {
    return { jsx: () => null, jsxs: () => null, Fragment: null, createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, useMemo: (f) => f(), useRef: () => ({ current: null }) }
  }
  if (specifier === '@deepseek-ai/dsh-client-store') {
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

// sidebar.footer.action and shell.overlay are declared `kind: 'list'` by
// their owning packages (ui-sidebar and ui-layout), so both registrations
// carry `id`. The plugin's preferences live on the dsh ≥ 0.1.7
// auto-generated config page — no settings slot here anymore.
const listExpected = [
  ['sidebar.footer.action', 'whaletv-workbench.sidebar'],
  ['shell.overlay', 'whaletv-workbench.panel'],
]

const injectKeys = [...injections].sort()
const expectedSlots = listExpected.map(([s]) => s).sort()
if (injectKeys.join(',') !== expectedSlots.join(',')) {
  throw new Error(`unexpected injections: got [${injectKeys.join(', ')}], want [${expectedSlots.join(', ')}]`)
}
for (const [slotName, entryId] of listExpected) {
  const hit = registrations.find(r => r.options.name === slotName)
  if (hit === undefined) throw new Error(`no registration for declared list slot "${slotName}"`)
  if (hit.options.id !== entryId) throw new Error(`entry id for "${slotName}" is "${hit.options.id}", expected "${entryId}"`)
  if (typeof hit.options.inject !== 'function') throw new Error(`registration for "${slotName}" lacks the inject factory`)
}
// Both registrations share one store handle.
const panelHandles = new Set(registrations.map(r => r.options.store))
if (panelHandles.size !== 1) throw new Error(`expected one shared store handle across registrations, got ${panelHandles.size}`)

console.log(`smoke-apply: OK — list slots=[${listExpected.map(([s, id]) => `${s}(id=${id})`).join(', ')}], shared store across registrations`)
