/**
 * whaletv-workbench Host half (Node): the workbench state, config save, and
 * one-click update routes over ctx.webServer.
 *
 * Config routes:
 *   GET  /whaletv/workbench/state   → version / git facts / entry config
 *   POST /whaletv/workbench/config  → validate + persist config/workbench.json
 *   POST /whaletv/workbench/update  → git pull --ff-only → (changed) pnpm
 *     install → pnpm run bundle → ctx.clientModules.rebuilt('whaletv-workbench')
 *     re-hashes lib/client.js so the browser boot graph picks up the new rev
 *     (dev HMR broadcasts it via SSE; a production browser shows a refresh
 *     hint instead).
 *
 * The browser half calls these routes with same-origin fetch. The Host half
 * itself stays intentionally thin and stable so client updates rarely force
 * a dsh restart; when the pulled commit touches Host code, `needRestart`
 * tells the user to restart dsh.
 *
 * @module whaletv-workbench
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.clientModules (WebBootGraph client registry) context merge.
import type {} from '@deepseek-ai/dsh-client-modules'
// Type-only: ctx.webServer (named HTTP route registry) context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  WorkbenchConfig, WorkbenchGroup, WorkbenchItem, WorkbenchState, WorkbenchUpdateResult,
} from './shared.ts'

export const name = 'whaletv-workbench'

/** Host services the routes read. */
export const inject = ['webServer', 'clientModules']

/** Plugin id — matches the package name and the client bundle graph row. */
const CLIENT_ID = 'whaletv-workbench'

/** This package's root directory (lib/index.js → lib → package root). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const STATE_ROUTE = '/whaletv/workbench/state'
const CONFIG_ROUTE = '/whaletv/workbench/config'
const UPDATE_ROUTE = '/whaletv/workbench/update'

/** Output captured per update step, truncated so JSON responses stay small. */
const MAX_STEP_OUTPUT = 32_000

/** Upper bounds for a persisted config payload (read body / entries). */
const MAX_CONFIG_BYTES = 512 * 1024
const MAX_GROUPS = 50
const MAX_ITEMS_PER_GROUP = 200

const execFileAsync = promisify(execFile)

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

/** Run one command inside the package directory; returns merged trimmed output. */
async function run(command: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: PACKAGE_DIR,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
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
 * Read the entry config: the user's config/workbench.json when present,
 * falling back to the shipped config/workbench.example.json template, then
 * to an empty registry. A broken file renders as a single error group.
 */
function readConfig(): WorkbenchConfig {
  const userPath = join(PACKAGE_DIR, 'config', 'workbench.json')
  const examplePath = join(PACKAGE_DIR, 'config', 'workbench.example.json')
  const path = existsSync(userPath) ? userPath : examplePath
  if (!existsSync(path)) return { groups: [] }
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
 * Collect a request body with a size cap. Resolves the raw text; rejects
 * with a readable message on oversize / stream errors / malformed JSON.
 * @param req - the incoming request.
 * @returns the parsed JSON payload.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
      if (size > MAX_CONFIG_BYTES) {
        fail(`配置内容过大（超过 ${MAX_CONFIG_BYTES / 1024}KB）`)
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
 * Validate and normalize a raw config payload. Throws with a readable
 * message on any violation; otherwise returns a config holding only the
 * known fields (id/title/description/url/path/prompt), all trimmed, with
 * blank optional fields dropped and ids checked for uniqueness.
 * @param raw - the parsed request body.
 * @returns the sanitized config.
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

/**
 * Persist the config atomically (tmp file + rename) so a crash mid-write
 * never leaves config/workbench.json truncated.
 * @param config - the sanitized config to persist.
 */
function writeConfig(config: WorkbenchConfig): void {
  const path = join(PACKAGE_DIR, 'config', 'workbench.json')
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, path)
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
 * Update state shared across requests: one update at a time, and the last
 * outcome kept for state reads after the fact.
 */
let updating = false

/**
 * Run the self-update pipeline (see module doc). Never throws: every failure
 * returns an actionable { ok: false, error } result.
 * @param ctx - host context (clientModules.rebuilt entry point).
 * @returns the structured result for the browser.
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
      // Re-mirror the installation fallback after install: pnpm may prune the
      // hand-made @deepseek-ai junctions during a lockfile reconciliation.
      installOutput += `\n${await run(process.execPath, ['scripts/link-harness-deps.mjs'])}`
      bundleOutput = await run('pnpm', ['run', 'bundle'])
      // Only entry point through which bundle content reaches the boot graph:
      // re-hash lib/client.js and let HMR/refresh pick up the new rev.
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
      // Host-half code may have changed too; only the client bundle reloads
      // without a process restart.
      needRestart: changed,
    }
  } catch (error) {
    return { ok: false, error: truncate(String(error instanceof Error ? error.message : error)) }
  }
}

/**
 * Register the workbench routes. All routes are exact and same-origin only
 * (the web composition binds 127.0.0.1 by default, like the rest of the GUI).
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        void buildState().then(
          state => { sendJson(res, 200, state) },
          (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
        )
      },
    })
    const disposeConfig = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '仅支持 POST 请求' })
          return
        }
        void readJsonBody(req).then(
          (raw) => {
            try {
              writeConfig(sanitizeConfig(raw))
              sendJson(res, 200, { ok: true })
            } catch (error) {
              // sanitizeConfig/writeConfig failures must not escape the
              // promise chain (an unhandled rejection would crash the host).
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
          (error: unknown) => {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          },
        )
      },
    })
    const disposeUpdate = ctx.webServer.register({
      kind: 'exact',
      path: UPDATE_ROUTE,
      handler: (_req: IncomingMessage, res: ServerResponse) => {
        if (updating) {
          sendJson(res, 409, { ok: false, error: '已有更新正在进行中，请稍候。' })
          return
        }
        updating = true
        void runUpdate(ctx).then(
          result => { sendJson(res, result.ok ? 200 : 500, result) },
          (error: unknown) => { sendJson(res, 500, { ok: false, error: String(error) }) },
        ).finally(() => { updating = false })
      },
    })
    return () => {
      disposeState()
      disposeConfig()
      disposeUpdate()
    }
  }, 'whaletv-workbench: http routes')
}
