/**
 * Self-update domain (roadmap P1): git-checkout pipeline, tarball channel
 * via the dsh plugin-manager, version probe fallback chain, history,
 * skip-marker state and rollback. Split out of index.ts in v0.8.0.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  WorkbenchUpdateCheckResult, WorkbenchUpdateHistoryEntry, WorkbenchUpdateResult,
  WorkbenchUpdateRollbackResult,
} from './shared.ts'
import {
  CLIENT_ID, PACKAGE_DIR, WORKBENCH_STATE_DIR, run, git, truncate, readVersion,
} from './host-plumbing.ts'

/** Rolling self-update history (roadmap P1-9): the last N update attempts. */
const UPDATE_HISTORY_PATH = join(WORKBENCH_STATE_DIR, 'updates.json')

const MAX_HISTORY_ENTRIES = 20
/** How many incoming commits the update checker lists. */

/** How many incoming commits the update checker lists. */
const MAX_CHECK_COMMITS = 20
/** SHA accepted by the skip route: short (≥7) or full hex. */

/**
 * Small update-checker state (roadmap P1-10): the skipped upstream head.
 * Host-owned JSON for the same reason as installed-skills.json — the 0.1.7
 * settings document is schema-projected from Config and is no place for
 * runtime bookkeeping.
 */
const UPDATE_STATE_PATH = join(WORKBENCH_STATE_DIR, 'update-state.json')
/** Per-probe timeout for the reachability checker (roadmap P2-16). */

/**
 * Run the self-update pipeline and record the attempt into the rolling
 * history (roadmap P1-9). Never throws: every failure returns an
 * actionable { ok: false, error } result. History writes are best-effort —
 * a broken updates.json must never turn a good update into a panel error.
 */
async function runUpdate(ctx: Context, updateRepo: string): Promise<WorkbenchUpdateResult> {
  const startedAt = new Date()
  const result = await runUpdatePipeline(ctx, updateRepo)
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

/**
 * The update pipeline proper (no history side effects): git checkouts run
 * pull → install → bundle → hot-inject; tarball installs (no .git) hand the
 * update to the dsh plugin-manager (roadmap v0.7.4).
 */

/**
 * The update pipeline proper (no history side effects): git checkouts run
 * pull → install → bundle → hot-inject; tarball installs (no .git) hand the
 * update to the dsh plugin-manager (roadmap v0.7.4).
 */
async function runUpdatePipeline(ctx: Context, updateRepo: string): Promise<WorkbenchUpdateResult> {
  const before = await git(['rev-parse', 'HEAD'])
  if (before === undefined) {
    return runTarballUpdate(ctx, updateRepo)
  }
  const remote = await git(['remote', 'get-url', 'origin'])
  if (remote === undefined || remote.trim() === '') {
    return { ok: false, error: '未配置 git 远程仓库（origin）。请先执行 git remote add origin <仓库地址> 再重试。' }
  }
  // lib/ is committed (0.7.2+) but regenerable: a local `pnpm run bundle`
  // leaves it dirty and a dirty tree blocks the ff-only pull. Discard
  // lib-only drift before pulling — source files are never touched here, so
  // a pull that fails for real source conflicts still fails loudly.
  const libDrift = await git(['status', '--porcelain', '--', 'lib'])
  if (libDrift !== undefined && libDrift.trim() !== '') {
    await git(['checkout', '--', 'lib'])
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
 * The dsh plugin-manager service (dsh-base composes it on every 0.1.7 host),
 * read structurally — this file deliberately carries no dsh-plugin-manager
 * type dependency (its surface is still stabilizing).
 */

/**
 * The dsh plugin-manager service (dsh-base composes it on every 0.1.7 host),
 * read structurally — this file deliberately carries no dsh-plugin-manager
 * type dependency (its surface is still stabilizing).
 */
interface TarballPluginManager {
  installBundle?: (spec: string, options?: { approvedBuilds?: string[] }) => Promise<{
    changed: boolean
    application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
    warnings?: string[]
    packageResult?: { output?: string; kind?: string }
    error?: { code?: string; diagnostic?: string }
    failedAt?: string
    target?: string
    stage?: string
  }>
}

/** Read `ctx.pluginManager` through the structural face; undefined when absent. */

/** Read `ctx.pluginManager` through the structural face; undefined when absent. */
function pluginManagerLike(ctx: Context): TarballPluginManager | undefined {
  try {
    return (ctx as { pluginManager?: TarballPluginManager }).pluginManager
  } catch {
    return undefined
  }
}

/**
 * Volatile Config fields (dsh ≥ 0.1.7 live-editable settings) resolve to
 * accessor objects with a `.get()` method rather than plain values — unwrap
 * before use. THE `updateRepo` BUG (v0.7.4–0.7.6): the raw accessor object
 * was interpolated into the probe URLs, so every source was asked for
 * `https://.../[object Object]/...` and answered 404/400/403.
 */

/**
 * Fetch the update repo's default-branch package.json version (tarball update
 * channel). Three sources are tried in order — mainland-China networks
 * routinely block raw.githubusercontent.com while reaching api.github.com
 * or the jsDelivr CDN, so the chain degrades instead of failing the check.
 * Every attempt is recorded so a total failure can explain itself.
 *
 * Ref discipline: this repo's default branch is `main` (the dsh harness
 * repo's is `master` — the first probe hardcoded /master/ and 404'd on all
 * three sources). raw uses /HEAD/, the GitHub API omits ref, and jsDelivr
 * pins @main explicitly because a version-less jsDelivr spec resolves the
 * latest git TAG instead of the branch.
 */
async function fetchLatestTarballVersion(repo: string): Promise<{ version?: string; attempts: string[] }> {
  const attempts: string[] = []
  const sources: Array<{ name: string; url: string; parse: (body: string) => string | undefined }> = [
    {
      // Raw CDN first: HEAD = default branch, live commit HEAD, no cache lag.
      name: 'raw',
      url: `https://raw.githubusercontent.com/${repo}/HEAD/package.json`,
      parse: body => parseVersionField(body),
    },
    {
      // jsDelivr CDN: plain JSON, CN-friendly edge cache (may lag main by up to 12h).
      name: 'jsdelivr',
      url: `https://cdn.jsdelivr.net/gh/${repo}@main/package.json`,
      parse: body => parseVersionField(body),
    },
    {
      // GitHub API: contents endpoint returns the file base64-encoded.
      name: 'api',
      url: `https://api.github.com/repos/${repo}/contents/package.json`,
      parse: body => {
        try {
          const envelope = JSON.parse(body) as { content?: string; encoding?: string }
          if (envelope.encoding !== 'base64' || typeof envelope.content !== 'string') return undefined
          return parseVersionField(Buffer.from(envelope.content, 'base64').toString('utf8'))
        } catch {
          return undefined
        }
      },
    },
  ]
  for (const source of sources) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(source.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'whaletv-workbench-update-check', Accept: 'application/vnd.github+json' },
      })
      if (!response.ok) {
        attempts.push(`${source.url} -> HTTP ${response.status}`)
        continue
      }
      const version = source.parse(await response.text())
      if (version !== undefined) return { version, attempts }
      attempts.push(`${source.url} -> 响应不含版本号`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      attempts.push(`${source.url} -> ${message === 'This operation was aborted' ? '超时(8s)' : message}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { attempts }
}

/** Pull the semver `version` field out of a package.json document. */

/** Pull the semver `version` field out of a package.json document. */
function parseVersionField(packageJson: string): string | undefined {
  try {
    const version = (JSON.parse(packageJson) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

/** Whether `latest` is strictly newer than `installed` (x.y.z[, -prerelease] aware). */

/** Whether `latest` is strictly newer than `installed` (x.y.z[, -prerelease] aware). */
function isSemverGt(latest: string, installed: string): boolean {
  const parse = (value: string): [number, number, number, string] => {
    const [core, pre = ''] = value.split('-')
    const [major = 0, minor = 0, patch = 0] = core.split('.').map(part => Number.parseInt(part, 10) || 0)
    return [major, minor, patch, pre]
  }
  const [lm, ln, lp, lpre] = parse(latest)
  const [im, inn, ip, ipre] = parse(installed)
  if (lm !== im) return lm > im
  if (ln !== inn) return ln > inn
  if (lp !== ip) return lp > ip
  // A release outranks its own prerelease prefixes; different prefixes compare lexically.
  if (lpre !== ipre) return lpre !== '' && (ipre === '' || lpre > ipre)
  return false
}

/**
 * Tarball update (v0.7.4 → redesigned in v0.8.0): run `pnpm add github:<repo>`
 * directly in the profile directory. This bypasses the dsh plugin-manager's
 * `installBundle` — which mis-reports a same-version re-add as
 * `ambiguous-install` — and just does what we need: re-resolve the latest
 * commit, update the lockfile, and hot-inject the client bundle.
 */
async function runTarballUpdate(ctx: Context, repo: string): Promise<WorkbenchUpdateResult> {
  // Derive the profile directory from our own package path:
  // PACKAGE_DIR = <profile>/node_modules/whaletv-workbench
  const profileDir = join(PACKAGE_DIR, '..', '..')
  const spec = `github:${repo}`
  try {
    const output = await run('pnpm', ['add', spec], profileDir)
    ctx.clientModules.rebuilt(CLIENT_ID)
    return {
      ok: true, tarball: true, needRestart: true, changed: true,
      output: truncate(`$ pnpm add ${spec} (cwd: ${profileDir})\n${output}\n\n已通过 pnpm 安装新版本；重启 dsh 后生效。`),
    }
  } catch (error) {
    return { ok: false, tarball: true, error: truncate(`pnpm add ${spec} 失败：${String(error instanceof Error ? error.message : error)}`) }
  }
}

/**
 * Update checker (roadmap P1-8): fetch the origin remote and compare HEAD
 * against its upstream — ahead/behind counts plus the newest incoming commit
 * subjects — without touching the working tree. `skippedHead` is the user's
 * skip marker; when the remote head equals it the result is flagged so the
 * panel can show "skipped" instead of nagging. Never throws.
 */

/**
 * Update checker (roadmap P1-8): fetch the origin remote and compare HEAD
 * against its upstream — ahead/behind counts plus the newest incoming commit
 * subjects — without touching the working tree. `skippedHead` is the user's
 * skip marker; when the remote head equals it the result is flagged so the
 * panel can show "skipped" instead of nagging. Never throws.
 */
async function runUpdateCheck(skippedHead: string, updateRepo: string): Promise<WorkbenchUpdateCheckResult> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === undefined) {
    // Tarball install (dsh desktop app / `plugin add github:`): no .git, so
    // git-based checking can never work here. Compare versions instead — the
    // installed package.json against the update repo's master package.json.
    const installedVersion = readVersion()
    const probe = await fetchLatestTarballVersion(updateRepo)
    if (probe.version === undefined) {
      // Self-identifying diagnostics: which build answered, from which
      // directory, probing exactly which URLs. A stale host module (loaded
      // before a fix landed on disk) betrays itself here immediately.
      return {
        ok: false, upToDate: false, tarball: true, installedVersion,
        error: `无法获取最新版本信息。构建=${readVersion()}；目录=${PACKAGE_DIR}；探测：${probe.attempts.join(' ｜ ')}`,
      }
    }
    return {
      ok: true, upToDate: !isSemverGt(probe.version, installedVersion), tarball: true,
      installedVersion, latestVersion: probe.version,
    }
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

/** Read the skipped-head marker (roadmap P1-10); missing file is empty. */

/** Read the skipped-head marker (roadmap P1-10); missing file is empty. */
function readSkippedHead(): string {
  try {
    const parsed = JSON.parse(readFileSync(UPDATE_STATE_PATH, 'utf8')) as unknown
    const marker = (parsed as { skippedHead?: unknown } | null)?.skippedHead
    return typeof marker === 'string' ? marker : ''
  } catch {
    return ''
  }
}

/** Persist the skipped-head marker atomically; best-effort. */

/** Persist the skipped-head marker atomically; best-effort. */
function writeSkippedHead(sha: string): void {
  try {
    mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
    const tmp = `${UPDATE_STATE_PATH}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ skippedHead: sha }, null, 2)}\n`, 'utf8')
    renameSync(tmp, UPDATE_STATE_PATH)
  } catch {
    // Losing the skip marker only re-arms a reminder — never fail the flow.
  }
}

/**
 * Clear the skip marker after a successful update moved to a new head — the
 * reminder re-arms for whatever comes next. Best-effort; never throws.
 */

/**
 * Clear the skip marker after a successful update moved to a new head — the
 * reminder re-arms for whatever comes next. Best-effort; never throws.
 */
function clearSkippedHead(): void {
  writeSkippedHead('')
}

export {
  runUpdate, runUpdateCheck, runUpdateRollback, clearSkippedHead, readSkippedHead,
  readUpdateHistory, writeSkippedHead, fetchLatestTarballVersion, parseVersionField, isSemverGt,
}
