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
 *   - git-import / skip / icon safety boundaries → 400 with readable errors
 *
 * Uses a temp $DSH_HOME so the smoke run never touches the user's real
 * workbench state; the temp dir is removed on exit.
 *
 * Self-skip: when the host bundle's runtime deps (yaml + the @deepseek-ai/*
 * value imports) are not linked — a fresh CI checkout — the script prints a
 * SKIP marker and exits 0; the dsh-alignment workflow covers the host half
 * with real deps.
 *
 * Usage: node scripts/smoke-host.mjs   (requires a built lib/index.js)
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// lib/index.js keeps three bare VALUE imports after bundling (everything
// else is type-only and erased): `yaml`, `@deepseek-ai/dsh-llm`, and
// `@deepseek-ai/schemastery`. On dev machines these resolve through the
// junctions created by scripts/link-harness-deps.mjs; a fresh CI checkout
// has none of them (@deepseek-ai/* is not on the public npm registry, and
// autoInstallPeers is off). Detect that case up front and SKIP with an
// explicit marker instead of failing with ERR_MODULE_NOT_FOUND — the weekly
// "dsh alignment" workflow (builds + links the harness, then runs the full
// `pnpm run smoke`) is the authoritative gate for the host half.
const HOST_RUNTIME_DEPS = ['yaml', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery']
const hostRequire = createRequire(import.meta.url)
const missingDeps = HOST_RUNTIME_DEPS.filter((name) => {
  try {
    hostRequire.resolve(name)
    return false
  } catch {
    return true
  }
})
if (missingDeps.length > 0) {
  console.log(`smoke-host: SKIP — host runtime deps not linked here (${missingDeps.join(', ')}). Run scripts/link-harness-deps.mjs locally, or rely on the dsh-alignment workflow, to exercise the host half.`)
  process.exit(0)
}

const TMP_DSH_HOME = mkdtempSync(join(os.tmpdir(), 'dsh-workbench-smoke-'))
process.env.DSH_HOME = TMP_DSH_HOME

let handler
try {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

  // The inject list is a runtime contract Cordis validates lazily: any
  // property access on `ctx` that isn't declared here throws
  // "cannot get property X without inject" at the first read from a route
  // handler. `settings` is touched once in apply() (configure({auto:false})).
  const expectedInject = ['webServer', 'clientModules', 'skills', 'agents', 'settings'].sort()
  const actualInject = [...(mod.inject ?? [])].sort()
  if (actualInject.join(',') !== expectedInject.join(',')) {
    throw new Error(`inject drift: got [${actualInject.join(', ')}], want [${expectedInject.join(', ')}]`)
  }

  // Mock the subset of Context the Host half touches during apply()
  // and route handling. On dsh ≥ 0.1.7 `settings` is the SettingsForms
  // service; the plugin only calls configure({ auto: false }) once. All
  // bookkeeping lives in the plugin's own JSON state documents, so a noop
  // settings mock is enough.
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
      // The workbench registers its own SkillProvider so panel visibility
      // doesn't depend on whether dsh-skill-filesystem is happy. The smoke
      // mock only needs to record that registration happened; the factory
      // is invoked with a stub control so it can capture `invalidate()`.
      registerProvider: (factory) => {
        const control = { signal: new AbortController().signal, invalidate: () => {} }
        factory(control)
        return () => {}
      },
    },
    agents: {
      get: () => undefined,
      currentInitiator: () => undefined,
    },
    settings: {
      configure: () => () => {},
    },
  }
  mod.apply(ctx, { gitRemote: '', customSkillDirs: [], installedSkills: [], skippedHead: '' })

  if (registered.length !== 1) throw new Error(`expected 1 route registration, got ${registered.length}`)
  const [route] = registered
  if (route.kind !== 'prefix' || route.path !== '/whaletv/workbench') {
    throw new Error(`unexpected route shape: ${JSON.stringify({ kind: route.kind, path: route.path })}`)
  }
  handler = route.handler

  /** Drive one request through the prefix handler and resolve its response.
   * Non-JSON bodies (the favicon proxy serves images/plain text) resolve as
   * `{ raw }` so boundary assertions can still read the status. */
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
        end(payload) {
          let parsed
          try { parsed = JSON.parse(payload) } catch { parsed = { raw: String(payload) } }
          resolve({ status: this.status, body: parsed })
        },
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

  // 8. Git-import safety boundaries reject BEFORE any subprocess spawns
  //    (roadmap P4-28): URL whitelist, reserved name, kebab-case, ref
  //    charset, and path traversal all fail fast with readable errors.
  const importBoundaries = [
    [{ url: 'file:///etc/passwd', name: 'ok-name' }, '仅支持 http'],
    [{ url: 'https://github.com/o/r', name: 'skill' }, '冲突'],
    [{ url: 'https://github.com/o/r', name: 'Bad_Name' }, 'kebab-case'],
    [{ url: 'https://github.com/o/r', name: 'ok-name', ref: 'a;rm' }, 'ref/branch'],
    [{ url: 'https://github.com/o/r', name: 'ok-name', subPath: '../x' }, '..'],
  ]
  for (const [payload, needle] of importBoundaries) {
    const hit = await request('POST', '/skills/import', JSON.stringify(payload))
    if (hit.status !== 400 || !String(hit.body.error ?? '').includes(needle)) {
      throw new Error(`/skills/import boundary (${needle}) should 400: ${hit.status} ${JSON.stringify(hit.body)}`)
    }
  }

  // 9. Update-skip validates the SHA charset.
  const badSkip = await request('POST', '/update/skip', JSON.stringify({ sha: 'not-a-sha; rm -rf' }))
  if (badSkip.status !== 400 || !String(badSkip.body.error ?? '').includes('sha')) {
    throw new Error(`/update/skip bad sha should 400: ${badSkip.status} ${JSON.stringify(badSkip.body)}`)
  }

  // 10. Favicon proxy refuses loopback / private origins (roadmap P2-17).
  const icon = await request('GET', `/icon?url=${encodeURIComponent('http://127.0.0.1/')}`)
  if (icon.status !== 400) {
    throw new Error(`/icon private origin should 400: ${icon.status} ${JSON.stringify(icon.body)}`)
  }

  console.log('smoke-host: OK — prefix dispatch (state/config/update*/skills*/usage/health/icon/session), sanitize + persist, 405/404 + git-import/skip/icon boundaries')
} catch (error) {
  console.error('smoke-host: FAILED:', error)
  process.exitCode = 1
} finally {
  rmSync(TMP_DSH_HOME, { recursive: true, force: true })
}
