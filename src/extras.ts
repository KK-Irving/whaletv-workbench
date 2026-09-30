/**
 * Panel-data extras (roadmap P2): launch-usage ledger, entry reachability
 * probes and the per-origin favicon proxy. Split out of index.ts in v0.8.0.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { WorkbenchConfig, WorkbenchItem } from './shared.ts'
import { WORKBENCH_STATE_DIR } from './host-plumbing.ts'

/**
 * Launch-usage ledger (roadmap P2-12): `{ [itemId]: { count, lastUsed } }`,
 * feeding the panel's 最近使用 rail. Capped by lastUsed recency.
 */
const USAGE_PATH = join(WORKBENCH_STATE_DIR, 'usage.json')

const MAX_USAGE_ENTRIES = 500

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

/** Probe every entry in the config (roadmap P2-16), keyed by item id.
 *
 * Probes run with bounded concurrency: the original loop awaited each entry
 * in turn, so a config with many slow/offline URLs stretched GET /health
 * into minutes (5s timeout × N entries). */
const HEALTH_CONCURRENCY = 8

async function runHealthCheck(config: WorkbenchConfig): Promise<Record<string, { ok: boolean; detail?: string }>> {
  const items = config.groups.flatMap(group => group.items)
  const results: Record<string, { ok: boolean; detail?: string }> = {}
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      results[item.id] = await checkEntryHealth(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(HEALTH_CONCURRENCY, items.length) }, worker))
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

/** Hash prefix shared by an origin's cache file and its negative marker. */
function faviconHash(origin: string): string {
  return createHash('sha1').update(origin).digest('hex').slice(0, 16)
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
 * Locate an origin's cached artifact by hash prefix. Saves write
 * `<hash>.<content-type ext>` — png/svg/whatever — so lookup must scan the
 * directory instead of probing one hardcoded extension. The original
 * `faviconFile` looked for `<hash>.ico` while non-ico saves landed at
 * `<hash>.png`, so every request missed and re-fetched.
 */
function findFaviconArtifact(origin: string, miss: boolean): string | undefined {
  const hash = faviconHash(origin)
  let entries: string[]
  try {
    if (!existsSync(ICON_DIR)) return undefined
    entries = readdirSync(ICON_DIR)
  } catch {
    return undefined
  }
  const match = entries.find(name => {
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || name.slice(0, dot) !== hash) return false
    const ext = name.slice(dot)
    return miss ? ext === '.miss' : ext !== '.miss' && ext in FAVICON_MIME_BY_EXT
  })
  return match === undefined ? undefined : join(ICON_DIR, match)
}

/** How long a "no favicon here" marker stands before the next attempt. */
const FAVICON_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000

function missMarkerIsFresh(marker: string): boolean {
  try {
    return Date.now() - statSync(marker).mtimeMs < FAVICON_MISS_TTL_MS
  } catch {
    return false
  }
}

/** Record (or refresh) the origin's negative marker; best-effort. */
function writeMissMarker(origin: string): void {
  try {
    writeFileSync(join(ICON_DIR, `${faviconHash(origin)}.miss`), '')
  } catch { /* a lost marker only costs one re-fetch */ }
}

/**
 * Serve a cached favicon for the given origin (roadmap P2-17), downloading
 * `<origin>/favicon.ico` on first use. Successful responses cache-forever
 * per origin (content-addressed by origin hash); failures write a
 * `.miss` negative marker (TTL below) so a dead icon costs one fetch per
 * TTL window instead of one per panel render — the panel hides the img on
 * error.
 */
async function serveFavicon(url: string): Promise<{ status: number; contentType: string; body: Buffer; cache: string }> {
  const originError = faviconOriginError(url)
  if (originError !== undefined) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(originError), cache: 'no-store' }
  }
  mkdirSync(ICON_DIR, { recursive: true })
  const cached = findFaviconArtifact(url, false)
  if (cached !== undefined) {
    const ext = cached.slice(cached.lastIndexOf('.'))
    return {
      status: 200,
      contentType: FAVICON_MIME_BY_EXT[ext] ?? 'application/octet-stream',
      body: readFileSync(cached),
      cache: 'public, max-age=604800',
    }
  }
  const missMarker = findFaviconArtifact(url, true)
  if (missMarker !== undefined && missMarkerIsFresh(missMarker)) {
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('favicon 不可用'), cache: 'no-store' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  const fail = (detail: string): { status: 404; contentType: string; body: Buffer; cache: string } => {
    writeMissMarker(url)
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from(detail), cache: 'no-store' }
  }
  try {
    const response = await fetch(new URL('/favicon.ico', url), { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) return fail('favicon 不可用')
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
    const ext = Object.entries(FAVICON_MIME_BY_EXT).find(([, mime]) => mime === contentType)?.[0] ?? '.ico'
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0 || buffer.length > ICON_MAX_BYTES) return fail('favicon 尺寸异常')
    // A stale artifact under a different extension (origin switched icon
    // type) or an expired miss marker must not survive a fresh save.
    const target = join(ICON_DIR, `${faviconHash(url)}${ext}`)
    for (const name of readdirSync(ICON_DIR)) {
      const artifact = join(ICON_DIR, name)
      if (artifact !== target) {
        const dot = name.lastIndexOf('.')
        if (dot > 0 && name.slice(0, dot) === faviconHash(url)) rmSync(artifact, { force: true })
      }
    }
    writeFileSync(target, buffer)
    return { status: 200, contentType: contentType !== '' ? contentType : 'image/x-icon', body: buffer, cache: 'public, max-age=604800' }
  } catch (error) {
    return fail(`favicon 抓取失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

export { readUsage, recordUsage, runHealthCheck, serveFavicon }
