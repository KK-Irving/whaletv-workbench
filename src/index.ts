/**
 * whaletv-workbench Host half (Node): the workbench state, config save,
 * one-click update, skills management, and follow-up-to-agent routes
 * mounted on ctx.webServer plus a `whaletv-workbench` settings namespace.
 *
 * Routes (all under `/whaletv/workbench` served by one prefix seat):
 *   GET  /state              → version / git facts / entry config
 *   POST /config             → validate + persist workbench.json
 *   POST /update             → git pull --ff-only → (changed) pnpm install
 *                              → pnpm run bundle → ctx.clientModules.rebuilt
 *   GET  /update/check       → fetch + ahead/behind + incoming commits
 *   GET  /update/history     → rolling update-attempt log (updates.json)
 *   GET  /update/progress    → live stage of the running update pipeline
 *   POST /update/skip        → mark the upstream head as skipped
 *   POST /update/rollback    → reset to the last update's before-SHA + rebuild
 *   GET  /restart/plan       → can this host restart itself, and with what command
 *   POST /restart            → relaunch the harness (loopback-only), then exit
 *   GET  /usage              → launch-count ledger (最近使用 rail)
 *   POST /usage/record       → bump one item's launch counter
 *   GET  /health             → reachability probe for every entry
 *   GET  /icon?url=<origin>  → cached per-origin favicon proxy
 *   GET  /skills             → invocation-neutral summaries from ctx.skills
 *   POST /skills/install     → write a workbench-owned skill into
 *                              $DSH_HOME/skills/<name>/SKILL.md and record it
 *   POST /skills/import      → shallow-clone a git repo and copy the named
 *                              skill body (bundle or flat markdown) into
 *                              $DSH_HOME/skills/<name>/
 *   POST /skills/remove      → remove a workbench-owned skill's dir
 *   POST /skills/update      → re-clone the recorded origin and apply changes
 *   GET  /skills/market/search  → aggregate SkillHub + ClawHub search
 *   GET  /skills/market/detail  → one market skill's metadata + SKILL.md body
 *   POST /skills/market/install → download + safe-extract a market skill ZIP
 *   POST /session/followup   → ctx.agents.get(sessionId).followup(message)
 *                              — the modern replacement for
 *                              clipboard-copy + startSession pairing.
 *
 * The browser half calls these routes with same-origin fetch. The Host half
 * stays intentionally thin and stable so most updates only reload the client
 * bundle; when a pulled commit touches Host code, `needRestart` tells the
 * user to restart dsh.
 *
 * @module whaletv-workbench
 */
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.clientModules (WebBootGraph client registry) context merge.
import type {} from '@deepseek-ai/dsh-client-modules'
// Type-only: ctx.webServer (named HTTP route registry) context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: ctx.agents context merge.
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {
  WorkbenchConfig, WorkbenchGroup, WorkbenchItem,
  WorkbenchSessionFollowupRequest, WorkbenchSessionFollowupResult, WorkbenchSkillImportRequest,
  WorkbenchSkillImportResult, WorkbenchSkillInstallRequest, WorkbenchSkillInstallResult,
  WorkbenchSkillRemoveRequest, WorkbenchSkillRemoveResult,
  WorkbenchSkillUpdateRequest, WorkbenchSkillUpdateResult,
  WorkbenchState, WorkbenchUpdateHistory,
  WorkbenchUpdateSkipRequest, WorkbenchUpdateSkipResult,
} from './shared.ts'

import { PACKAGE_DIR, WORKBENCH_STATE_DIR, git, truncate, readJsonBody, cleanString, readVersion, sendJson } from './host-plumbing.ts'
import { runUpdate, runUpdateCheck, runUpdateRollback, clearSkippedHead, readSkippedHead, readUpdateHistory, readUpdateProgress, writeSkippedHead } from './update.ts'
import { buildRestartPlan, requestRestart } from './restart.ts'
// Re-exported for the smoke suite: the pnpm build-approval helpers are pure
// enough to test against fixtures (a real refusal message + a temp profile).
export { approvalKeysFor, grantBuildApproval, isBuildApprovalRefusal, resolveProfileDir } from './pnpm-approval.ts'
import { sweepStagingDir, registerWorkbenchSkillProvider, buildSkillList, buildSkillDebug, readInstalledRecords, upsertInstalledRecords, pruneInstalledRecords, installSkillOnDisk, importSkillFromGit, removeSkillOnDisk } from './skills.ts'
import { installMarketSkill, marketDetail, readInstalledNamesForMarket, searchMarket } from './skill-market.ts'// Re-exported for the smoke suite: pure market aggregation/sanitization logic
// tested against fixtures (no network in the gate).
export { mergeMarketResults, sanitizeSkillDirName } from './skill-market.ts'
import { readUsage, recordUsage, runHealthCheck, serveFavicon } from './extras.ts'

export const name = 'whaletv-workbench'

/**
 * User-owned preferences layered on top of any composition entry and schema
 * defaults. Kept small on purpose: the entry registry (groups/items) is a
 * separate JSON document editable in-panel, and the plugin's bookkeeping
 * (installed skills, skipped update heads) lives in its own Host-owned JSON
 * documents under $DSH_HOME/whaletv-workbench — NOT in this Config.
 *
 * dsh ≥ 0.1.7 projects this schema straight into the Plugins settings page
 * (`SettingsForms.describe`), so the one scalar pref is declared
 * `.volatile()` — that is what makes it live-editable in the generated
 * form without remounting the plugin. (0.8.3 removed the never-consumed
 * `gitRemote` / `customSkillDirs` fields — nothing read them.)
 */
export interface Config {
  /** GitHub `owner/repo` the tarball-install update channel resolves against (raw package.json probe + `pnpm add github:<repo>`). */
  updateRepo: string
  /** @deprecated 0.7.1 — bookkeeping moved to installed-skills.json; kept so stored user layers still validate. */
  installedSkills: string[]
  /** @deprecated 0.7.1 — bookkeeping moved to update-state.json; kept so stored user layers still validate. */
  skippedHead: string
}

export const Config = z.object({
  updateRepo: z.string().default('KK-Irving/whaletv-workbench').volatile(),
  /* Bookkeeping below stays NON-volatile on purpose: nothing may edit it
   * through the settings surface — the write routes own these fields. */
  installedSkills: z.array(z.string()).default([]),
  skippedHead: z.string().default(''),
})

/**
 * Host services this plugin uses through ctx. `settings` (dsh SettingsForms
 * on ≥ 0.1.7) is used once in apply() to turn off the auto-generated config
 * page; the plugin's own bookkeeping lives in its JSON state documents
 * instead of the settings document. The settings namespace is this plugin's
 * profile entry id (`whaletv-workbench`, see cordis.patch.yml) — referenced
 * by the generated page, not by this code.
 */
export const inject = ['webServer', 'clientModules', 'skills', 'agents', 'settings']

/**
 * All workbench routes live under this prefix. One `kind: 'prefix'`
 * registration owns dispatch on the sub-path, reducing seven separate
 * registrations to a single disposer.
 */
const ROUTE_PREFIX = '/whaletv/workbench'

/** Upper bounds for the payload the two JSON write routes accept. */
const MAX_CONFIG_BYTES = 512 * 1024

const MAX_SKILL_BYTES = 256 * 1024

const MAX_GROUPS = 50

const MAX_ITEMS_PER_GROUP = 200

const WORKBENCH_CONFIG_PATH = join(WORKBENCH_STATE_DIR, 'workbench.json')

/** Legacy config location — read once for backward-compat, then migrated. */
const LEGACY_CONFIG_PATH = join(PACKAGE_DIR, 'config', 'workbench.json')

/** SHA accepted by the skip route: short (≥7) or full hex. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i

/**
 * Read the entry config: `$DSH_HOME/whaletv-workbench/workbench.json` when
 * present, falling back to the legacy plugin-dir path once (with implicit
 * migration to the new location), then the shipped template. A broken file
 * renders as a single error group so the panel remains usable.
 */
function readConfig(): WorkbenchConfig {
  const examplePath = join(PACKAGE_DIR, 'config', 'workbench.example.json')
  // New location wins when present.
  if (existsSync(WORKBENCH_CONFIG_PATH)) {
    return parseConfigFile(WORKBENCH_CONFIG_PATH)
  }
  // Legacy location (plugin dir): read, then migrate to $DSH_HOME so a git
  // pull inside the plugin directory can never clobber user data again.
  if (existsSync(LEGACY_CONFIG_PATH)) {
    const parsed = parseConfigFile(LEGACY_CONFIG_PATH)
    try {
      writeConfig(parsed)
      // Keep the legacy file as a courtesy for now; a future release removes
      // it once every user has run at least once against the new location.
    } catch {
      // Migration best-effort: broken write shouldn't fail the read path.
    }
    return parsed
  }
  if (existsSync(examplePath)) return parseConfigFile(examplePath)
  return { groups: [] }
}

function parseConfigFile(path: string): WorkbenchConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WorkbenchConfig
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) {
      throw new Error(`${basename(path)} 必须是 { "groups": [...] } 结构`)
    }
    return parsed
  } catch (error) {
    return { groups: [{ id: 'broken', title: '配置读取失败', items: [{ id: 'broken', title: String(error), description: `检查 ${path}` }] }] }
  }
}

/**
 * Collect a request body with a size cap. Resolves the parsed JSON; rejects
 * with a readable message on oversize / stream errors / malformed JSON.
 * @param req - the incoming request.
 * @param maxBytes - upper bound for this specific request.
 */

/**
 * Validate and normalize a raw WorkbenchConfig payload.
 */
function sanitizeConfig(raw: unknown): WorkbenchConfig {
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as { groups?: unknown }).groups)) {
    throw new Error('配置必须是 { "groups": [...] } 结构')
  }
  const rawGroups = (raw as { groups: unknown[] }).groups
  if (rawGroups.length > MAX_GROUPS) throw new Error(`分组数量超过上限（${MAX_GROUPS}）`)
  const seenGroupIds = new Set<string>()
  const seenItemIds = new Set<string>()
  const groups: WorkbenchGroup[] = rawGroups.map((rawGroup, groupIndex) => {
    if (rawGroup === null || typeof rawGroup !== 'object') {
      throw new Error(`第 ${groupIndex + 1} 个分组不是对象`)
    }
    const group = rawGroup as Record<string, unknown>
    const id = cleanString(group.id)
    const title = cleanString(group.title)
    if (id === undefined) throw new Error(`第 ${groupIndex + 1} 个分组缺少 id`)
    if (title === undefined) throw new Error(`分组 ${id} 缺少标题`)
    if (seenGroupIds.has(id)) throw new Error(`分组 id 重复：${id}`)
    seenGroupIds.add(id)
    if (!Array.isArray(group.items)) throw new Error(`分组「${title}」的 items 必须是数组`)
    if (group.items.length > MAX_ITEMS_PER_GROUP) {
      throw new Error(`分组「${title}」的条目数量超过上限（${MAX_ITEMS_PER_GROUP}）`)
    }
    const items: WorkbenchItem[] = group.items.map((rawItem, itemIndex) => {
      if (rawItem === null || typeof rawItem !== 'object') {
        throw new Error(`分组「${title}」第 ${itemIndex + 1} 个条目不是对象`)
      }
      const item = rawItem as Record<string, unknown>
      const itemId = cleanString(item.id)
      const itemTitle = cleanString(item.title)
      if (itemId === undefined) throw new Error(`分组「${title}」第 ${itemIndex + 1} 个条目缺少 id`)
      if (itemTitle === undefined) throw new Error(`分组「${title}」第 ${itemIndex + 1} 个条目缺少标题`)
      if (seenItemIds.has(itemId)) throw new Error(`条目 id 重复：${itemId}`)
      seenItemIds.add(itemId)
      const cleaned: WorkbenchItem = { id: itemId, title: itemTitle }
      const description = cleanString(item.description)
      const url = cleanString(item.url)
      const path = cleanString(item.path)
      const prompt = cleanString(item.prompt)
      if (description !== undefined) cleaned.description = description
      if (url !== undefined) cleaned.url = url
      if (path !== undefined) cleaned.path = path
      if (prompt !== undefined) cleaned.prompt = prompt
      return cleaned
    })
    return { id, title, items }
  })
  return { groups }
}

/** Persist the workbench.json atomically (tmp file + rename). */
function writeConfig(config: WorkbenchConfig): void {
  mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
  const tmp = `${WORKBENCH_CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, WORKBENCH_CONFIG_PATH)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** Read this package's version from its manifest. */

/** Assemble the GET /whaletv/workbench/state payload. */
async function buildState(): Promise<WorkbenchState> {
  const [branch, head, remote] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['rev-parse', '--short', 'HEAD']),
    git(['remote', 'get-url', 'origin']),
  ])
  return {
    ok: true,
    version: readVersion(),
    packageDir: PACKAGE_DIR,
    installKind: head !== undefined ? 'git' : 'tarball',
    git: {
      configured: head !== undefined,
      ...(branch !== undefined ? { branch } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(remote !== undefined ? { remote } : {}),
    },
    config: readConfig(),
    capabilities: HOST_CAPABILITIES,
  }
}

/**
 * What THIS build of the Host half can serve. Kept in the loaded module (not
 * derived from disk or package.json) so a newer client can detect that the
 * running process predates a feature and tell the user to restart, instead of
 * calling a route that answers "未知的工作台路由".
 */
const HOST_CAPABILITIES: string[] = ['restart', 'progress', 'history']

/**
 * Volatile Config fields (dsh ≥ 0.1.7 live-editable settings) resolve to
 * accessor objects with a `.get()` method rather than plain values — unwrap
 * before use. THE `updateRepo` BUG (v0.7.4–0.7.6): the raw accessor object
 * was interpolated into the probe URLs, so every source was asked for
 * `https://.../[object Object]/...` and answered 404/400/403.
 */
function readConfigValue(config: Config, field: 'updateRepo'): string {
  const raw = config[field] as unknown
  const value = raw !== null && typeof raw === 'object' && typeof (raw as { get?: unknown }).get === 'function'
    ? (raw as { get: () => unknown }).get()
    : raw
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'KK-Irving/whaletv-workbench'
}

/**
 * Route a follow-up prompt into an existing live agent's inbox.
 *
 * Prefers the client-supplied sessionId; falls back to
 * `ctx.agents.currentInitiator()` which is only meaningful when the caller
 * itself already runs inside an agent-scoped async chain — usually not the
 * case for an HTTP handler, so browsers should pass sessionId whenever the
 * visible session id is known.
 */
function submitFollowup(
  ctx: Context, request: WorkbenchSessionFollowupRequest,
): WorkbenchSessionFollowupResult {
  const prompt = request.prompt.trim()
  if (prompt === '') return { ok: false, error: '提示词不能为空' }
  const agent = request.sessionId !== undefined && request.sessionId !== ''
    ? ctx.agents.get(request.sessionId as SessionId)
    : ctx.agents.currentInitiator()
  if (agent === undefined) {
    return {
      ok: false,
      error: request.sessionId === undefined
        ? '未提供 sessionId 且当前请求无 initiator——请从前端传入当前会话 id'
        : `未找到会话：${request.sessionId}`,
    }
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }))
  return { ok: true, sessionId: agent.id }
}

/**
 * Extract the sub-path a request landed on within the workbench route
 * prefix. Strips the shared prefix and any query string.
 */
function subPath(req: IncomingMessage): string {
  const raw = req.url ?? ''
  const noQuery = raw.split('?', 1)[0] ?? ''
  return noQuery.startsWith(ROUTE_PREFIX) ? noQuery.slice(ROUTE_PREFIX.length) : ''
}

/**
 * Whether a request came straight from the loopback interface.
 *
 * The restart route ends the harness process, so it accepts only a direct
 * local caller: a proxied/forwarded request (reverse proxy, LAN gateway) must
 * never be able to kill the host it is talking to.
 */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const headers = req.headers ?? {}
  if (headers['x-forwarded-for'] !== undefined || headers['x-real-ip'] !== undefined) return false
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Register the workbench routes and the settings namespace.
 *
 * One `kind: 'prefix'` seat covers every sub-path under
 * `/whaletv/workbench/*` and dispatches internally; a closure-scoped
 * `updating` flag prevents concurrent update runs and never leaks across
 * plugin hot-reloads. The settings namespace joins the plugin's Host state
 * to the browser card by name.
 *
 * @param ctx - host context populated with the injected services.
 * @param config - schemastery-resolved config (composition entry + user layer + defaults).
 */
export function apply(ctx: Context, config: Config): void {
  // Nuke any half-clones left behind by past failed imports before the
  // routes come online, so a user opening `.staging/` never sees stale
  // `.git`-only skeletons (usually left by an OAuth / auth failure on
  // Windows where fs.rmSync lost the race to a still-open git.exe handle).
  sweepStagingDir()

  // dsh ≥ 0.1.7 projects the plugin's Config schema into the Plugins
  // settings page automatically. The one scalar pref is declared volatile,
  // so the generated form edits them live; suppress the AUTO page because
  // this plugin ships none of the host-plane pages it would duplicate.
  //
  // Reached STRUCTURALLY (optional-chained) instead of through the
  // `dsh-settings` Context merge: that seam changed in every release from
  // 0.1.4 → 0.1.7, and this file deliberately carries no dsh-settings type
  // dependency. On older dsh (no configure) this degrades to a no-op.
  const settingsForms = (ctx as { settings?: { configure?: (presentation: { auto?: boolean }) => () => void } }).settings
  try {
    settingsForms?.configure?.({ auto: false })
  } catch {
    /* older settings service without configure: nothing to do. */
  }

  // Register a workbench-owned SkillProvider so the "工作台技能" panel
  // sees the files we write even when dsh-skill-filesystem doesn't (missing
  // config, Windows chokidar quirks, schema-validation drops the plugin).
  // Same rank order as dsh's user-dsh (400 vs our 450) → dsh wins when both
  // agree; we fill in when dsh doesn't. Write routes below call
  // `skillProvider.invalidate()` after mutating disk so the next snapshot
  // rescans deterministically instead of waiting on a fs watcher.
  const skillProvider = registerWorkbenchSkillProvider(ctx)

  // Closure-scoped so plugin reload starts fresh; a module-level flag would
  // survive HMR and leave the next mount answering 409 forever.
  let updating = false

  ctx.effect(() => {
    const disposeRoutes = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        const sub = subPath(req)
        const method = req.method

        // GET /state — snapshot for the panel first render / reload button.
        if (sub === '/state' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void buildState().then(
            state => { sendJson(res, 200, state) },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          )
          return
        }

        // POST /config — sanitize + persist a WorkbenchConfig.
        if (sub === '/config') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, MAX_CONFIG_BYTES).then(
            (raw) => {
              try {
                writeConfig(sanitizeConfig(raw))
                sendJson(res, 200, { ok: true })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // POST /update — self-update pipeline, one at a time.
        if (sub === '/update') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          if (updating) {
            sendJson(res, 409, { ok: false, error: '已有更新正在进行中，请稍候。' })
            return
          }
          updating = true
          void runUpdate(ctx, readConfigValue(config, 'updateRepo')).then(
            result => {
              // A successful move invalidates any "skip this version" marker.
              if (result.ok && result.changed === true) clearSkippedHead()
              sendJson(res, result.ok ? 200 : 500, result)
            },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          ).finally(() => { updating = false })
          return
        }

        // GET /update/check — fetch + ahead/behind + incoming commit list,
        // no working-tree changes (roadmap P1-8).
        if (sub === '/update/check' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void runUpdateCheck(readSkippedHead(), readConfigValue(config, 'updateRepo')).then(
            result => { sendJson(res, result.ok ? 200 : 500, result) },
            (error: unknown) => { sendJson(res, 500, { ok: false, upToDate: false, error: String(error) }) },
          )
          return
        }

        // GET /update/history — the rolling attempt log (roadmap P1-9).
        if (sub === '/update/history' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, { ok: true, entries: readUpdateHistory() } satisfies WorkbenchUpdateHistory)
          return
        }

        // POST /update/skip — mark the upstream head as skipped; the checker
        // flags it instead of nagging until the remote moves again (P1-10).
        if (sub === '/update/skip') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, 4 * 1024).then(
            async (raw) => {
              try {
                const request = raw as WorkbenchUpdateSkipRequest
                const sha = typeof request.sha === 'string' ? request.sha.trim() : ''
                if (!SHA_PATTERN.test(sha)) throw new Error(`sha 必须是 7-40 位十六进制，收到：${sha || '<空>'}`)
                writeSkippedHead(sha.toLowerCase())
                const result: WorkbenchUpdateSkipResult = { ok: true, skippedHead: sha.toLowerCase() }
                sendJson(res, 200, result)
              } catch (error) {
                const result: WorkbenchUpdateSkipResult = { ok: false, error: error instanceof Error ? error.message : String(error) }
                sendJson(res, 400, result)
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // POST /update/rollback — reset to before the last successful update
        // and hot-inject the reverted bundle (roadmap P1-9).
        if (sub === '/update/rollback') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          if (updating) {
            sendJson(res, 409, { ok: false, error: '已有更新或回滚正在进行中，请稍候。' })
            return
          }
          updating = true
          void runUpdateRollback(ctx).then(
            result => { sendJson(res, result.ok ? 200 : 500, result) },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          ).finally(() => { updating = false })
          return
        }

        // GET /update/progress — the running pipeline's current stage (③).
        if (sub === '/update/progress' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, readUpdateProgress())
          return
        }

        // GET /restart/plan — how this host restarts, and whether the panel
        // may do it itself (③). Read-only; safe to call on every panel open.
        if (sub === '/restart/plan' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, buildRestartPlan())
          return
        }

        // POST /restart — relaunch the harness. Loopback-only and never
        // proxied: this ends the current process, so a forwarded request must
        // not be able to trigger it.
        if (sub === '/restart') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          if (!isLoopbackRequest(req)) {
            sendJson(res, 403, { ok: false, error: '只接受本机回环地址的重启请求' })
            return
          }
          const plan = buildRestartPlan()
          const started = requestRestart(plan)
          // The response must reach the browser BEFORE the process exits; the
          // exit itself is scheduled by requestRestart.
          sendJson(res, started.ok ? 200 : 400, { ok: started.ok, ...(started.error !== undefined ? { error: started.error } : {}) })
          return
        }

        // GET /usage — launch-count ledger feeding the 最近使用 rail (P2-12).
        if (sub === '/usage' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, { ok: true, usage: readUsage() })
          return
        }

        // POST /usage/record — bump one item's counter at launch time (P2-12).
        if (sub === '/usage/record') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, 4 * 1024).then(
            (raw) => {
              try {
                const itemId = typeof (raw as { itemId?: unknown }).itemId === 'string' ? (raw as { itemId: string }).itemId.trim() : ''
                if (itemId === '') throw new Error('itemId 不能为空')
                recordUsage(itemId)
                sendJson(res, 200, { ok: true })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // GET /health — probe every configured entry once (P2-16): url HEAD
        // (GET fallback for 403/405 shields) and path existence.
        if (sub === '/health' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void runHealthCheck(readConfig()).then(
            results => { sendJson(res, 200, { ok: true, results }) },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          )
          return
        }

        // GET /icon?url=<origin> — cached per-origin favicon proxy (P2-17).
        // Private-network origins are refused; responses are immutable files
        // under the workbench state dir.
        if (sub === '/icon' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          const target = new URL(req.url ?? '/', 'http://localhost').searchParams.get('url') ?? ''
          void serveFavicon(target).then(
            icon => {
              res.writeHead(icon.status, {
                'Content-Type': icon.contentType,
                'Content-Length': icon.body.length,
                'Cache-Control': icon.cache,
              })
              res.end(method === 'HEAD' ? undefined : icon.body)
            },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          )
          return
        }

        // GET /skills — invocation-neutral catalog + which entries this
        // workbench can remove.
        if (sub === '/skills' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void buildSkillList(ctx, readInstalledRecords()).then(
            payload => { sendJson(res, payload.ok ? 200 : 500, payload) },
            (error: unknown) => { sendJson(res, 500, { ok: false, skills: [], complete: false, error: String(error) }) },
          )
          return
        }

        // GET /skills/debug — diagnostic surface for "file on disk but not in
        // the catalog" cases. Compares what dsh-skill-filesystem would scan
        // against what actually sits under $DSH_HOME/skills, plus the
        // environment overrides that could point the two at different paths.
        if (sub === '/skills/debug' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void buildSkillDebug(ctx).then(
            payload => { sendJson(res, 200, payload) },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          )
          return
        }

        // POST /skills/install — write a skill file + register its name.
        if (sub === '/skills/install') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, MAX_SKILL_BYTES).then(
            async (raw) => {
              try {
                const request = raw as WorkbenchSkillInstallRequest
                const skillName = cleanString(request.name)
                const content = typeof request.content === 'string' ? request.content : ''
                if (skillName === undefined) throw new Error('skill 名称不能为空')
                if (content.trim() === '') throw new Error('skill 内容不能为空')
                const writtenTo = installSkillOnDisk(skillName, content)
                // Versioning record (roadmap P3-20): an install onto an
                // existing skill (panel edit overwrite) must PRESERVE the
                // previous origin fields (sourceUrl/sha/subPath/ref) — only
                // the timestamp refreshes. A brand-new skill gets a bare
                // record; the import route fills origins itself.
                const previousRecord = readInstalledRecords().find(entry => entry.name === skillName)
                upsertInstalledRecords([{
                  ...(previousRecord ?? { name: skillName }),
                  installedAt: new Date().toISOString(),
                }])
                skillProvider.invalidate()
                // Ownership across restarts is the installed-skills.json
                // versioning record above — nothing else to sync.
                const result: WorkbenchSkillInstallResult = { ok: true, writtenTo }
                sendJson(res, 200, result)
              } catch (error) {
                const result: WorkbenchSkillInstallResult = {
                  ok: false, error: error instanceof Error ? error.message : String(error),
                }
                sendJson(res, 400, result)
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // POST /skills/import — shallow-clone a git repo and copy the
        // named skill body into $DSH_HOME/skills/. Auto-detects bundle /
        // flat / batch (a directory whose children each hold a SKILL.md).
        if (sub === '/skills/import') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, MAX_SKILL_BYTES).then(
            async (raw) => {
              try {
                const request = raw as WorkbenchSkillImportRequest
                if (typeof request.url !== 'string') throw new Error('url 必须是字符串')
                if (typeof request.name !== 'string') throw new Error('name 必须是字符串')
                const outcome = await importSkillFromGit(request)
                skillProvider.invalidate()
                // Versioning records (roadmap P3-20): one entry per installed
                // skill with its exact source sub-path + head SHA, so the
                // per-skill "检查更新" can re-clone just that subtree.
                const installedAt = new Date().toISOString()
                const sourceByName = new Map((outcome.sources ?? []).map(entry => [entry.name, entry.subPath]))
                upsertInstalledRecords(outcome.installed.map(name => ({
                  name,
                  sourceUrl: request.url,
                  ...(outcome.sha !== undefined ? { sha: outcome.sha } : {}),
                  ...(sourceByName.get(name) !== undefined && sourceByName.get(name) !== '' ? { subPath: sourceByName.get(name)! } : {}),
                  ...(typeof request.ref === 'string' && request.ref.trim() !== '' ? { ref: request.ref.trim() } : {}),
                  installedAt,
                })))
                // Ownership across restarts is the versioning record — the
                // old installedSkills settings mirror is gone (0.7.1).
                const result: WorkbenchSkillImportResult = {
                  ok: true,
                  installed: outcome.installed,
                  ...(outcome.skipped !== undefined ? { skipped: outcome.skipped } : {}),
                  ...(outcome.writtenTo !== undefined ? { writtenTo: outcome.writtenTo } : {}),
                  output: truncate(outcome.output),
                }
                sendJson(res, 200, result)
              } catch (error) {
                const result: WorkbenchSkillImportResult = {
                  ok: false, error: error instanceof Error ? error.message : String(error),
                }
                sendJson(res, 400, result)
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // POST /skills/remove — rm the workbench-owned dir + registry entry.
        if (sub === '/skills/remove') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, MAX_SKILL_BYTES).then(
            async (raw) => {
              try {
                const request = raw as WorkbenchSkillRemoveRequest
                const skillName = cleanString(request.name)
                if (skillName === undefined) throw new Error('skill 名称不能为空')
                removeSkillOnDisk(skillName)
                pruneInstalledRecords([skillName])
                skillProvider.invalidate()
                const result: WorkbenchSkillRemoveResult = { ok: true }
                sendJson(res, 200, result)
              } catch (error) {
                const result: WorkbenchSkillRemoveResult = {
                  ok: false, error: error instanceof Error ? error.message : String(error),
                }
                sendJson(res, 400, result)
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // POST /skills/update — re-clone the recorded origin and apply the
        // source head (roadmap P3-21). Same SHA → changed:false, reinstall is
        // idempotent; newer head → overwrite + refresh the record.
        if (sub === '/skills/update') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, MAX_SKILL_BYTES).then(
            async (raw) => {
              try {
                const request = raw as WorkbenchSkillUpdateRequest
                const name = cleanString(request.name)
                if (name === undefined) throw new Error('name 不能为空')
                const record = readInstalledRecords().find(entry => entry.name === name)
                if (record === undefined) throw new Error(`没有「${name}」的安装记录，无法检查更新`)
                if (record.sourceUrl === undefined || record.sourceUrl === '') {
                  throw new Error(`「${name}」是手写技能，没有来源仓库可更新`)
                }
                const outcome = await importSkillFromGit({
                  url: record.sourceUrl,
                  name,
                  ...(record.subPath !== undefined && record.subPath !== '' ? { subPath: record.subPath } : {}),
                  ...(record.ref !== undefined && record.ref !== '' ? { ref: record.ref } : {}),
                })
                skillProvider.invalidate()
                const sha = outcome.sha
                const changed = sha !== undefined && record.sha !== undefined && sha !== record.sha
                if (sha !== undefined) {
                  upsertInstalledRecords([{ ...record, sha, installedAt: new Date().toISOString() }])
                }
                const result: WorkbenchSkillUpdateResult = {
                  ok: true,
                  changed,
                  ...(sha !== undefined ? { sha } : {}),
                  installed: outcome.installed,
                }
                sendJson(res, 200, result)
              } catch (error) {
                const result: WorkbenchSkillUpdateResult = {
                  ok: false, error: error instanceof Error ? error.message : String(error),
                }
                sendJson(res, 400, result)
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // GET /skills/market/search — aggregate SkillHub + ClawHub search (③).
        // External calls run here (Host side) because the browser page cannot
        // cross the registries' missing CORS headers.
        if (sub === '/skills/market/search' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          const url = new URL(req.url ?? '/', 'http://localhost')
          void searchMarket(url.searchParams.get('q') ?? '', {
            source: url.searchParams.get('source') ?? undefined,
            page: Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1,
            installedNames: readInstalledNamesForMarket(),
          }).then(
            result => { sendJson(res, 200, result) },
            (error: unknown) => { sendJson(res, 500, { ok: false, items: [], sources: [], errors: [String(error)] }) },
          )
          return
        }

        // GET /skills/market/detail — one market skill's metadata + body.
        if (sub === '/skills/market/detail' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const slug = url.searchParams.get('slug') ?? ''
          if (slug === '') {
            sendJson(res, 400, { ok: false, error: 'slug 不能为空' })
            return
          }
          void marketDetail(
            url.searchParams.get('source') ?? 'skillhub',
            slug,
            url.searchParams.get('owner') ?? undefined,
          ).then(
            detail => { sendJson(res, 200, { ...detail }) },
            (error: unknown) => { sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        // POST /skills/market/install — download + safe-extract a market skill
        // into $DSH_HOME/skills/<sanitized-slug>, then record provenance.
        if (sub === '/skills/market/install') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, 8 * 1024).then(
            async (raw) => {
              try {
                const request = raw as { source?: string; slug?: string; ownerHandle?: string }
                const slug = typeof request.slug === 'string' ? request.slug.trim() : ''
                if (slug === '') throw new Error('slug 不能为空')
                if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw new Error(`slug 含非法字符：${slug}`)
                const outcome = await installMarketSkill({
                  source: request.source,
                  slug,
                  ...(typeof request.ownerHandle === 'string' && request.ownerHandle !== '' ? { ownerHandle: request.ownerHandle } : {}),
                })
                if (!outcome.ok) throw new Error(outcome.error)
                // Record provenance so a future market "check updates" can
                // re-download from the same entry (mirror the git-import flow).
                // `name` is the on-disk directory identity, matching what the
                // catalog builder lists.
                upsertInstalledRecords([{
                  name: outcome.dirName,
                  installedAt: new Date().toISOString(),
                  market: {
                    source: outcome.source === 'clawhub' ? 'clawhub' : 'skillhub',
                    slug,
                    ...(request.ownerHandle !== undefined && request.ownerHandle !== '' ? { ownerHandle: request.ownerHandle } : {}),
                  },
                }])
                skillProvider.invalidate()
                sendJson(res, 200, { ok: true, name: outcome.name, dir: outcome.dir })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        // POST /session/followup — inject a prompt into a live agent inbox.
        if (sub === '/session/followup') {
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
            return
          }
          void readJsonBody(req, MAX_SKILL_BYTES).then(
            (raw) => {
              try {
                const request = raw as WorkbenchSessionFollowupRequest
                if (typeof request.prompt !== 'string') throw new Error('prompt 必须是字符串')
                const result = submitFollowup(ctx, request)
                sendJson(res, result.ok ? 200 : 404, result)
              } catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            },
            (error: unknown) => {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            },
          )
          return
        }

        sendJson(res, 404, { ok: false, error: `未知的工作台路由：${sub}` })
      },
    })
    return () => { disposeRoutes() }
  }, 'whaletv-workbench: http routes')
}
