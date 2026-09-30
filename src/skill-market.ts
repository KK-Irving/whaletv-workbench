/**
 * Skill market (roadmap ③ / P3-22, v0.8.17): aggregate search across the two
 * public skill registries and one-click install into `$DSH_HOME/skills`.
 *
 * Data sources (probed 2026-09-30, shapes verified live):
 * - SkillHub (`api.skillhub.tencent.com`, Tencent CN mirror, ~176k skills):
 *   search  GET /api/skills?keyword&page&pageSize&sortBy=downloads&order=desc
 *   detail  POST /api/v1/skills/batch {slugs:[…]}   (NO readme in the payload)
 *   body    GET  /api/v1/skills/{slug}/file?path=SKILL.md
 *   zip     GET  /api/v1/download?slug={slug}
 * - ClawHub (`clawhub.ai`, ex clawhub.com):
 *   search  GET  /api/v1/search?q={keyword}&limit
 *   detail  GET  /api/v1/skills/{slug}?ownerHandle={owner}   (readme may be
 *          nested under `skill`)
 *   zip     GET  /api/v1/download?slug={slug}&ownerHandle={owner}
 *
 * Install downloads a ZIP and unpacks it with a strict in-house extractor
 * (`extractZipSafe`): central-directory driven, store+deflate, hard caps on
 * entry count / uncompressed size, and a zip-slip guard on every path. The
 * package must contain a SKILL.md at its root or one nested directory down.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { DSH_HOME, WORKBENCH_STATE_DIR } from './host-plumbing.ts'
import { installBundleDir, parseFrontmatter } from './skills.ts'

export const SKILLHUB_API = 'https://api.skillhub.tencent.com'
export const CLAWHUB_API = 'https://clawhub.ai'

const SEARCH_TIMEOUT_MS = 12_000
const DOWNLOAD_TIMEOUT_MS = 60_000
/** A skill package above this size is refused before download. */
const MAX_ZIP_BYTES = 20 * 1024 * 1024
/** Zip-bomb caps for extraction. */
const MAX_ENTRIES = 800
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024
const MAX_FILE_UNCOMPRESSED = 8 * 1024 * 1024

/** The dsh-visible skills root this module installs into. */
export const MARKET_SKILLS_DIR = join(DSH_HOME, 'skills')

/** One aggregated market entry, normalized across both sources. */
export interface MarketItem {
  source: 'skillhub' | 'clawhub'
  slug: string
  name: string
  displayName: string
  summary: string
  summaryZh: string
  author: string
  downloads: number
  installs: number
  stars: number
  iconUrl: string
  verified: boolean
  version: string
  /** ClawHub's `owner/slug` install reference; empty for SkillHub. */
  installRef: string
  ownerHandle: string
  installed?: boolean
}

/** HTTP GET returning parsed JSON with timeout and error containment. */
async function getJson(url: string, timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** HTTP POST with a JSON body, returning parsed JSON. */
async function postJson(url: string, body: unknown, timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
  }
}

async function getBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_ZIP_BYTES) throw new Error(`包体 ${Math.round(declared / 1024 / 1024)}MB 超过上限`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_ZIP_BYTES) throw new Error(`包体超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB 上限`)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

interface SkillHubSearchResponse {
  data?: { skills?: Array<Record<string, unknown>>; total?: number }
}

async function searchSkillHub(keyword: string, page: number, pageSize: number): Promise<MarketItem[]> {
  const params = new URLSearchParams({
    page: String(page), pageSize: String(pageSize), sortBy: 'downloads', order: 'desc',
  })
  if (keyword !== '') params.set('keyword', keyword)
  const data = await getJson(`${SKILLHUB_API}/api/skills?${params.toString()}`) as SkillHubSearchResponse
  const skills = data.data?.skills ?? []
  return skills.map(skill => normalizeItem('skillhub', skill, {
    slug: String(skill.slug ?? skill.name ?? ''),
    summaryZh: String(skill.summary_zh ?? skill.description_zh ?? ''),
    author: String(skill.ownerName ?? ''),
    installRef: String(skill.slug ?? skill.name ?? ''),
    ownerHandle: '',
  }))
}

interface ClawHubSearchResponse {
  results?: Array<Record<string, unknown>>
}

async function searchClawHub(keyword: string, limit: number): Promise<MarketItem[]> {
  const params = new URLSearchParams({ q: keyword, limit: String(limit) })
  const data = await getJson(`${CLAWHUB_API}/api/v1/search?${params.toString()}`) as ClawHubSearchResponse
  const results = data.results ?? []
  return results.map(row => {
    const reference = String((row.install as { reference?: string } | undefined)?.reference ?? '')
    const [ownerHandle, slugFromRef] = reference.split('/')
    return normalizeItem('clawhub', row, {
      slug: String(row.slug ?? slugFromRef ?? ''),
      summaryZh: '',
      author: String((row.owner as { displayName?: string } | undefined)?.displayName ?? ownerHandle ?? ''),
      installRef: reference,
      ownerHandle: ownerHandle ?? '',
      stars: Number((row.metrics as { bookmarks?: number } | undefined)?.bookmarks ?? 0),
      installs: Number((row.metrics as { rolling60DayInstalls?: number } | undefined)?.rolling60DayInstalls ?? 0),
    })
  })
}

/** Map one source row onto the normalized MarketItem shape, tolerating drift. */
function normalizeItem(
  source: 'skillhub' | 'clawhub',
  row: Record<string, unknown>,
  overrides: Partial<MarketItem> & { slug: string; installRef: string; ownerHandle: string },
): MarketItem {
  const stats = row.stats as { downloads?: number; installs?: number; stars?: number } | undefined
  const str = (key: string): string => (typeof row[key] === 'string' ? (row[key] as string) : '')
  const num = (key: string): number => (typeof row[key] === 'number' ? (row[key] as number) : 0)
  return {
    source,
    slug: overrides.slug,
    name: str('name') === '' ? overrides.slug : str('name'),
    displayName: str('displayName') === '' ? (str('name') === '' ? overrides.slug : str('name')) : str('displayName'),
    summary: str('summary') === '' ? str('description') : str('summary'),
    summaryZh: overrides.summaryZh ?? '',
    author: overrides.author ?? '',
    downloads: num('downloads') !== 0 ? num('downloads') : (stats?.downloads ?? 0),
    installs: num('installs') !== 0 ? num('installs') : (stats?.installs ?? 0),
    stars: num('stars') !== 0 ? num('stars') : (stats?.stars ?? 0),
    iconUrl: str('iconUrl'),
    verified: row.verified === true || row.isAuthorVerified === true || row.official === true,
    version: str('version'),
    installRef: overrides.installRef,
    ownerHandle: overrides.ownerHandle,
  }
}

/**
 * Merge per-source result lists: dedupe by slug (case-insensitive), installed
 * entries first, then by downloads. Exported for the smoke suite.
 *
 * @param parts - one list per queried source, in query order.
 * @param installedNames - lowercase names already present in $DSH_HOME/skills.
 */
export function mergeMarketResults(
  parts: Array<{ source: string; items: MarketItem[] }>,
  installedNames: readonly string[],
): MarketItem[] {
  const installed = new Set(installedNames.map(name => name.toLowerCase()))
  const seen = new Set<string>()
  const merged: MarketItem[] = []
  for (const part of parts) {
    for (const item of part.items) {
      const key = (item.slug || item.name).toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      merged.push({ ...item, installed: installed.has((item.slug || item.name).toLowerCase()) })
    }
  }
  merged.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1
    return b.downloads - a.downloads
  })
  return merged
}

/**
 * Aggregate search across both sources. A source that fails is contained and
 * reported; the other source still answers (multi-source failover).
 */
export async function searchMarket(keyword: string, opts: {
  source?: string
  page?: number
  pageSize?: number
  installedNames?: readonly string[]
} = {}): Promise<{ ok: true; items: MarketItem[]; sources: string[]; errors: string[] }> {
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(60, Math.max(1, opts.pageSize ?? 40))
  const wanted = opts.source === 'skillhub' || opts.source === 'clawhub'
    ? [opts.source]
    : ['skillhub', 'clawhub']
  const parts: Array<{ source: string; items: MarketItem[] }> = []
  const errors: string[] = []
  await Promise.all(wanted.map(async (source) => {
    try {
      if (source === 'skillhub') parts.push({ source, items: await searchSkillHub(keyword, page, pageSize) })
      else parts.push({ source, items: await searchClawHub(keyword, Math.min(pageSize, 30)) })
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))
  const items = mergeMarketResults(parts, opts.installedNames ?? [])
  return { ok: true, items, sources: parts.map(part => part.source), errors }
}

/** Fetch the skill body (SKILL.md) from SkillHub's file API. */
async function skillHubFile(slug: string, path: string): Promise<string> {
  const url = `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

export interface MarketDetail {
  ok: true
  source: 'skillhub' | 'clawhub'
  slug: string
  name: string
  displayName?: string
  summary: string
  author: string
  downloads: number
  installs: number
  stars: number
  verified: boolean
  version: string
  readme: string
}

/** Detail with source fallback and the best-effort README/body resolution. */
export async function marketDetail(source: string, slug: string, ownerHandle?: string): Promise<MarketDetail> {
  const wanted = source === 'clawhub' ? ['clawhub', 'skillhub'] : ['skillhub', 'clawhub']
  const errors: string[] = []
  let base: Omit<MarketDetail, 'ok' | 'slug' | 'readme'> | undefined
  for (const trySource of wanted) {
    try {
      if (trySource === 'skillhub') {
        const data = await postJson(`${SKILLHUB_API}/api/v1/skills/batch`, { slugs: [slug] }) as { items?: Array<{ skill?: Record<string, unknown>; owner?: Record<string, unknown>; latestVersion?: Record<string, unknown> }> }
        const item = data.items?.[0]
        const skill = (item?.skill ?? {}) as Record<string, unknown>
        base = {
          source: 'skillhub',
          name: String(skill.name ?? slug),
          displayName: String(skill.displayName ?? ''),
          summary: String(skill.summary ?? skill.description ?? ''),
          author: String((item?.owner as { handle?: string } | undefined)?.handle ?? ''),
          downloads: Number(skill.downloads ?? 0),
          installs: Number(skill.installs ?? 0),
          stars: Number(skill.stars ?? 0),
          verified: skill.verified === true,
          version: String((item?.latestVersion as { version?: string } | undefined)?.version ?? ''),
        }
      } else {
        const params = new URLSearchParams()
        if (ownerHandle !== undefined && ownerHandle !== '') params.set('ownerHandle', ownerHandle)
        const data = await getJson(`${CLAWHUB_API}/api/v1/skills/${encodeURIComponent(slug)}?${params.toString()}`) as Record<string, unknown>
        const skill = data.skill as Record<string, unknown> | undefined
        base = {
          source: 'clawhub',
          name: String(data.name ?? skill?.name ?? slug),
          displayName: String(data.displayName ?? ''),
          summary: String(data.summary ?? skill?.summary ?? ''),
          author: String((data.owner as { displayName?: string } | undefined)?.displayName ?? ownerHandle ?? ''),
          downloads: Number(data.downloads ?? 0),
          installs: Number((data.metrics as { rolling60DayInstalls?: number } | undefined)?.rolling60DayInstalls ?? 0),
          stars: Number((data.metrics as { bookmarks?: number } | undefined)?.bookmarks ?? 0),
          verified: data.official === true,
          version: String(data.version ?? (skill?.version as string | undefined) ?? ''),
        }
      }
      break
    } catch (error) {
      errors.push(`${trySource}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (base === undefined) throw new Error(`技能详情获取失败（${errors.join('；')}）`)
  let readme = ''
  try {
    if (base.source === 'skillhub') readme = await skillHubFile(slug, 'SKILL.md')
  } catch {
    // Body preview is best-effort; install does not depend on it.
  }
  return { ok: true, ...base, slug, readme } satisfies MarketDetail
}

/**
 * Sanitize a market slug into a dsh-visible skill directory name: the skill
 * providers only discover kebab-case directories, so everything else is
 * transliterated instead of installed as an invisible directory.
 */
export function sanitizeSkillDirName(slug: string): string {
  const kebab = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return kebab === '' ? 'market-skill' : kebab
}

/** Lowercase names of the skills already present in $DSH_HOME/skills. */
export function readInstalledNamesForMarket(): string[] {
  if (!existsSync(MARKET_SKILLS_DIR)) return []
  try {
    return readdirSync(MARKET_SKILLS_DIR)
      .filter(entry => /^[a-z0-9]/i.test(entry))
      .map(entry => entry.toLowerCase())
  } catch {
    return []
  }
}

/**
 * Safe ZIP extraction: central-directory driven, store + deflate, with
 * entry-count / size caps and a zip-slip guard on every path. Malicious or
 * malformed archives throw instead of extracting partially.
 * @param zipBuffer - the downloaded archive.
 * @param targetDir - destination directory (created by the caller).
 */
export function extractZipSafe(zipBuffer: Buffer, targetDir: string): void {
  // Locate the End Of Central Directory record (scan the tail; the comment is
  // variable-length so the signature position is not fixed).
  let eocd = -1
  const scanFrom = Math.max(0, zipBuffer.length - 22 - 65_536)
  for (let i = zipBuffer.length - 22; i >= scanFrom; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('ZIP 解析失败：找不到中央目录（不是有效的 zip）')
  const entries = zipBuffer.readUInt16LE(eocd + 10)
  if (entries > MAX_ENTRIES) throw new Error(`ZIP 条目数 ${entries} 超过上限 ${MAX_ENTRIES}`)
  let ptr = zipBuffer.readUInt32LE(eocd + 16)
  let totalUncompressed = 0
  targetDir = resolve(targetDir)
  for (let index = 0; index < entries; index += 1) {
    if (zipBuffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('ZIP 解析失败：中央目录条目损坏')
    const method = zipBuffer.readUInt16LE(ptr + 10)
    const compressedSize = zipBuffer.readUInt32LE(ptr + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(ptr + 24)
    const nameLength = zipBuffer.readUInt16LE(ptr + 28)
    const extraLength = zipBuffer.readUInt16LE(ptr + 30)
    const commentLength = zipBuffer.readUInt16LE(ptr + 32)
    const localOffset = zipBuffer.readUInt32LE(ptr + 42)
    const name = zipBuffer.toString('utf8', ptr + 46, ptr + 46 + nameLength)
    ptr += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/') || name === '') continue
    if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/') || name.endsWith('.DS_Store')) continue

    // Local header: name/extra lengths there can differ from the central record.
    const localNameLength = zipBuffer.readUInt16LE(localOffset + 26)
    const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const rawData = zipBuffer.subarray(dataStart, dataStart + compressedSize)
    let content: Buffer
    if (method === 0) content = rawData
    else if (method === 8) content = inflateRawSync(rawData, { maxOutputLength: MAX_FILE_UNCOMPRESSED })
    else throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方式 ${method}`)
    totalUncompressed += content.length
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP 解压总量超过安全上限（疑似 zip bomb）')
    if (content.length !== uncompressedSize) throw new Error(`ZIP 条目 ${name} 解压后大小不符`)

    // Zip-slip guard: the resolved target must stay inside targetDir.
    const safeName = name.split('\\').join('/')
    const outPath = resolve(targetDir, safeName)
    if (outPath !== targetDir && !outPath.startsWith(targetDir + sep)) {
      throw new Error(`ZIP 条目 ${name} 试图写到目标目录之外，已拒绝`)
    }
    mkdirSync(outPath.substring(0, outPath.lastIndexOf(sep)), { recursive: true })
    writeFileSync(outPath, content)
  }
}

/**
 * Install one market skill: download the ZIP (with cross-source fallback),
 * safe-extract into a staging dir, locate the SKILL.md, then install it under
 * `$DSH_HOME/skills/<dirName>` via the same bundle installer the git import
 * uses. Returns the installed directory name and display metadata.
 */
export async function installMarketSkill(request: {
  source?: string
  slug: string
  ownerHandle?: string
}): Promise<{ ok: true; dirName: string; name: string; dir: string; source: string } | { ok: false; error: string }> {
  const slug = request.slug.trim()
  const source = request.source === 'clawhub' ? 'clawhub' : 'skillhub'
  const wanted = [source, source === 'skillhub' ? 'clawhub' : 'skillhub']
  const dirName = sanitizeSkillDirName(slug)

  let zipBuffer: Buffer | undefined
  const downloadErrors: string[] = []
  for (const trySource of wanted) {
    try {
      const params = new URLSearchParams({ slug })
      if (trySource === 'clawhub' && request.ownerHandle !== undefined && request.ownerHandle !== '') {
        params.set('ownerHandle', request.ownerHandle)
      }
      const url = trySource === 'skillhub'
        ? `${SKILLHUB_API}/api/v1/download?${params.toString()}`
        : `${CLAWHUB_API}/api/v1/download?${params.toString()}`
      zipBuffer = await getBuffer(url)
      break
    } catch (error) {
      downloadErrors.push(`${trySource}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (zipBuffer === undefined) {
    return { ok: false, error: `技能包下载失败（${downloadErrors.join('；')}）` }
  }

  // Extract into the shared staging area; the 'skill-' prefix makes the
  // startup sweep clean up anything this run leaves behind.
  mkdirSync(WORKBENCH_STATE_DIR, { recursive: true })
  const stagingRoot = join(WORKBENCH_STATE_DIR, '.staging')
  mkdirSync(stagingRoot, { recursive: true })
  const staging = join(stagingRoot, `skill-market-${randomUUID()}`)
  try {
    mkdirSync(staging, { recursive: true })
    extractZipSafe(zipBuffer, staging)

    // Locate SKILL.md: at the root, or one nested directory down (the common
    // "repo ships a folder" layout).
    let srcDir = staging
    if (!existsSync(join(srcDir, 'SKILL.md'))) {
      const children = readdirSync(srcDir, { withFileTypes: true }).filter(e => e.isDirectory())
      const nested = children.find(child => existsSync(join(srcDir, child.name, 'SKILL.md')))
      if (nested === undefined) {
        return { ok: false, error: `下载的技能包中没有 SKILL.md（顶层内容：${readdirSync(srcDir).join('、') || '<空>'}）` }
      }
      srcDir = join(srcDir, nested.name)
    }
    const meta = parseFrontmatter(readFileSync(join(srcDir, 'SKILL.md'), 'utf8'))

    const destDir = join(MARKET_SKILLS_DIR, dirName)
    installBundleDir(srcDir, destDir, staging)
    return { ok: true, dirName, name: meta.front.name ?? dirName, dir: destDir, source: source }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try { rmSync(staging, { recursive: true, force: true, maxRetries: 4 }) } catch { /* swept on next mount */ }
  }
}
