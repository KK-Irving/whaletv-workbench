/**
 * Skill domain (roadmap P3): the workbench-owned SkillProvider, git import
 * (bundle/flat/batch), disk install/remove, versioning records and the
 * catalog projection. Split out of index.ts in v0.8.0.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type {
  WorkbenchInstalledSkill, WorkbenchSkillImportRequest,
  WorkbenchSkillList, WorkbenchSkillSummary,
} from './shared.ts'
import { DSH_HOME, WORKBENCH_STATE_DIR, run } from './host-plumbing.ts'

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

/** dsh-skill-filesystem user-dsh root (rank 400). Written by the install route. */
export const USER_DSH_SKILLS_DIR = join(DSH_HOME, 'skills')

/** Staging root for shallow git clones during skill import; entries are removed after copy. */
const IMPORT_STAGING_DIR = join(WORKBENCH_STATE_DIR, '.staging')

/**
 * Skill versioning records (roadmap P3-20): one line per workbench-installed
 * skill with its Git origin / SHA / sub-path, enabling the per-skill
 * "检查更新" (P3-21). Plain Host-owned JSON — not a settings field — so the
 * settings schema stays flat and old user layers never need migrating.
 */
const INSTALLED_RECORDS_PATH = join(WORKBENCH_STATE_DIR, 'installed-skills.json')
/**
 * Small update-checker state (roadmap P1-10): the skipped upstream head.
 * Host-owned JSON for the same reason as installed-skills.json — the 0.1.7
 * settings document is schema-projected from Config and is no place for
 * runtime bookkeeping.
 */

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
  ctx: Context, records: readonly WorkbenchInstalledSkill[],
): Promise<WorkbenchSkillList> {
  try {
    const snap = await ctx.skills.snapshot({})
    const recordByName = new Map(records.map(record => [record.name, record]))
    const skills: WorkbenchSkillSummary[] = snap.skills.map(s => ({
      name: s.name,
      description: s.description,
      ...(s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {}),
      source: s.source,
      provider: s.provider,
      // Removable when this workbench owns a versioning record for it OR it
      // landed under our user-dsh root (safe to delete without touching
      // project/agent roots).
      removable: recordByName.has(s.name) || findManagedSkillPath(s.name) !== undefined,
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
export function installBundleDir(srcDir: string, dest: string, staging: string): void {
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
  // Prefer bundle removal when both shapes exist. Same retry posture as the
  // staging sweep: git.exe / antivirus can hold handles on freshly-written
  // files, and a bare rmSync loses that race on Windows.
  if (existsSync(bundleDir) && statSync(bundleDir).isDirectory()) {
    rmSync(bundleDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
    return
  }
  if (existsSync(flat)) {
    rmSync(flat, { force: true, maxRetries: 8, retryDelay: 250 })
    return
  }
  throw new Error(`未找到 skill：${name}（工作台只能删除自己写入 $DSH_HOME/skills 的 skill）`)
}

export {
  sweepStagingDir, registerWorkbenchSkillProvider, buildSkillList, buildSkillDebug,
  readInstalledRecords, upsertInstalledRecords, pruneInstalledRecords,
  installSkillOnDisk, importSkillFromGit, removeSkillOnDisk,
  parseFrontmatter,
}
