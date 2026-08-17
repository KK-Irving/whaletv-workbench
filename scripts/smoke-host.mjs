/**
 * Host-half smoke test: load the built lib/index.js against a mock Context
 * and drive the prefix route dispatcher end-to-end.
 *
 *   - GET  /state              → 200 with a valid WorkbenchState
 *   - POST /config valid       → 200, sanitized values persisted (trimmed)
 *   - POST /config duplicates  → 400 (no unhandled rejection escaping)
 *   - GET  /config             → 405 (POST-only)
 *   - GET  /state (re-read)    → the saved config
 *   - GET  /skills             → 200 with the mocked catalog
 *   - GET  /nonsense           → 404 (sub-path fallthrough)
 *
 * Uses a temp $DSH_HOME so the smoke run never touches the user's real
 * workbench state; the temp dir is removed on exit.
 *
 * Usage: node scripts/smoke-host.mjs   (requires a built lib/index.js)
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const TMP_DSH_HOME = mkdtempSync(join(os.tmpdir(), 'dsh-workbench-smoke-'))
process.env.DSH_HOME = TMP_DSH_HOME

let handler
try {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

  // Mock the subset of Context the Host half touches during apply()
  // and route handling. `inject(services, cb)` is a cordis primitive
  // installSettingsSection uses; noop it — the settings namespace has no
  // route-facing consequences beyond feeding source() with the initial entry.
  const registered = []
  const ctx = {
    effect: (cb) => { const dispose = cb(); return typeof dispose === 'function' ? dispose : () => {} },
    inject: () => () => {},
    webServer: {
      register: (spec) => { registered.push(spec); return () => {} },
    },
    clientModules: { rebuilt: () => {} },
    skills: {
      snapshot: async () => ({ skills: [], complete: true }),
    },
    agents: {
      get: () => undefined,
      currentInitiator: () => undefined,
    },
    // Settings.update is called by the /skills/install and /skills/remove
    // routes to keep the installed-skills registry in sync; a noop suffices
    // here — the smoke test does not exercise those write routes.
    settings: {
      update: async () => {},
    },
  }
  mod.apply(ctx, { gitRemote: '', customSkillDirs: [], installedSkills: [] })

  if (registered.length !== 1) throw new Error(`expected 1 route registration, got ${registered.length}`)
  const [route] = registered
  if (route.kind !== 'prefix' || route.path !== '/whaletv/workbench') {
    throw new Error(`unexpected route shape: ${JSON.stringify({ kind: route.kind, path: route.path })}`)
  }
  handler = route.handler

  /** Drive one request through the prefix handler and resolve its JSON response. */
  function request(method, subPath, body) {
    return new Promise((resolve) => {
      const req = Object.assign(new EventEmitter(), {
        method,
        url: `/whaletv/workbench${subPath}`,
        destroy() {},
      })
      const res = {
        status: 0,
        writeHead(status) { this.status = status },
        end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }) },
      }
      handler(req, res)
      if (body !== undefined) req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }

  // 1. State pull works.
  const state0 = await request('GET', '/state')
  if (state0.status !== 200 || state0.body.ok !== true) {
    throw new Error(`initial state failed: ${state0.status} ${JSON.stringify(state0.body)}`)
  }

  // 2. Valid config save → 200, url trimmed.
  const save = await request('POST', '/config', JSON.stringify({
    groups: [
      { id: 'g1', title: '测试分组', items: [{ id: 'i1', title: '测试条目', description: 'd', url: '  https://example.com ' }] },
    ],
  }))
  if (save.status !== 200 || save.body.ok !== true) {
    throw new Error(`valid save failed: ${save.status} ${JSON.stringify(save.body)}`)
  }

  // 3. Duplicate item ids → 400 with a readable error; must not crash the chain.
  const bad = await request('POST', '/config', JSON.stringify({
    groups: [{ id: 'g1', title: 'x', items: [{ id: 'dup', title: 'a' }, { id: 'dup', title: 'b' }] }],
  }))
  if (bad.status !== 400 || !String(bad.body.error).includes('重复')) {
    throw new Error(`duplicate-id save should 400: ${bad.status} ${JSON.stringify(bad.body)}`)
  }

  // 4. GET on POST-only route → 405.
  const getConfig = await request('GET', '/config')
  if (getConfig.status !== 405) {
    throw new Error(`GET on /config should 405: ${getConfig.status} ${JSON.stringify(getConfig.body)}`)
  }

  // 5. State read-back reflects the saved config.
  const state = await request('GET', '/state')
  if (state.status !== 200 || state.body.ok !== true || state.body.config.groups[0].title !== '测试分组') {
    throw new Error(`state read-back failed: ${state.status} ${JSON.stringify(state.body)}`)
  }

  // 6. Skills catalog projection round-trips.
  const skills = await request('GET', '/skills')
  if (skills.status !== 200 || skills.body.ok !== true || !Array.isArray(skills.body.skills)) {
    throw new Error(`/skills failed: ${skills.status} ${JSON.stringify(skills.body)}`)
  }

  // 7. Sub-path fallthrough is a 404, not a crash.
  const nonsense = await request('GET', '/nonsense')
  if (nonsense.status !== 404) {
    throw new Error(`unknown sub-path should 404: ${nonsense.status} ${JSON.stringify(nonsense.body)}`)
  }

  console.log('smoke-host: OK — prefix route dispatch (state/config/update/skills/session/followup), sanitize + persist, 405/404 boundaries')
} catch (error) {
  console.error('smoke-host: FAILED:', error)
  process.exitCode = 1
} finally {
  rmSync(TMP_DSH_HOME, { recursive: true, force: true })
}
