/**
 * Host-half smoke test: load the built lib/index.js against a mock Context
 * and drive the config route end-to-end.
 *
 *   - POST a valid config → 200, sanitized values persisted (trimmed)
 *   - POST duplicate item ids → 400 with a readable error (and, crucially,
 *     no unhandled rejection escaping the route handler)
 *   - GET on the POST-only route → 405
 *   - GET state → 200 with the saved config re-read
 *
 * The real config/workbench.json is backed up before the run and restored
 * afterwards so the user's entries are never clobbered.
 *
 * Usage: node scripts/smoke-host.mjs   (requires a built lib/index.js)
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CONFIG_PATH = join(ROOT, 'config', 'workbench.json')
const CONFIG_BAK = `${CONFIG_PATH}.smoke.bak`

let restored = false
function restoreConfig() {
  if (restored) return
  restored = true
  if (existsSync(CONFIG_BAK)) {
    rmSync(CONFIG_PATH, { force: true })
    renameSync(CONFIG_BAK, CONFIG_PATH)
  }
}

try {
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, CONFIG_BAK)

  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
  const routes = {}
  const ctx = {
    effect: (cb) => { cb() },
    webServer: { register: (spec) => { routes[spec.path] = spec.handler; return () => {} } },
    clientModules: { rebuilt: () => {} },
  }
  mod.apply(ctx)

  /** Drive one request through the registered handler and resolve its JSON response. */
  function request(method, path, body) {
    return new Promise((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, destroy() {} })
      const res = {
        status: 0,
        writeHead(status) { this.status = status },
        end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }) },
      }
      routes[path](req, res)
      if (body !== undefined) req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }

  const expectedRoutes = ['/whaletv/workbench/state', '/whaletv/workbench/config', '/whaletv/workbench/update'].sort()
  const actualRoutes = Object.keys(routes).sort()
  if (actualRoutes.join(',') !== expectedRoutes.join(',')) {
    throw new Error(`unexpected routes: ${actualRoutes.join(', ')}`)
  }

  // 1. Valid save → 200, url trimmed and persisted.
  const save = await request('POST', '/whaletv/workbench/config', JSON.stringify({
    groups: [
      { id: 'g1', title: '测试分组', items: [{ id: 'i1', title: '测试条目', description: 'd', url: '  https://example.com ' }] },
    ],
  }))
  if (save.status !== 200 || save.body.ok !== true) {
    throw new Error(`valid save failed: ${save.status} ${JSON.stringify(save.body)}`)
  }
  const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  if (saved.groups[0].items[0].url !== 'https://example.com') {
    throw new Error(`url not trimmed/persisted: ${JSON.stringify(saved.groups[0].items[0])}`)
  }

  // 2. Duplicate item ids → 400 with a readable error; must not crash the chain.
  const bad = await request('POST', '/whaletv/workbench/config', JSON.stringify({
    groups: [{ id: 'g1', title: 'x', items: [{ id: 'dup', title: 'a' }, { id: 'dup', title: 'b' }] }],
  }))
  if (bad.status !== 400 || !String(bad.body.error).includes('重复')) {
    throw new Error(`duplicate-id save should 400 with message: ${bad.status} ${JSON.stringify(bad.body)}`)
  }

  // 3. GET on the POST-only route → 405.
  const getReq = await request('GET', '/whaletv/workbench/config')
  if (getReq.status !== 405) {
    throw new Error(`GET should 405: ${getReq.status} ${JSON.stringify(getReq.body)}`)
  }

  // 4. State read-back → the saved config.
  const state = await request('GET', '/whaletv/workbench/state')
  if (state.status !== 200 || state.body.ok !== true || state.body.config.groups[0].title !== '测试分组') {
    throw new Error(`state read-back failed: ${state.status} ${JSON.stringify(state.body)}`)
  }

  restoreConfig()
  console.log('smoke-host: OK — config route save/validate/read-back, no unhandled rejections')
} catch (error) {
  restoreConfig()
  console.error('smoke-host: FAILED:', error)
  process.exit(1)
}
