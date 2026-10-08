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
 *   - GET /restart/plan and POST /restart both 404 (the in-panel restart
 *     feature was removed)
 *   - GET /update/progress answering while idle
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // `pluginManager` was removed in v0.8.2 — tarball updates use direct pnpm.
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
  mod.apply(ctx, { updateRepo: 'KK-Irving/whaletv-workbench', installedSkills: [], skippedHead: '' })

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
  // The client half detects a stale Host by these flags (the client bundle
  // hot-injects, the Host half only loads at process start), so the contract
  // must not silently lose them.
  if (!Array.isArray(state0.body.capabilities) || !state0.body.capabilities.includes('progress')) {
    throw new Error(`state.capabilities must advertise its routes: ${JSON.stringify(state0.body.capabilities)}`)
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

  // 11. The restart routes are gone: both answer the sub-path fallthrough 404
  //     (the in-panel restart feature was removed; updates ask the user to
  //     restart dsh manually instead).
  const restartPlanGone = await request('GET', '/restart/plan')
  const restartGone = await request('POST', '/restart')
  if (restartPlanGone.status !== 404 || restartGone.status !== 404) {
    throw new Error(`/restart* must 404 after removal: plan=${restartPlanGone.status} restart=${restartGone.status}`)
  }

  // 12. Update progress answers even when nothing is running.
  const progress = await request('GET', '/update/progress')
  if (progress.status !== 200 || typeof progress.body.stage !== 'string' || progress.body.running !== false) {
    throw new Error(`/update/progress idle shape: ${progress.status} ${JSON.stringify(progress.body)}`)
  }

  // 13. pnpm build-approval plumbing (v0.8.10). The fixtures are the two
  //     refusal shapes pnpm actually prints — a git-hosted dependency update
  //     on a host whose pnpm enforces the build allowlist must be granted the
  //     exact key pnpm demanded, or every release fails identically.
  const tarballRefusal = '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: '
    + 'whaletv-workbench@https://codeload.github.com/KK-Irving/whaletv-workbench/tar.gz/7d0d742cd1ac5b75601b1965c7e8eac77fe5efc9, '
    + 'whaletv-workbench@https://codeload.github.com/KK-Irving/whaletv-workbench/tar.gz/ba29c4ed79128794fcf9cc379a09b8f52ea25dee\n'
    + 'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.'
  const tarballKeys = mod.approvalKeysFor(tarballRefusal)
  if (tarballKeys.length !== 2 || !tarballKeys[0].includes('tar.gz/') || mod.isBuildApprovalRefusal(tarballRefusal) !== true) {
    throw new Error(`approvalKeysFor(tarball) failed: ${JSON.stringify(tarballKeys)}`)
  }
  const gitRefusal = '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from '
    + '"https://github.com/KK-Irving/whaletv-workbench.git": The git-hosted package "whaletv-workbench@0.8.9" needs to '
    + 'execute build scripts but is not in the "allowBuilds" allowlist.\n\nAdd the package to "allowBuilds" in your '
    + 'project\'s pnpm-workspace.yaml to allow it to run scripts. For example:\nallowBuilds:\n  '
    + 'whaletv-workbench@git+https://github.com/KK-Irving/whaletv-workbench.git#e8055057724095c052d7c9a1e6d9efc2c92dfe6a: true'
  const gitKeys = mod.approvalKeysFor(gitRefusal)
  if (gitKeys.length !== 1 || !gitKeys[0].includes('#e805505')) {
    throw new Error(`approvalKeysFor(git) failed: ${JSON.stringify(gitKeys)}`)
  }
  if (mod.isBuildApprovalRefusal('ERR_PNPM_FETCH_404 GET https://example.com: Not Found') !== false) {
    throw new Error('isBuildApprovalRefusal must not treat a network error as an approval refusal')
  }

  // 14. grantBuildApproval merges both spellings, keeps every existing line,
  //     and is idempotent on a second run for the same keys.
  const profileDir = join(TMP_DSH_HOME, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const workspaceFile = join(profileDir, 'pnpm-workspace.yaml')
  writeFileSync(workspaceFile, '# profile header\npackages:\n  - .\n\nnodeLinker: hoisted\n')
  const firstGrant = mod.grantBuildApproval(profileDir, gitKeys)
  if (!firstGrant.ok || !firstGrant.changed) {
    throw new Error(`grantBuildApproval failed: ${JSON.stringify(firstGrant)}`)
  }
  const granted = readFileSync(workspaceFile, 'utf8')
  for (const needle of ['# profile header', 'nodeLinker: hoisted', 'onlyBuiltDependencies:', `  - whaletv-workbench`, 'allowBuilds:', gitKeys[0]]) {
    if (!granted.includes(needle)) throw new Error(`granted pnpm-workspace.yaml lost ${needle}:\n${granted}`)
  }
  const secondGrant = mod.grantBuildApproval(profileDir, gitKeys)
  if (!secondGrant.ok || secondGrant.changed) {
    throw new Error(`grantBuildApproval must be idempotent: ${JSON.stringify(secondGrant)}`)
  }

  // 15. resolveProfileDir finds the profile that declares this dependency
  //     (the link:/junction case the old `packageDir/../..` derivation missed).
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { 'whaletv-workbench': 'link:E://somewhere' } }))
  const resolved = mod.resolveProfileDir(join(TMP_DSH_HOME, 'nowhere', 'whaletv-workbench'), TMP_DSH_HOME)
  if (resolved !== profileDir) {
    throw new Error(`resolveProfileDir returned ${String(resolved)}, want ${profileDir}`)
  }

  // 16. Market aggregation (v0.8.17): dedupe by slug, installed entries first,
  //     then by downloads. `sanitizeSkillDirName` must produce provider-visible
  //     kebab-case directory names from arbitrary market slugs.
  const merged = mod.mergeMarketResults(
    [
      { source: 'skillhub', items: [
        { source: 'skillhub', slug: 'demo-skill', name: 'demo-skill', displayName: 'Demo', summary: 'a', summaryZh: '', author: 'x', downloads: 100, installs: 0, stars: 0, iconUrl: '', verified: false, version: '', installRef: 'demo-skill', ownerHandle: '' },
        { source: 'skillhub', slug: 'shared', name: 'shared', displayName: 'Shared (hub)', summary: '', summaryZh: '', author: 'x', downloads: 50, installs: 0, stars: 0, iconUrl: '', verified: false, version: '', installRef: 'shared', ownerHandle: '' },
      ] },
      { source: 'clawhub', items: [
        { source: 'clawhub', slug: 'shared', name: 'shared', displayName: 'Shared (claw)', summary: '', summaryZh: '', author: 'y', downloads: 90, installs: 0, stars: 0, iconUrl: '', verified: false, version: '', installRef: 'y/shared', ownerHandle: 'y' },
        { source: 'clawhub', slug: 'claw-only', name: 'claw-only', displayName: 'Claw only', summary: '', summaryZh: '', author: 'y', downloads: 200, installs: 0, stars: 0, iconUrl: '', verified: false, version: '', installRef: 'y/claw-only', ownerHandle: 'y' },
      ] },
    ],
    ['claw-only'],
  )
  if (merged.length !== 3) throw new Error(`mergeMarketResults dedupe failed: ${merged.length} items`)
  if (merged[0].slug !== 'claw-only') throw new Error(`installed-first sort failed: ${JSON.stringify(merged.map(m => m.slug))}`)
  if (merged.find(m => m.slug === 'shared')?.displayName !== 'Shared (hub)') {
    throw new Error('mergeMarketResults must keep the first-seen source for a duplicated slug')
  }
  for (const [input, want] of [['My_Skill!', 'my-skill'], ['gitcrawl', 'gitcrawl'], ['---', 'market-skill']]) {
    const got = mod.sanitizeSkillDirName(input)
    if (got !== want) throw new Error(`sanitizeSkillDirName(${input}) = ${got}, want ${want}`)
  }

  console.log('smoke-host: OK — prefix dispatch (state/config/update*/usage/health/icon/session), sanitize + persist, 405/404 + git-import/skip/icon boundaries + restart routes removed, pnpm build-approval plumbing, market aggregation')
} catch (error) {
  console.error('smoke-host: FAILED:', error)
  process.exitCode = 1
} finally {
  rmSync(TMP_DSH_HOME, { recursive: true, force: true })
}
