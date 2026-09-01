/**
 * Link the dsh installation's flat module fallback into this project so the
 * Host Loader, tsdown, and the TypeScript editor resolve @deepseek-ai/* peers
 * without pnpm managing them. One junction per package, idempotent, never
 * touches a real directory.
 *
 * Primary source: the maintained flat fallback at
 * `$DSH_HOME/profiles/node_modules` (healed by the dsh launcher at boot).
 *
 * Secondary source (repair pass): the harness checkout itself, rooted at
 * `DSH_HARNESS_ROOT` or the sibling `../deepseek-harness`. The launcher only
 * rewrites fallback entries in the CURRENT installation generation, so when
 * dsh removes/renames a package (dsh-client-runtime, dsh-client-web-react,
 * dsh-client-schema-form in the 0.1.2 cycle) the stale junction it leaves
 * behind dangles. This pass replaces broken junctions with fresh links into
 * the checkout source tree, found by walking `packages/**` (bounded depth,
 * skipping node_modules/.git/lib/dist) for a manifest whose `name` matches.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const FALLBACK = join(DSH_HOME, 'profiles', 'node_modules')
const HARNESS_ROOT = process.env.DSH_HARNESS_ROOT
  ?? join(dirname(ROOT), 'deepseek-harness')

/** package name → real directory, discovered once from the checkout tree. */
const checkoutIndex = new Map()

/**
 * Whether `link` resolves to a readable package manifest. A dangling junction
 * (target pruned by a later dsh checkout `pnpm install`) fails the lstat read
 * and is treated as missing.
 */
function linkHealthy(link) {
  try {
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink()) return true // real directory: belongs to pnpm, never touch
    return existsSync(join(link, 'package.json'))
  } catch {
    return false // missing
  }
}

/**
 * Ensure `link` is a healthy junction. Broken or missing links are created /
 * replaced; a healthy junction or a real directory is left alone.
 * @returns 'created' | 'repaired' | 'kept' | 'skipped-real-dir'.
 */
function ensureJunction(link, target) {
  try {
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink()) return 'skipped-real-dir'
    if (existsSync(join(link, 'package.json'))) return 'kept'
    // Dangling junction: drop it, then fall through to recreate.
    rmSync(link, { force: true })
  } catch {
    // Missing link — fall through to create it.
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
  return 'repaired'
}

/** Recursively index checkout package manifests (bounded depth, pruned dirs). */
function indexCheckout(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir) || checkoutIndex.size > 400) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  const manifest = join(dir, 'package.json')
  if (existsSync(manifest)) {
    try {
      const name = JSON.parse(readFileSync(manifest, 'utf8')).name
      if (typeof name === 'string' && !checkoutIndex.has(name)) checkoutIndex.set(name, dir)
    } catch { /* unreadable manifest: not indexable */ }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'lib'
      || entry.name === 'dist' || entry.name === 'tests' || entry.name === 'docs') continue
    indexCheckout(join(dir, entry.name), depth + 1)
  }
}

/** Resolve one package name to a live directory, fallback first, checkout second. */
function resolveSource(name) {
  const fallbackDir = join(FALLBACK, name)
  if (existsSync(join(fallbackDir, 'package.json'))) return fallbackDir
  if (existsSync(FALLBACK) && existsSync(fallbackDir)) return fallbackDir // junction target lives deeper
  return checkoutIndex.get(name)
}

function linkFallback() {
  if (!existsSync(FALLBACK)) {
    console.warn(`link-harness: ${FALLBACK} 不存在 —— 请先运行一次 dsh web（或 dsh plugin）让启动器生成平铺回退目录。`)
    return
  }
  if (existsSync(join(HARNESS_ROOT, 'package.json'))) indexCheckout(HARNESS_ROOT)
  const counts = { linked: 0, kept: 0, real: 0, pruned: 0, unresolved: [] }
  const linkOne = (link, name, required) => {
    const source = resolveSource(name)
    if (source === undefined) {
      if (linkHealthy(link)) return
      // A dangling junction with no discoverable source is dead weight from a
      // package dsh removed — prune it rather than leave it poisoning
      // resolution. Required (declared) packages are reported loudly instead.
      if (required) counts.unresolved.push(name)
      else { rmSync(link, { force: true }); counts.pruned += 1 }
      return
    }
    const outcome = ensureJunction(link, source)
    if (outcome === 'repaired') counts.linked += 1
    else if (outcome === 'kept') counts.kept += 1
    else if (outcome === 'skipped-real-dir') counts.real += 1
  }
  for (const entry of readdirSync(FALLBACK)) {
    const target = join(FALLBACK, entry)
    if (!existsSync(target)) continue
    if (entry.startsWith('@')) {
      for (const pkg of readdirSync(target)) {
        linkOne(join(ROOT, 'node_modules', entry, pkg), `${entry}/${pkg}`, false)
      }
    } else {
      linkOne(join(ROOT, 'node_modules', entry), entry, false)
    }
  }
  // The fallback mirrors only the current installation generation: packages
  // dsh still ships but the running boot never linked (fresh renames, or the
  // launcher predating them) would be missed by the pass above. Declare the
  // needed set from this project's peerDependencies and make sure each one
  // resolves.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    linkOne(join(ROOT, 'node_modules', ...name.split('/')), name, true)
  }
  console.log(`link-harness: 新建/修复 ${counts.linked} 个 junction（保留 ${counts.kept}，实目录跳过 ${counts.real}，清理悬挂 ${counts.pruned}）`)
  if (counts.unresolved.length > 0) {
    console.warn(`link-harness: 以下声明的依赖在回退目录与 harness checkout 中均不可解析：${counts.unresolved.join(', ')}`)
  }
}

linkFallback()
