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
 *   POST /update/skip        → mark the upstream head as skipped
 *   POST /update/rollback    → reset to the last update's before-SHA + rebuild
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
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.clientModules (WebBootGraph client registry) context merge.
import type {} from '@deepseek-ai/dsh-client-modules'
// Type-only: ctx.webServer (named HTTP route registry) context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: ctx.agents context merge.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: ctx.settings (SettingsProvider.installSection/update) context merge.
import type {} from '@deepseek-ai/dsh-settings'
// ctx.skills context merge + value imports for the workbench-owned provider.
import type {
  SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {
  WorkbenchConfig, WorkbenchGroup, WorkbenchInstalledSkill, WorkbenchItem,
  WorkbenchSessionFollowupRequest, WorkbenchSessionFollowupResult, WorkbenchSkillImportRequest,
  WorkbenchSkillImportResult, WorkbenchSkillInstallRequest, WorkbenchSkillInstallResult,
  WorkbenchSkillList, WorkbenchSkillRemoveRequest, WorkbenchSkillRemoveResult,
  WorkbenchSkillSummary, WorkbenchSkillUpdateRequest, WorkbenchSkillUpdateResult,
  WorkbenchState, WorkbenchUpdateCheckResult, WorkbenchUpdateHistory, WorkbenchUpdateHistoryEntry,
  WorkbenchUpdateResult, WorkbenchUpdateRollbackResult, WorkbenchUpdateSkipRequest,
  WorkbenchUpdateSkipResult,
} from './shared.ts'

export const name = 'whaletv-workbench'

/**
 * User-owned preferences layered on top of any composition entry and schema
 * defaults. Kept small on purpose: the entry registry (groups/items) is a
 * separate JSON document editable in-panel, not a settings section — the
 * settings seam is for scalar prefs a form can render.
 */
export interface Config {
  /** Optional git remote URL used by the self-update route; empty relies on `git remote get-url origin`. */
  gitRemote: string
  /** Extra roots the workbench-installed skill directory sits alongside; consumed by future skill provider work. */
  customSkillDirs: string[]
  /** Kebab-case names of skills this workbench installed (and can safely remove). Managed by the install/remove routes. */
  installedSkills: string[]
  /** Upstream head SHA the user chose to skip in the update checker; a later remote head re-arms the reminder. */
  skippedHead: string
}

export const Config: z<Config> = z.object({
  gitRemote: z.string().default(''),
  customSkillDirs: z.array(z.string()).default([]),
  installedSkills: z.array(z.string()).default([]),
  skippedHead: z.string().default(''),
})

/**
 * Settings namespace: the join key between the Host register and the browser
 * card. dsh ≥ 0.1.2 validates namespaces at runtime (lowercase hyphenated
 * identifier) and at the type level, so the plain literal replaces the old
 * `settingsNamespace(...)` helper (removed upstream).
 */
const WORKBENCH_NAMESPACE = 'whaletv-workbench'

/**
 * Host services this plugin uses through ctx.
 *
 * `settings` is declared here even though `SettingsProvider.installSection`
 * attaches its namespace through the calling fiber — the skill install /
 * import / remove routes reach into `ctx.settings.update(...)` to keep the
 * `installedSkills` registry in sync, and without this declaration Cordis
 * rejects the read with "cannot get property settings without inject".
 */
export const inject = ['webServer', 'clientModules', 'skills', 'agents', 'settings']

/** Plugin id — matches the package name and the client bundle graph row. */
const CLIENT_ID = 'whaletv-workbench'

/** This package's root directory (lib/index.js → lib → package root). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * All workbench routes live under this prefix. One `kind: 'prefix'`
 * registration owns dispatch on the sub-path, reducing seven separate
 * registrations to a single disposer.
 */
const ROUTE_PREFIX = '/whaletv/workbench'

/** Output captured per update step, truncated so JSON responses stay small. */
const MAX_STEP_OUTPUT = 32_000

/** Upper bounds for the payload the two JSON write routes accept. */
const MAX_CONFIG_BYTES = 512 * 1024
const MAX_SKILL_BYTES = 256 * 1024
const MAX_GROUPS = 50
const MAX_ITEMS_PER_GROUP = 200

/** Skill name must match dsh-skill's kebab-case identifier rule. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/**
 * Git URL surface accepted by the import route: HTTP(S) and SSH forms only.
 * File paths (`file://`, plain absolute paths) are rejected — importing from
 * a local directory would let anyone with route access clone off-disk stuff
 * into $DSH_HOME/skills. Ref (branch/tag) is validated separately.
 */
const GIT_URL_PATTERN = /^(https?:\/\/|git@[^\s:]+:|ssh:\/\/)/
/** Branch / tag / short SHA — no shell metacharacters, no path separators. */
const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/

const execFileAsync = promisify(execFile)

/**
 * pnpm 11 propagates its own workspace flags as `NPM_CONFIG_*` env vars
 * (chiefly `NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS`), which npm 11
 * warns about as an unknown env config. Strip the known offenders before
 * spawning any child so the noise never leaks into the plugin's captured
 * output. Only pnpm's own subprocesses need this var; dropping it at the
 * boundary does not disable the pnpm feature — pnpm still honors its
 * pnpm-workspace.yaml / .npmrc config sources inside the child.
 *
 * Also force git into non-interactive mode: our plugin subprocess has no
 * tty, so any credential prompt (git-credential-manager, ask-pass) hangs or
 * crashes. Setting `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=Never` makes
 * git fail fast with a readable "could not read Username" message when a
 * private repo needs auth that isn't already cached.
 */
const NOISY_NPM_ENV_VARS: readonly string[] = [
  'NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS',
  'npm_config_manage_package_manager_versions',
]
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of NOISY_NPM_ENV_VARS) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'Never'
  return env
}

/**
 * Recognize git errors that come from "no cached credentials for a private
 * repo" and the OAuth 2.0 `invalid_client` family enterprise GitHub returns
 * when SSO / OIDC rejects the HTTP Basic auth git tried. These are the
 * exact strings git / GCM / the OAuth server emit. When one hits we
 * replace the raw output with an actionable message pointing at the two
 * viable workarounds (SSH with configured keys, or an SSO-authorized PAT).
 */
const GIT_AUTH_ERROR_PATTERN =
  /could not read Username|Authentication failed|Interactive logon|Invalid username or password|fatal: unable to access|Permission denied \(publickey\)|Client authentication failed|unsupported authentication method|unknown client|invalid_client/i

function translateGitError(url: string, message: string): string {
  if (!GIT_AUTH_ERROR_PATTERN.test(message)) return message
  const isOAuth = /Client authentication failed|unsupported authentication method|unknown client|invalid_client/i.test(message)
  const header = isOAuth
    ? `仓库 ${url} 拒绝了 HTTP 基本认证 —— 这个 host 用了 OAuth/SSO 保护（企业版 GitHub / GitLab 常见）。`
    : `无法访问仓库（认证失败）：${url}`
  return [
    header,
    '',
    'git 命令行认证走不通 OAuth 流程；工作台子进程也没有交互终端。只有下面两条能跑通：',
    ' 1. 改用 SSH 地址（git@host:owner/repo.git）+ 事先配好的 SSH key —— 完全绕开 HTTPS/OAuth。',
    ' 2. 生成 Personal Access Token 并在企业 GHE 后台点「Enable SSO」授权该 token 通过 SSO；然后用 https://<user>:<token>@host/... 格式填进 URL 框。',
    '',
    `原始错误：${message.split('\n').slice(0, 6).join(' ｜ ')}`,
  ].join('\n')
}

/** $DSH_HOME resolution, matching what the launcher and other bundles use. */
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
/** dsh-skill-filesystem user-dsh root (rank 400). Written by the install route. */
const USER_DSH_SKILLS_DIR = join(DSH_HOME, 'skills')
/** Workbench-owned state directory (installed-skill registry, workbench.json). */
const WORKBENCH_STATE_DIR = join(DSH_HOME, 'whaletv-workbench')
const WORKBENCH_CONFIG_PATH = join(WORKBENCH_STATE_DIR, 'workbench.json')
/** Staging root for shallow git clones during skill import; entries are removed after copy. */
const IMPORT_STAGING_DIR = join(WORKBENCH_STATE_DIR, '.staging')
/** Legacy config location — read once for backward-compat, then migrated. */
const LEGACY_CONFIG_PATH = join(PACKAGE_DIR, 'config', 'workbench.json')
/** Rolling self-update history (roadmap P1-9): the last N update attempts. */
const UPDATE_HISTORY_PATH = join(WORKBENCH_STATE_DIR, 'updates.json')
const MAX_HISTORY_ENTRIES = 20
/** How many incoming commits the update checker lists. */
const MAX_CHECK_COMMITS = 20
/** SHA accepted by the skip route: short (≥7) or full hex. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i

/**
 * Launch-usage ledger (roadmap P2-12): `{ [itemId]: { count, lastUsed } }`,
 * feeding the panel's 最近使用 rail. Capped by lastUsed recency.
 */
const USAGE_PATH = join(WORKBENCH_STATE_DIR, 'usage.json')
const MAX_USAGE_ENTRIES = 500
/**
 * Skill versioning records (roadmap P3-20): one line per workbench-installed
 * skill with its Git origin / SHA / sub-path, enabling the per-skill
 * "检查更新" (P3-21). Plain Host-owned JSON — not a settings field — so the
 * settings schema stays flat and old user layers never need migrating.
 */
const INSTALLED_RECORDS_PATH = join(WORKBENCH_STATE_DIR, 'installed-skills.json')
/** Per-probe timeout for the reachability checker (roadmap P2-16). */
const HEALTH_TIMEOUT_MS = 5_000
/** Favicon cache (roadmap P2-17): per-origin icons under the state dir. */
const ICON_DIR = join(WORKBENCH_STATE_DIR, 'icons')
const ICON_MAX_BYTES = 512 * 1024
/**
 * Hostnames the favicon proxy refuses: loopback / link-local / RFC1918
 * literals and localhost. A local dashboard could otherwise be talked into
 * fetching intranet URLs. DNS rebinding is out of scope for a 127.0.0.1
 * tool (documented tradeoff, mirrors the git-import URL posture).
 */
const PRIVATE_HOST_PATTERN = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]$|\[fc|\[fd|\[fe80)/i

/**
 * Resolve spawn options for this platform: npm/pnpm are .cmd shims on
 * Windows and must run through the shell; git.exe spawns directly.
 * @param command - bare command name (git / pnpm).
 * @returns the execFile options for one invocation.
 */
function spawnOptions(command: string): { shell: boolean } {
  const needsShell = process.platform === 'win32' && (command === 'pnpm' || command === 'npm')
  return { shell: needsShell }
}

/**
 * Run one command; returns merged trimmed output. Defaults cwd to this
 * plugin's package dir (where git operations for self-update live), but the
 * skill-import route overrides cwd so clones happen in the staging root.
 */
async function run(command: string, args: string[], cwd: string = PACKAGE_DIR): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: sanitizedEnv(),
      ...spawnOptions(command),
    })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    const detail = failure.message ?? String(error)
    throw new Error(output === '' ? detail : `${output}\n${detail}`)
  }
}

/** git output, or undefined when the directory is not a git work tree. */
async function git(args: string[]): Promise<string | undefined> {
  try {
    return await run('git', args)
  } catch {
    return undefined
  }
}

/** Trim one step's captured output to the response budget. */
function truncate(output: string): string {
  if (output.length <= MAX_STEP_OUTPUT) return output
  return `${output.slice(0, MAX_STEP_OUTPUT)}\n… (已截断)`
}

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
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        fail(`请求体过大（超过 ${maxBytes / 1024}KB）`)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法的 JSON'))
      }
    })
    req.on('error', () => { fail('读取请求体失败') })
  })
}

/**
 * Trim a string field: non-strings and blank strings collapse to undefined
 * (the field is dropped from the persisted item).
 */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

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
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

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
    git: {
      configured: head !== undefined,
      ...(branch !== undefined ? { branch } : {}),
      ...(head !== undefined ? { head } : {}),
      ...(remote !== undefined ? { remote } : {}),
    },
    config: readConfig(),
  }
}

/** Send one JSON response with a UTF-8 content type. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-cache',
  })
  res.end(payload)
}

/**
 * Run the self-update pipeline and record the attempt into the rolling
 * history (roadmap P1-9). Never throws: every failure returns an
 * actionable { ok: false, error } result. History writes are best-effort —
 * a broken updates.json must never turn a good update into a panel error.
 */
async function runUpdate(ctx: Context): Promise<WorkbenchUpdateResult> {
  const startedAt = new Date()
  const result = await runUpdatePipeline(ctx)
  appendUpdateHistory({
    time: startedAt.toISOString(),
    ok: result.ok,
    ...(result.changed !== undefined ? { changed: result.changed } : {}),
    ...(result.rebuilt !== undefined ? { rebuilt: result.rebuilt } : {}),
    ...(result.needRestart !== undefined ? { needRestart: result.needRestart } : {}),
    ...(result.before !== undefined ? { before: result.before } : {}),
    ...(result.after !== undefined ? { after: result.after } : {}),
    ...(result.ok ? {} : { error: result.error }),
  })
  return result
}

/** The git → install → bundle → hot-inject pipeline proper (no history side effects). */
async function runUpdatePipeline(ctx: Context): Promise<WorkbenchUpdateResult> {
  const before = await git(['rev-parse', 'HEAD'])
  if (before === undefined) {
    return { ok: false, error: '插件目录不是 git 仓库（git rev-parse 失败）。请先在本目录 git init 并关联远程仓库，或直接编辑源码后手动运行 pnpm run bundle。' }
  }
  const remote = await git(['remote', 'get-url', 'origin'])
  if (remote === undefined || remote.trim() === '') {
    return { ok: false, error: '未配置 git 远程仓库（origin）。请先执行 git remote add origin <仓库地址> 再重试。' }
  }
  try {
    const pullOutput = await run('git', ['pull', '--ff-only'])
    const after = await git(['rev-parse', 'HEAD'])
    const changed = after !== before
    let installOutput = ''
    let bundleOutput = ''
    let rebuilt = false
    if (changed) {
      installOutput = await run('pnpm', ['install', '--no-frozen-lockfile'])
      installOutput += `\n${await run(process.execPath, ['scripts/link-harness-deps.mjs'])}`
      bundleOutput = await run('pnpm', ['run', 'bundle'])
      ctx.clientModules.rebuilt(CLIENT_ID)
      rebuilt = true
    }
    const output = [
      `$ git pull --ff-only\n${pullOutput}`,
      changed ? `\n$ pnpm install\n${installOutput}` : '',
      changed ? `\n$ pnpm run bundle\n${bundleOutput}` : '',
    ].filter(part => part !== '').join('\n')
    // needRestart only matters when the HOST bundle's inputs moved:
    // lib/index.js is built from src/index.ts, while tsdown.config.ts and
    // package.json can change how every face builds (externals, deps,
    // prepare scripts). A client-only diff hot-injects without a restart,
    // so asking for one every pull was noise. Unknown diff → ask (safe).
    let serverChanged = true
    if (changed && before !== undefined && after !== undefined) {
      const touched = await git(['diff', '--name-only', before, after, '--', 'src/index.ts', 'tsdown.config.ts', 'package.json'])
      serverChanged = touched === undefined || touched.trim() !== ''
    }
    return {
      ok: true,
      changed,
      rebuilt,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      output: truncate(output),
      needRestart: changed && serverChanged,
    }
  } catch (error) {
    return { ok: false, error: truncate(String(error instanceof Error ? error.message : error)) }
  }
}

/**
 * Update checker (roadmap P1-8): fetch the origin remote and compare HEAD
 * against its upstream — ahead/behind counts plus the newest incoming commit
 * subjects — without touching the working tree. `skippedHead` is the user's
 * skip marker; when the remote head equals it the result is flagged so the
 * panel can show "skipped" instead of nagging. Never throws.
 */
async function runUpdateCheck(skippedHead: string): Promise<WorkbenchUpdateCheckResult> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === undefined) {
    return { ok: false, upToDate: false, error: '插件目录不是 git 仓库，无法检查更新。请先关联远程仓库。' }
  }
  let upstream = branch === 'HEAD'
    ? undefined
    : await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream === undefined || upstream.trim() === '') upstream = `origin/${branch}`
  // A fetch failure (offline, auth, bad remote) surfaces as a readable error
  // rather than a stale "already up to date" — the check is only honest when
  // the remote refs are fresh.
  try {
    await run('git', ['fetch', '--quiet', upstream.includes('/') ? upstream.slice(0, upstream.indexOf('/')) : 'origin'])
  } catch (error) {
    return {
      ok: false, upToDate: false, branch, upstream,
      error: truncate(`git fetch 失败：${String(error instanceof Error ? error.message : error)}`),
    }
  }
  const behindOut = await git(['rev-list', '--count', `HEAD..${upstream}`])
  const aheadOut = await git(['rev-list', '--count', `${upstream}..HEAD`])
  const behind = behindOut === undefined ? undefined : Number.parseInt(behindOut.trim(), 10)
  const ahead = aheadOut === undefined ? undefined : Number.parseInt(aheadOut.trim(), 10)
  if (behind === undefined || Number.isNaN(behind) || ahead === undefined || Number.isNaN(ahead)) {
    return {
      ok: false, upToDate: false, branch, upstream,
      error: '无法比较本地与远端（git rev-list 失败）——请确认分支 upstream 有效。',
    }
  }
  const commits: Array<{ sha: string; subject: string }> = []
  if (behind > 0) {
    const logOutput = await git(['log', '--oneline', '--no-decorate', `-${Math.min(behind, MAX_CHECK_COMMITS)}`, `HEAD..${upstream}`])
    for (const line of (logOutput ?? '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const split = trimmed.indexOf(' ')
      commits.push(split > 0
        ? { sha: trimmed.slice(0, split), subject: trimmed.slice(split + 1) }
        : { sha: trimmed, subject: trimmed })
    }
  }
  const remoteHead = behind > 0 ? (await git(['rev-parse', '--short', upstream]))?.trim() : undefined
  const marker = skippedHead.trim()
  return {
    ok: true,
    branch,
    upstream,
    upToDate: behind === 0,
    behind,
    ahead,
    ...(remoteHead !== undefined && remoteHead !== '' ? { remoteHead } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(marker !== '' && remoteHead !== undefined && remoteHead !== '' && remoteHead === marker ? { skipped: true } : {}),
  }
}

/** Read the rolling update history; a missing/corrupt file is simply empty. */
function readUpdateHistory(): WorkbenchUpdateHistoryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(UPDATE_HISTORY_PATH, 'utf8')) as { entries?: unknown }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter((entry): entry is WorkbenchUpdateHistoryEntry => {
      return entry !== null && typeof entry === 'object'
        && typeof (entry as WorkbenchUpdateHistoryEntry).time === 'string'
        && typeof (entry as WorkbenchUpdateHistoryEntry).ok === 'boolean'
    })
  } catch {
    return []
  }
}

/** Append one attempt to the rolling history (newest first), capped, atomic. */
function appendUpdateHistory(entry: WorkbenchUpdateHistoryEntry): void {
  try {
    const entries = [entry, ...readUpdateHistory()].slice(0, MAX_HISTORY_ENTRIES)
    mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
    const tmp = `${UPDATE_HISTORY_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8')
    renameSync(tmp, UPDATE_HISTORY_PATH)
  } catch {
    // Best-effort: history loss is acceptable, update failures are not.
  }
}

/** Read the skill versioning records (roadmap P3-20); missing file is empty. */
function readInstalledRecords(): WorkbenchInstalledSkill[] {
  try {
    const parsed = JSON.parse(readFileSync(INSTALLED_RECORDS_PATH, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { skills?: unknown }).skills)) {
      return []
    }
    return ((parsed as { skills: unknown[] }).skills).filter((entry): entry is WorkbenchInstalledSkill => {
      const record = entry as WorkbenchInstalledSkill
      return entry !== null && typeof entry === 'object'
        && typeof record.name === 'string' && record.name !== ''
        && typeof record.installedAt === 'string'
    })
  } catch {
    return []
  }
}

/** Merge new/updated records by name and persist atomically (roadmap P3-20). */
function upsertInstalledRecords(incoming: WorkbenchInstalledSkill[]): void {
  if (incoming.length === 0) return
  const byName = new Map(readInstalledRecords().map(record => [record.name, record]))
  for (const record of incoming) byName.set(record.name, record)
  const merged = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  try {
    mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
    const tmp = `${INSTALLED_RECORDS_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ skills: merged }, null, 2)}\n`, 'utf8')
    renameSync(tmp, INSTALLED_RECORDS_PATH)
  } catch {
    // Best-effort: losing versioning metadata must not fail the install.
  }
}

/** Drop records whose names are gone (post-remove), atomic, best-effort. */
function pruneInstalledRecords(names: readonly string[]): void {
  if (names.length === 0) return
  const drop = new Set(names)
  const remaining = readInstalledRecords().filter(record => !drop.has(record.name))
  try {
    mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
    const tmp = `${INSTALLED_RECORDS_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ skills: remaining }, null, 2)}\n`, 'utf8')
    renameSync(tmp, INSTALLED_RECORDS_PATH)
  } catch {
    // Best-effort.
  }
}

/**
 * Roll the working tree back to the state before the last successful update
 * (roadmap P1-9): reset --hard to that entry's `before` SHA, rebuild the
 * bundle, and hot-inject. Refuses a dirty worktree — a reset would destroy
 * local edits. Never throws.
 */
async function runUpdateRollback(ctx: Context): Promise<WorkbenchUpdateRollbackResult> {
  const lastOk = readUpdateHistory().find(entry => entry.ok === true && entry.changed === true && typeof entry.before === 'string')
  if (lastOk === undefined) {
    return { ok: false, error: '没有可回滚的成功更新记录（updates.json 为空或全部失败）。' }
  }
  const dirty = await git(['status', '--porcelain'])
  if (dirty !== undefined && dirty.trim() !== '') {
    return { ok: false, error: '工作区有未提交的本地修改，回滚会丢弃它们；请先 commit / stash 再试。' }
  }
  const target = lastOk.before as string
  try {
    const resetOutput = await run('git', ['reset', '--hard', target])
    const bundleOutput = await run('pnpm', ['run', 'bundle'])
    ctx.clientModules.rebuilt(CLIENT_ID)
    appendUpdateHistory({
      time: new Date().toISOString(),
      ok: true,
      changed: true,
      rebuilt: true,
      needRestart: true,
      after: target,
    })
    return {
      ok: true,
      revertedTo: target,
      output: truncate(`$ git reset --hard ${target}\n${resetOutput}\n$ pnpm run bundle\n${bundleOutput}`),
      needRestart: true,
    }
  } catch (error) {
    const message = truncate(String(error instanceof Error ? error.message : error))
    appendUpdateHistory({ time: new Date().toISOString(), ok: false, error: `rollback: ${message}` })
    return { ok: false, error: message }
  }
}

/**
 * Clear the skip marker after a successful update moved to a new head — the
 * reminder re-arms for whatever comes next. Best-effort; never throws.
 */
async function clearSkippedHead(ctx: Context): Promise<void> {
  try {
    const settings = ctx.get('settings')
    if (settings) await settings.update(WORKBENCH_NAMESPACE, { skippedHead: '' })
  } catch (settingsError) {
    ctx.logger?.warn?.(`whaletv-workbench: skippedHead reset skipped: ${settingsError}`)
  }
}

interface UsageRecord {
  count: number
  lastUsed: string
}

/** Read the usage ledger; a missing/corrupt file is simply empty. */
function readUsage(): Record<string, UsageRecord> {
  try {
    const parsed = JSON.parse(readFileSync(USAGE_PATH, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    const usage: Record<string, UsageRecord> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as UsageRecord
      if (typeof record?.count === 'number' && typeof record?.lastUsed === 'string') {
        usage[id] = { count: record.count, lastUsed: record.lastUsed }
      }
    }
    return usage
  } catch {
    return {}
  }
}

/** Increment one item's launch counter, pruning the ledger to the most recent ids. */
function recordUsage(itemId: string): void {
  if (itemId === '' || itemId.length > 128) return
  try {
    const usage = readUsage()
    const previous = usage[itemId]
    usage[itemId] = {
      count: (previous?.count ?? 0) + 1,
      lastUsed: new Date().toISOString(),
    }
    const capped = Object.entries(usage)
      .sort(([, a], [, b]) => (a.lastUsed < b.lastUsed ? 1 : -1))
      .slice(0, MAX_USAGE_ENTRIES)
    mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
    const tmp = `${USAGE_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(capped), null, 2)}\n`, 'utf8')
    renameSync(tmp, USAGE_PATH)
  } catch {
    // Best-effort telemetry for a UI rail — never fail the launch itself.
  }
}

/**
 * One entry's reachability probe (roadmap P2-16): HEAD with a GET fallback
 * for sites that reject HEAD (403/405), path existence for local targets.
 */
async function checkEntryHealth(item: WorkbenchItem): Promise<{ ok: boolean; detail?: string }> {
  if (item.url !== undefined && item.url !== '') {
    const probe = async (method: 'HEAD' | 'GET'): Promise<{ ok: boolean; detail: string }> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
      try {
        const response = await fetch(item.url!, { method, redirect: 'follow', signal: controller.signal })
        return { ok: response.status < 400, detail: `HTTP ${response.status}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, detail: message === 'This operation was aborted' ? `超时（>${HEALTH_TIMEOUT_MS / 1000}s）` : message }
      } finally {
        clearTimeout(timer)
      }
    }
    const head = await probe('HEAD')
    if (head.ok || head.detail === 'HTTP 404') return head
    // 403/405 HEAD rejections are common (bot shields, framework routing) —
    // retry once with GET before declaring the entry down.
    return probe('GET')
  }
  if (item.path !== undefined && item.path !== '') {
    return existsSync(item.path) ? { ok: true, detail: '路径存在' } : { ok: false, detail: '路径不存在' }
  }
  return { ok: false, detail: '未配置目标' }
}

/** Probe every entry in the config (roadmap P2-16), keyed by item id. */
async function runHealthCheck(config: WorkbenchConfig): Promise<Record<string, { ok: boolean; detail?: string }>> {
  const results: Record<string, { ok: boolean; detail?: string }> = {}
  for (const group of config.groups) {
    for (const item of group.items) {
      results[item.id] = await checkEntryHealth(item)
    }
  }
  return results
}

/**
 * Whether a favicon origin may be fetched: http(s) only, non-private host.
 * @returns an error reason, or undefined when allowed.
 */
function faviconOriginError(origin: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return 'URL 无法解析'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '仅支持 http(s)'
  if (parsed.pathname !== '/' && parsed.pathname !== '') return '只接受 origin（协议+主机），忽略路径'
  if (PRIVATE_HOST_PATTERN.test(parsed.hostname)) return '拒绝内网 / 环回地址'
  return undefined
}

/** Per-origin cache filename for the favicon proxy. */
function faviconFile(origin: string): string {
  const hash = createHash('sha1').update(origin).digest('hex').slice(0, 16)
  return join(ICON_DIR, `${hash}.ico`)
}

const FAVICON_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

/**
 * Serve a cached favicon for the given origin (roadmap P2-17), downloading
 * `<origin>/favicon.ico` on first use. Cache-forever per origin (the file is
 * content-addressed by origin); 404 when uncached and unfetchable — the
 * panel hides the img on error.
 */
async function serveFavicon(url: string): Promise<{ status: number; contentType: string; body: Buffer; cache: string }> {
  const originError = faviconOriginError(url)
  if (originError !== undefined) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(originError), cache: 'no-store' }
  }
  mkdirSync(ICON_DIR, { recursive: true })
  const cached = faviconFile(url)
  if (existsSync(cached)) {
    const ext = cached.slice(cached.lastIndexOf('.'))
    return {
      status: 200,
      contentType: FAVICON_MIME_BY_EXT[ext] ?? 'application/octet-stream',
      body: readFileSync(cached),
      cache: 'public, max-age=604800',
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(new URL('/favicon.ico', url), { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) {
      return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('favicon 不可用'), cache: 'no-store' }
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const ext = Object.entries(FAVICON_MIME_BY_EXT).find(([, mime]) => mime === contentType)?.[0] ?? '.ico'
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > ICON_MAX_BYTES) {
      return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('favicon 尺寸异常'), cache: 'no-store' }
    }
    const target = cached.slice(0, cached.lastIndexOf('.')) + ext
    writeFileSync(target, buffer)
    return { status: 200, contentType: contentType !== '' ? contentType : 'image/x-icon', body: buffer, cache: 'public, max-age=604800' }
  } catch (error) {
    return {
      status: 404,
      contentType: 'text/plain; charset=utf-8',
      body: Buffer.from(`favicon 抓取失败：${error instanceof Error ? error.message : String(error)}`),
      cache: 'no-store',
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Return the on-disk absolute path of a workbench-managed skill (directory
 * bundle preferred; flat markdown accepted for compatibility with the
 * dsh-skill-filesystem provider).
 */
function findManagedSkillPath(name: string): string | undefined {
  const bundleDir = join(USER_DSH_SKILLS_DIR, name)
  const bundleSkill = join(bundleDir, 'SKILL.md')
  if (existsSync(bundleSkill)) return bundleSkill
  const flat = join(USER_DSH_SKILLS_DIR, `${name}.md`)
  if (existsSync(flat)) return flat
  return undefined
}

/**
 * Diagnostic payload for the "file on disk but not visible" case. Surfaces
 * both what our Host thinks is the user-dsh root and what dsh's own skill
 * registry returns from a live `snapshot()`, alongside relevant env vars.
 * When they diverge, the mismatch shape (path differs, catalog empty, or
 * both) tells us which layer to fix.
 */
async function buildSkillDebug(ctx: Context): Promise<Record<string, unknown>> {
  let userDshSkillsContents: string[] = []
  let readError: string | undefined
  try {
    if (existsSync(USER_DSH_SKILLS_DIR)) {
      userDshSkillsContents = readdirSync(USER_DSH_SKILLS_DIR)
    }
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }
  let snapshot: unknown
  let snapshotError: string | undefined
  try {
    snapshot = await ctx.skills.snapshot({})
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error)
  }
  return {
    ok: true,
    workbenchView: {
      dshHome: DSH_HOME,
      userDshSkillsDir: USER_DSH_SKILLS_DIR,
      userDshSkillsExists: existsSync(USER_DSH_SKILLS_DIR),
      userDshSkillsContents,
      ...(readError !== undefined ? { readError } : {}),
    },
    env: {
      DSH_HOME: process.env.DSH_HOME ?? null,
      DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,
      DSH_BUNDLED_SKILL_DIR: process.env.DSH_BUNDLED_SKILL_DIR ?? null,
      USERPROFILE: process.env.USERPROFILE ?? null,
      HOME: process.env.HOME ?? null,
      cwd: process.cwd(),
    },
    dshRegistry: {
      snapshot,
      ...(snapshotError !== undefined ? { snapshotError } : {}),
    },
  }
}

/**
 * Assemble the GET /whaletv/workbench/skills payload from ctx.skills'
 * catalog. `removable` is true only for skills whose files live inside
 * $DSH_HOME/skills — those the install route wrote or the user placed by
 * hand under our root. Skills from project/agent/bundled sources are read-only.
 */
async function buildSkillList(
  ctx: Context, installed: readonly string[], records: readonly WorkbenchInstalledSkill[],
): Promise<WorkbenchSkillList> {
  try {
    const snap = await ctx.skills.snapshot({})
    const installedSet = new Set(installed)
    const recordByName = new Map(records.map(record => [record.name, record]))
    const skills: WorkbenchSkillSummary[] = snap.skills.map(s => ({
      name: s.name,
      description: s.description,
      ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
      source: s.source,
      provider: s.provider,
      // Removable only when this workbench wrote it OR it landed under our
      // user-dsh root (safe to delete without touching project/agent roots).
      removable: installedSet.has(s.name) || findManagedSkillPath(s.name) !== undefined,
      ...(recordByName.has(s.name) ? { origin: recordByName.get(s.name) } : {}),
    }))
    return { ok: true, skills, complete: snap.complete }
  } catch (error) {
    return {
      ok: false, skills: [], complete: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Write a skill definition into `$DSH_HOME/skills/<name>/SKILL.md` and add
 * its name to the installed-skills registry. Chokidar inside
 * dsh-skill-filesystem watches this root, so the model-facing catalog picks
 * the new skill up on its next `agent/pre-step`.
 */
function installSkillOnDisk(name: string, content: string): string {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`skill 名称必须为 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$），收到：${name}`)
  }
  const bundleDir = join(USER_DSH_SKILLS_DIR, name)
  mkdirSync(bundleDir, { recursive: true })
  const target = join(bundleDir, 'SKILL.md')
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, target)
  return target
}

/**
 * Shallow-clone a git repo and copy the skill body inside it into
 * `$DSH_HOME/skills/<name>/`. Supports both bundle form
 * (`<subPath>/SKILL.md` + adjacent resource files copied wholesale) and flat
 * form (`<subPath>.md` copied to `<name>.md`).
 *
 * Safety:
 *   - URL is restricted to http(s) / ssh — no `file://` or local paths.
 *   - `--` before the URL and dest prevents git from interpreting them as flags.
 *   - Ref is checked against `GIT_REF_PATTERN` — no `--upload-pack=` injection.
 *   - Resolved source path is verified to stay inside the staging tree so a
 *     malicious sub-path can't escape via `../..`.
 *   - Staging clone is removed on both success and failure.
 *
 * @returns installed names, per-skill source sub-paths (versioning records,
 *   roadmap P3-20), source head SHA, and captured git output
 */
async function importSkillFromGit(
  request: WorkbenchSkillImportRequest,
): Promise<{
  installed: string[]
  skipped?: Array<{ name: string; reason: string }>
  writtenTo?: string
  sha?: string
  sources?: Array<{ name: string; subPath: string }>
  output: string
}> {
  const targetName = request.name?.trim() ?? ''
  const url = request.url?.trim() ?? ''
  const subPath = request.subPath?.trim() ?? ''
  const ref = request.ref?.trim() ?? ''

  if (!SKILL_NAME_PATTERN.test(targetName)) {
    throw new Error(`目标名称必须为 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$），收到：${targetName || '<空>'}`)
  }
  // Reject names that clearly came from `SKILL.md` collapsing to `skill` —
  // that's the bundle filename convention, not a plausible skill identity.
  // The client's `suggestGitName` already handles this, but the Host stays
  // defensive so a hand-typed `skill` doesn't silently produce `skill.md`.
  if (/^skill(?:\.md)?$/i.test(targetName)) {
    throw new Error('名称 "skill" 冲突（SKILL.md 是 dsh 的 bundle 保留文件名）；请显式指定一个具体名称，例如 "whaletv-dev-power" / "agent-engineering-framework"。')
  }
  if (!GIT_URL_PATTERN.test(url)) {
    throw new Error(`仅支持 http/https/ssh 协议的 git 仓库地址；收到：${url || '<空>'}`)
  }
  if (ref !== '' && !GIT_REF_PATTERN.test(ref)) {
    throw new Error(`ref/branch 只能包含字母数字与 . _ - / ；收到：${ref}`)
  }
  if (subPath.includes('..')) {
    throw new Error('子路径不能包含 `..`（防止越权到仓库外）')
  }

  mkdirSync(IMPORT_STAGING_DIR, { recursive: true })
  const staging = mkdtempSync(join(IMPORT_STAGING_DIR, 'skill-'))

  try {
    // `--no-tags` cuts unrelated ref traffic; `--depth 1` keeps the clone small.
    const args = ['clone', '--depth', '1', '--no-tags', '--single-branch']
    if (ref !== '') args.push('--branch', ref)
    args.push('--', url, staging)
    let gitOutput: string
    try {
      gitOutput = await run('git', args, IMPORT_STAGING_DIR)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      // Nuke the failed clone before rethrowing — if we defer to the outer
      // finally on Windows, git.exe still holds handles on `.git/pack/*`
      // and rmSync silently leaves the half-clone behind. Ignore any
      // cleanup failure here so the translated error propagates cleanly.
      try { removeStagingSafely(staging) } catch { /* best-effort */ }
      throw new Error(translateGitError(url, raw))
    }

    // Resolve where the SKILL lives inside the freshly cloned tree. Node's
    // join collapses `..`, so verify the resolved absolute path is still
    // under the staging tree before touching anything (path-traversal guard).
    const source = subPath === '' ? staging : join(staging, subPath)
    if (!source.startsWith(staging)) {
      throw new Error(`子路径解析出的目录越权：${source}`)
    }
    if (!existsSync(source)) {
      throw new Error(`仓库里未找到子路径：${subPath === '' ? '<repo 根目录>' : subPath}`)
    }
    // Versioning (roadmap P3-20): capture the source head so the per-skill
    // "检查更新" can tell later installs apart from this exact commit.
    let sha: string | undefined
    try {
      sha = (await run('git', ['rev-parse', '--short', 'HEAD'], staging)).trim()
    } catch { /* versioning is best-effort; the install proceeds regardless */ }
    // Repo-relative source location per installed name — the versioning
    // record re-uses it to re-clone just that subtree on update.
    const sourcesFor = (names: readonly string[]): Array<{ name: string; subPath: string }> =>
      names.map(name => ({ name, subPath: subPath === '' ? '' : `${subPath.replace(/\/+$/, '')}/${name}` }))

    mkdirSync(USER_DSH_SKILLS_DIR, { recursive: true })
    const stat = statSync(source)

    const resolved = resolveSkillSource(source, stat)
    if (resolved.kind === 'bundle') {
      // Bundle form — one skill. `source` may have been walked one level up
      // when the user pointed subPath at a `SKILL.md` file directly.
      const dest = join(USER_DSH_SKILLS_DIR, targetName)
      installBundleDir(resolved.dir, dest, staging)
      return {
        installed: [targetName],
        writtenTo: join(dest, 'SKILL.md'),
        ...(sha !== undefined ? { sha } : {}),
        sources: [{ name: targetName, subPath }],
        output: gitOutput,
      }
    }
    if (resolved.kind === 'flat') {
      // Flat form — one Markdown file becomes `<name>.md` under the root.
      const dest = join(USER_DSH_SKILLS_DIR, `${targetName}.md`)
      if (existsSync(dest)) rmSync(dest, { force: true })
      cpSync(resolved.file, dest)
      return {
        installed: [targetName],
        writtenTo: dest,
        ...(sha !== undefined ? { sha } : {}),
        sources: [{ name: targetName, subPath }],
        output: gitOutput,
      }
    }
    if (resolved.kind === 'batch') {
      // Batch — one repo containing multiple `<child>/SKILL.md` bundles;
      // each child directory becomes its own skill under its own name.
      // The user-supplied `targetName` is ignored: batch identity is the
      // child dir name (validated kebab-case, skipped otherwise).
      const installed: string[] = []
      const skipped: Array<{ name: string; reason: string }> = []
      for (const child of resolved.children) {
        if (!SKILL_NAME_PATTERN.test(child)) {
          skipped.push({ name: child, reason: '目录名不是 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$）' })
          continue
        }
        if (/^skill(?:\.md)?$/i.test(child)) {
          skipped.push({ name: child, reason: '目录名与保留字冲突（SKILL.md 的 bundle 保留字）' })
          continue
        }
        const srcDir = join(resolved.root, child)
        const dest = join(USER_DSH_SKILLS_DIR, child)
        try {
          installBundleDir(srcDir, dest, staging)
          installed.push(child)
        } catch (error) {
          skipped.push({ name: child, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      if (installed.length === 0) {
        throw new Error(
          `在 ${subPath === '' ? '<repo 根目录>' : subPath} 找到 ${resolved.children.length} 个候选，但没有一个可以安装：\n`
          + skipped.map(s => ` - ${s.name}：${s.reason}`).join('\n'),
        )
      }
      return {
        installed,
        skipped: skipped.length > 0 ? skipped : undefined,
        // For single-batch-result the writtenTo shows the parent dir; the
        // frontend uses `installed` primarily for display.
        writtenTo: USER_DSH_SKILLS_DIR,
        ...(sha !== undefined ? { sha } : {}),
        sources: sourcesFor(installed),
        output: gitOutput,
      }
    }
    throw new Error(`在 ${subPath === '' ? '<repo 根目录>' : subPath} 未找到 SKILL.md 或 <name>.md，也没有子目录级别的 skill bundle`)
  } finally {
    // Clean up the staging clone on both success and failure. Errors here
    // are swallowed (best-effort) so they never mask a real earlier throw
    // that the caller cares about — the startup sweep will pick up any
    // orphan on the next plugin mount.
    try { removeStagingSafely(staging) } catch { /* best-effort */ }
  }
}

/**
 * Windows-friendly recursive delete: retry with a short delay so Node's
 * fs.rmSync can win the race against git.exe / antivirus still holding
 * handles on freshly-written `.git/pack/*` files right after clone.
 *
 * `maxRetries` + `retryDelay` are documented options on Node ≥ 14.14 and
 * are exactly designed for this scenario. `force: true` also overrides
 * the read-only bit git sets on pack files.
 */
function removeStagingSafely(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}

/**
 * Sweep any stale `skill-*` directories left behind by past failed clones
 * (Windows file-lock timing, dsh crashed mid-import, etc.). Runs once on
 * plugin mount as a best-effort — a single retry cycle here is enough
 * because whatever process was holding handles is long gone by now.
 */
function sweepStagingDir(): void {
  if (!existsSync(IMPORT_STAGING_DIR)) return
  try {
    for (const entry of readdirSync(IMPORT_STAGING_DIR)) {
      if (!entry.startsWith('skill-')) continue
      try { removeStagingSafely(join(IMPORT_STAGING_DIR, entry)) } catch { /* ignore */ }
    }
  } catch { /* ignore — sweep is best-effort */ }
}

/**
 * Copy one bundle directory into $DSH_HOME/skills/<name>/, dropping any
 * `.git` remains from the shallow clone. `staging` is only used to help
 * the filter recognize the git dir path prefix — everything is otherwise
 * relative to `srcDir`.
 */
function installBundleDir(srcDir: string, dest: string, staging: string): void {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  cpSync(srcDir, dest, {
    recursive: true,
    // POSIX-and-Windows-safe .git detection: check the trailing segment.
    filter: (src) => !src.startsWith(join(staging, '.git')) && basename(src) !== '.git',
  })
  const gitDir = join(dest, '.git')
  if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}

/**
 * Skill-source shape after resolving what the user's URL+sub-path pointed at.
 * `bundle` = one SKILL.md-anchored directory to copy wholesale.
 * `flat`   = a single `.md` file to copy as `<name>.md`.
 * `batch`  = a parent directory whose immediate children are each a bundle.
 * `none`   = no valid target — the caller throws.
 */
type SkillSource =
  | { kind: 'bundle'; dir: string }
  | { kind: 'flat'; file: string }
  | { kind: 'batch'; root: string; children: readonly string[] }
  | { kind: 'none' }

/**
 * Classify the cloned tree at `source` (may be a file or a directory).
 *
 * When source is a file:
 *   - `.../SKILL.md` → bundle (walk up one level to the enclosing dir)
 *   - `.../*.md` (any other markdown) → flat
 *   - otherwise → none
 *
 * When source is a directory:
 *   - `<source>/SKILL.md` exists → single bundle
 *   - one or more `<source>/<child>/SKILL.md` exists → batch (list children)
 *   - otherwise → none
 */
function resolveSkillSource(source: string, stat: Stats): SkillSource {
  if (stat.isFile()) {
    if (/^SKILL\.md$/i.test(basename(source))) {
      // User pointed at a SKILL.md — treat the enclosing directory as bundle
      // so assets, references, and scripts alongside it come along too.
      return { kind: 'bundle', dir: dirname(source) }
    }
    if (source.toLowerCase().endsWith('.md')) return { kind: 'flat', file: source }
    return { kind: 'none' }
  }
  if (!stat.isDirectory()) return { kind: 'none' }
  if (existsSync(join(source, 'SKILL.md'))) return { kind: 'bundle', dir: source }
  try {
    const children = readdirSync(source).filter(entry => {
      // Ignore hidden and `.git`; the child must be a directory containing SKILL.md.
      if (entry.startsWith('.')) return false
      const childDir = join(source, entry)
      let childStat: Stats
      try { childStat = statSync(childDir) } catch { return false }
      if (!childStat.isDirectory()) return false
      return existsSync(join(childDir, 'SKILL.md'))
    })
    if (children.length > 0) return { kind: 'batch', root: source, children }
  } catch { /* fall through */ }
  return { kind: 'none' }
}

/**
 * Rank at which our workbench-owned provider announces its skills.
 *
 * dsh-skill-filesystem's `user-dsh` root sits at rank 400; we register at
 * 450 so when both providers work the built-in wins duplicate names by
 * rank. When dsh's provider isn't functioning (missing config, schema
 * quirk, chokidar didn't fire on Windows), ours still surfaces the file
 * — which is the reason this provider exists at all.
 */
const WORKBENCH_PROVIDER_RANK = 450
const WORKBENCH_PROVIDER_NAME = 'whaletv-workbench-user-dsh'

/** YAML frontmatter fields the panel and the model catalog care about. */
interface SkillFrontmatter {
  name?: string
  description?: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
}

/**
 * Parse the leading YAML frontmatter block of a SKILL.md. Returns empty
 * front + full body when the file lacks frontmatter, so downstream logic
 * can still surface the skill under its directory / filename identity.
 */
function parseFrontmatter(raw: string): { front: SkillFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (match === null) return { front: {}, body: raw }
  try {
    const parsed = parseYaml(match[1] ?? '') as Record<string, unknown> | null
    const front: SkillFrontmatter = {}
    if (parsed !== null && typeof parsed === 'object') {
      if (typeof parsed.name === 'string') front.name = parsed.name
      if (typeof parsed.description === 'string') front.description = parsed.description
      const whenToUse = parsed['when-to-use'] ?? parsed.whenToUse
      if (typeof whenToUse === 'string') front.whenToUse = whenToUse
      if (typeof parsed['disable-model-invocation'] === 'boolean') front.disableModelInvocation = parsed['disable-model-invocation'] as boolean
      if (typeof parsed['user-invocable'] === 'boolean') front.userInvocable = parsed['user-invocable'] as boolean
    }
    return { front, body: match[2] ?? '' }
  } catch {
    return { front: {}, body: raw }
  }
}

/**
 * Scan `$DSH_HOME/skills` for the two skill shapes dsh accepts:
 *   - `<name>/SKILL.md` bundle (returned with `resourcePath` = the dir)
 *   - `<name>.md` flat file
 * Names must be kebab-case; everything else is skipped without noise.
 */
interface WorkbenchSkillEntry {
  name: string
  path: string
  resourcePath?: string
}
function discoverWorkbenchSkills(): WorkbenchSkillEntry[] {
  if (!existsSync(USER_DSH_SKILLS_DIR)) return []
  const results: WorkbenchSkillEntry[] = []
  let entries: string[]
  try { entries = readdirSync(USER_DSH_SKILLS_DIR) } catch { return [] }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const abs = join(USER_DSH_SKILLS_DIR, entry)
    let stats: Stats
    try { stats = statSync(abs) } catch { continue }
    if (stats.isDirectory()) {
      const skillMd = join(abs, 'SKILL.md')
      if (existsSync(skillMd) && SKILL_NAME_PATTERN.test(entry)) {
        results.push({ name: entry, path: skillMd, resourcePath: abs })
      }
    } else if (stats.isFile() && entry.toLowerCase().endsWith('.md')) {
      const name = entry.slice(0, -3)
      if (SKILL_NAME_PATTERN.test(name)) {
        results.push({ name, path: abs })
      }
    }
  }
  return results
}

/**
 * Register a workbench-owned skill provider scanning `$DSH_HOME/skills`.
 * Held in a closure so the write routes can `invalidate()` after modifying
 * the folder — dsh-skill-filesystem's chokidar can miss fresh writes on
 * Windows, so an explicit invalidation makes catalog updates deterministic.
 *
 * @returns the invalidator, callable by handlers after a disk mutation.
 */
function registerWorkbenchSkillProvider(ctx: Context): { invalidate: () => void } {
  const ref: { invalidate: () => void } = { invalidate: () => { /* replaced on register */ } }
  ctx.skills.registerProvider((control: SkillProviderControl) => {
    ref.invalidate = control.invalidate
    return {
      name: WORKBENCH_PROVIDER_NAME,
      list: async (_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> => {
        return discoverWorkbenchSkills().map((entry): SkillCandidate => {
          let front: SkillFrontmatter = {}
          try { front = parseFrontmatter(readFileSync(entry.path, 'utf8')).front } catch { /* keep defaults */ }
          // Prefer the on-disk directory / filename identity: it's what the
          // panel uses to name and remove skills. Frontmatter is auxiliary.
          const name = entry.name
          return {
            name,
            description: front.description ?? '',
            ...(front.whenToUse !== undefined ? { whenToUse: front.whenToUse } : {}),
            invocation: {
              modelInvocable: !(front.disableModelInvocation ?? false),
              userInvocable: front.userInvocable ?? true,
            },
            source: 'user-dsh',
            provider: WORKBENCH_PROVIDER_NAME,
            rank: WORKBENCH_PROVIDER_RANK,
            locator: entry.path,
            path: entry.path,
            ...(entry.resourcePath !== undefined
              ? { resourceBase: { kind: 'directory', path: entry.resourcePath } }
              : {}),
          }
        })
      },
      get: async (candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> => {
        const path = typeof candidate.locator === 'string' ? candidate.locator : undefined
        if (path === undefined || !existsSync(path)) return undefined
        try {
          const raw = readFileSync(path, 'utf8')
          const { body } = parseFrontmatter(raw)
          return { ...candidate, content: body, path } as SkillDefinition
        } catch {
          return undefined
        }
      },
    }
  })
  return ref
}

/**
 * Remove a workbench-installed skill directory. Refuses to touch anything
 * outside `$DSH_HOME/skills` — the only place install writes to.
 */
function removeSkillOnDisk(name: string): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`skill 名称必须为 kebab-case，收到：${name}`)
  }
  const bundleDir = join(USER_DSH_SKILLS_DIR, name)
  const flat = join(USER_DSH_SKILLS_DIR, `${name}.md`)
  // Prefer bundle removal when both shapes exist.
  if (existsSync(bundleDir) && statSync(bundleDir).isDirectory()) {
    rmSync(bundleDir, { recursive: true, force: true })
    return
  }
  if (existsSync(flat)) {
    rmSync(flat, { force: true })
    return
  }
  throw new Error(`未找到 skill：${name}（工作台只能删除自己写入 $DSH_HOME/skills 的 skill）`)
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

  // Live source thunk: `installSection` swaps this to read from the
  // settings scope once one is attached. Everything Host-side that needs the
  // current value goes through `source()`, so live edits flow immediately.
  let source: () => Config = () => config

  // dsh ≥ 0.1.2: the standalone `installSettingsSection` helper was folded
  // into the settings service as `SettingsProvider.installSection(owner, ns,
  // schema, entry, hooks)` — same layering (entry = composition base), same
  // hooks shape ({ setSource, onChange }).
  ctx.settings.installSection(ctx, WORKBENCH_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => { /* live-applied fields; nothing derived to invalidate today. */ },
  })

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
          void runUpdate(ctx).then(
            result => {
              // A successful move invalidates any "skip this version" marker.
              if (result.ok && result.changed === true) void clearSkippedHead(ctx)
              sendJson(res, result.ok ? 200 : 500, result)
            },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          ).finally(() => { updating = false })
          return
        }

        // GET /update/check — fetch + ahead/behind + incoming commit list,
        // no working-tree changes (roadmap P1-8).
        if (sub === '/update/check' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void runUpdateCheck(source().skippedHead).then(
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
                const settings = ctx.get('settings')
                if (settings) await settings.update(WORKBENCH_NAMESPACE, { skippedHead: sha.toLowerCase() })
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
          void buildSkillList(ctx, source().installedSkills, readInstalledRecords()).then(
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
                // Reflect ownership in the settings namespace so a later
                // `/skills` read marks this skill as removable across restarts.
                const current = source()
                if (!current.installedSkills.includes(skillName)) {
                  try {
                    const settings = ctx.get('settings')
                    if (settings) {
                      await settings.update(WORKBENCH_NAMESPACE, {
                        installedSkills: [...current.installedSkills, skillName],
                      })
                    }
                  } catch (settingsError) {
                    // Non-fatal: skill is on disk, ownership tracking is best-effort.
                    ctx.logger?.warn?.(`whaletv-workbench: settings update skipped: ${settingsError}`)
                  }
                }
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
                // Track ownership across restarts. Batch install may return
                // multiple names — union them all into installedSkills.
                const current = source()
                const merged = Array.from(new Set([...current.installedSkills, ...outcome.installed]))
                if (merged.length !== current.installedSkills.length) {
                  try {
                    const settings = ctx.get('settings')
                    if (settings) {
                      await settings.update(WORKBENCH_NAMESPACE, { installedSkills: merged })
                    }
                  } catch (settingsError) {
                    // Non-fatal: skill is on disk, ownership tracking is best-effort.
                    console.warn(`whaletv-workbench: settings update skipped: ${String(settingsError)}`)
                  }
                }
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
                const current = source()
                if (current.installedSkills.includes(skillName)) {
                  try {
                    const settings = ctx.get('settings')
                    if (settings) {
                      await settings.update(WORKBENCH_NAMESPACE, {
                        installedSkills: current.installedSkills.filter(n => n !== skillName),
                      })
                    }
                  } catch (settingsError) {
                    // Non-fatal: skill is removed from disk, ownership tracking is best-effort.
                    ctx.logger?.warn?.(`whaletv-workbench: settings update skipped: ${settingsError}`)
                  }
                }
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
