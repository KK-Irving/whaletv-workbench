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
// Type-only: ctx.skills and ctx.agents context merges.
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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

/** Settings namespace: the join key between the Host register and the browser card. */
const WORKBENCH_NAMESPACE = settingsNamespace('whaletv-workbench')

/** Host services this plugin uses through ctx. */
export const inject = ['webServer', 'clientModules', 'skills', 'agents']

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
 */
const NOISY_NPM_ENV_VARS: readonly string[] = [
  'NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS',
  'npm_config_manage_package_manager_versions',
]
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of NOISY_NPM_ENV_VARS) delete env[key]
  return env
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
): Promise<{ writtenTo: string; output: string }> {
  const targetName = request.name?.trim() ?? ''
  const url = request.url?.trim() ?? ''
  const subPath = request.subPath?.trim() ?? ''
  const ref = request.ref?.trim() ?? ''

  if (!SKILL_NAME_PATTERN.test(targetName)) {
    throw new Error(`目标名称必须为 kebab-case（^[a-z0-9]+(?:-[a-z0-9]+)*$），收到：${targetName || '<空>'}`)
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
    const gitOutput = await run('git', args, IMPORT_STAGING_DIR)

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

    const stat = statSync(source)
    mkdirSync(USER_DSH_SKILLS_DIR, { recursive: true })

    let writtenTo: string
    if (stat.isDirectory() && existsSync(join(source, 'SKILL.md'))) {
      // Bundle form — copy whole directory (SKILL.md + assets/scripts/refs).
      const dest = join(USER_DSH_SKILLS_DIR, targetName)
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      cpSync(source, dest, { recursive: true, filter: (src) => !src.includes(`${staging}/.git`) })
      // Belt-and-suspenders: if cpSync's filter didn't catch .git (Windows
      // vs POSIX slash), remove it after the fact.
      const gitDir = join(dest, '.git')
      if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true })
      writtenTo = join(dest, 'SKILL.md')
    } else if (stat.isFile() && source.toLowerCase().endsWith('.md')) {
      // Flat form — one Markdown file becomes `<name>.md` under the root.
      const dest = join(USER_DSH_SKILLS_DIR, `${targetName}.md`)
      if (existsSync(dest)) rmSync(dest, { force: true })
      cpSync(source, dest)
      writtenTo = dest
    } else {
      throw new Error(`在 ${subPath === '' ? '<repo 根目录>' : subPath} 未找到 SKILL.md 或 <name>.md`)
    }
    return { writtenTo, output: gitOutput }
  } finally {
    // Clean up the staging clone on both success and failure.
    rmSync(staging, { recursive: true, force: true })
  }
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
  // Live source thunk: `installSettingsSection` swaps this to read from the
  // settings scope once one is attached. Everything Host-side that needs the
  // current value goes through `source()`, so live edits flow immediately.
  let source: () => Config = () => config

  installSettingsSection(ctx, WORKBENCH_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => { /* live-applied fields; nothing derived to invalidate today. */ },
  })

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
                // Reflect ownership in the settings namespace so a later
                // `/skills` read marks this skill as removable across restarts.
                const current = source()
                if (!current.installedSkills.includes(skillName)) {
                  await ctx.settings.update(WORKBENCH_NAMESPACE, {
                    installedSkills: [...current.installedSkills, skillName],
                  })
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
        // named skill body into $DSH_HOME/skills/<name>/.
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
                const current = source()
                if (!current.installedSkills.includes(request.name)) {
                  await ctx.settings.update(WORKBENCH_NAMESPACE, {
                    installedSkills: [...current.installedSkills, request.name],
                  })
                }
                const result: WorkbenchSkillImportResult = {
                  ok: true,
                  writtenTo: outcome.writtenTo,
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
                const current = source()
                if (current.installedSkills.includes(skillName)) {
                  await ctx.settings.update(WORKBENCH_NAMESPACE, {
                    installedSkills: current.installedSkills.filter(n => n !== skillName),
                  })
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
