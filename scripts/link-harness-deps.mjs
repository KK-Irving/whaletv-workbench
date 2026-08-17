/**
 * Link the dsh installation's flat module fallback into this project so the
 * Host Loader, tsdown, and the TypeScript editor resolve @deepseek-ai/* peers
 * without pnpm managing them. Mirrors what dsh itself does for profile-local
 * plugins ($DSH_HOME/profiles/node_modules, healed by the launcher): one
 * junction per package, idempotent, never touches a real directory.
 *
 * The fallback layout is <fallback>/<package-name> plus scoped dirs
 * <fallback>/@deepseek-ai/<package-name>; both shapes are mirrored here.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const FALLBACK = join(DSH_HOME, 'profiles', 'node_modules')

/**
 * Ensure `link` is a junction to `target`. Idempotent: a correct junction
 * stays, a wrong junction or real directory is left alone, a missing path is
 * created.
 * @returns true when a new junction was created.
 */
function ensureJunction(link, target) {
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) return false
    return false // real directory: belongs to pnpm, never touch
  } catch {
    // Missing link — fall through to create it.
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
  return true
}

function linkFallback() {
  if (!existsSync(FALLBACK)) {
    console.warn(`link-harness: ${FALLBACK} 不存在 —— 请先运行一次 dsh web（或 dsh plugin）让启动器生成平铺回退目录。`)
    return
  }
  let created = 0
  for (const entry of readdirSync(FALLBACK)) {
    const target = join(FALLBACK, entry)
    if (!existsSync(target)) continue
    if (entry.startsWith('@')) {
      for (const pkg of readdirSync(target)) {
        if (ensureJunction(join(ROOT, 'node_modules', entry, pkg), join(target, pkg))) created += 1
      }
    } else if (ensureJunction(join(ROOT, 'node_modules', entry), target)) {
      created += 1
    }
  }
  console.log(`link-harness: 在 ${join(ROOT, 'node_modules')} 下新建 ${created} 个 junction`)
}

linkFallback()
