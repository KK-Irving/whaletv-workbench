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
 *   GET  /skills             → invocation-neutral summaries from ctx.skills
 *   POST /skills/install     → write a workbench-owned skill into
 *                              $DSH_HOME/skills/<name>/SKILL.md and record it
 *   POST /skills/import      → shallow-clone a git repo and copy the named
 *                              skill body (bundle or flat markdown) into
 *                              $DSH_HOME/skills/<name>/
 *   POST /skills/remove      → remove a workbench-owned skill's dir
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
  WorkbenchConfig, WorkbenchGroup, WorkbenchItem, WorkbenchSessionFollowupRequest,
  WorkbenchSessionFollowupResult, WorkbenchSkillImportRequest, WorkbenchSkillImportResult,
  WorkbenchSkillInstallRequest, WorkbenchSkillInstallResult, WorkbenchSkillList,
  WorkbenchSkillRemoveRequest, WorkbenchSkillRemoveResult, WorkbenchSkillSummary, WorkbenchState,
  WorkbenchUpdateResult,
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
}

export const Config: z<Config> = z.object({
  gitRemote: z.string().default(''),
  customSkillDirs: z.array(z.string()).default([]),
  installedSkills: z.array(z.string()).default([]),
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
 * Run the self-update pipeline. Never throws: every failure returns an
 * actionable { ok: false, error } result.
 */
async function runUpdate(ctx: Context): Promise<WorkbenchUpdateResult> {
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
    return {
      ok: true,
      changed,
      rebuilt,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      output: truncate(output),
      needRestart: changed,
    }
  } catch (error) {
    return { ok: false, error: truncate(String(error instanceof Error ? error.message : error)) }
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
async function buildSkillList(ctx: Context, installed: readonly string[]): Promise<WorkbenchSkillList> {
  try {
    const snap = await ctx.skills.snapshot({})
    const installedSet = new Set(installed)
    const skills: WorkbenchSkillSummary[] = snap.skills.map(s => ({
      name: s.name,
      description: s.description,
      ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
      source: s.source,
      provider: s.provider,
      // Removable only when this workbench wrote it OR it landed under our
      // user-dsh root (safe to delete without touching project/agent roots).
      removable: installedSet.has(s.name) || findManagedSkillPath(s.name) !== undefined,
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
 *   - `sourceRoot` is verified to stay inside the staging tree so a
 *     malicious sub-path can't escape via `../..`.
 *   - Staging clone is removed on both success and failure.
 *
 * @returns [installed path, captured git output]
 */
async function importSkillFromGit(
  request: WorkbenchSkillImportRequest,
): Promise<{
  installed: string[]
  skipped?: Array<{ name: string; reason: string }>
  writtenTo?: string
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

    // Resolve where the SKILL lives inside the freshly cloned tree.
    const rawSource = subPath === '' ? staging : join(staging, subPath)
    // Path-traversal guard: node's join collapses `..`, so we verify the
    // resolved absolute path is still under staging before touching anything.
    const source = statSync(rawSource, { throwIfNoEntry: false }) !== undefined ? rawSource : rawSource
    if (!source.startsWith(staging)) {
      throw new Error(`子路径解析出的目录越权：${source}`)
    }
    if (!existsSync(source)) {
      throw new Error(`仓库里未找到子路径：${subPath === '' ? '<repo 根目录>' : subPath}`)
    }

    mkdirSync(USER_DSH_SKILLS_DIR, { recursive: true })
    const stat = statSync(source)

    const resolved = resolveSkillSource(source, stat)
    if (resolved.kind === 'bundle') {
      // Bundle form — one skill. `source` may have been walked one level up
      // when the user pointed subPath at a `SKILL.md` file directly.
      const dest = join(USER_DSH_SKILLS_DIR, targetName)
      installBundleDir(resolved.dir, dest, staging)
      return { installed: [targetName], writtenTo: join(dest, 'SKILL.md'), output: gitOutput }
    }
    if (resolved.kind === 'flat') {
      // Flat form — one Markdown file becomes `<name>.md` under the root.
      const dest = join(USER_DSH_SKILLS_DIR, `${targetName}.md`)
      if (existsSync(dest)) rmSync(dest, { force: true })
      cpSync(resolved.file, dest)
      return { installed: [targetName], writtenTo: dest, output: gitOutput }
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
            result => { sendJson(res, result.ok ? 200 : 500, result) },
            (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
          ).finally(() => { updating = false })
          return
        }

        // GET /skills — invocation-neutral catalog + which entries this
        // workbench can remove.
        if (sub === '/skills' && (method === undefined || method === 'GET' || method === 'HEAD')) {
          void buildSkillList(ctx, source().installedSkills).then(
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
                // Our own SkillProvider caches nothing, but the registry
                // caches list() results — invalidate so the next snapshot
                // rescans disk right away (deterministic, doesn't wait on
                // chokidar).
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
                // Track ownership across restarts. Batch install may return
                // multiple names — union them all into installedSkills.
                const current = source()
                const merged = Array.from(new Set([...current.installedSkills, ...outcome.installed]))
                if (merged.length !== current.installedSkills.length) {
                  try {
                    const settings = (ctx as unknown as { get?: (name: string) => unknown }).get?.('settings') ?? ctx.settings
                    if (settings !== undefined) {
                      await (settings as typeof ctx.settings).update(WORKBENCH_NAMESPACE, { installedSkills: merged })
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

  // readdirSync is used by future skill provider work; suppress unused-import
  // lint until then. Kept imported for the follow-up register-provider seam.
  void readdirSync
}
