#!/usr/bin/env node
/**
 * lib/ drift gate: the committed build output must equal a fresh build.
 *
 * `lib/` ships in the repository on purpose (a build-script-free tarball
 * installs without pnpm's allowBuilds gate) — but that only holds while the
 * committed bundle is what `pnpm run bundle` actually produces. Edit src,
 * forget to rebuild, push: every user installs stale code, and nothing warns.
 *
 * Usage (CI runs the build first, then this gate):
 *   pnpm run bundle && node scripts/check-lib-drift.mjs
 *
 * On a fresh checkout without a rebuild the working tree equals HEAD, so this
 * doubles as a cheap "you rebuilt lib/ but did not commit it" check.
 *
 * Exits non-zero and prints the offending files when they differ.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Normalize away the checkout location, which leaks into the bundle in two
 * places: rolldown's `//#region <path>` comments for inlined dependencies and
 * the sourcemap's `sources` entries (absolute when a dependency resolves
 * through a junction). Both forms — `E:/a/b/node_modules/x`, `/home/ci/w/node_modules/x`,
 * `../node_modules/x` — collapse to one placeholder, so only real content
 * differences remain.
 *
 * @param text - file content to normalize.
 * @returns the content with dependency paths collapsed.
 */
export function normalize(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/(?:[A-Za-z]:)?[^\s"']*?node_modules\//g, '<root>/node_modules/')
}

/** Run one git command in the repo root. */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

function main() {
  const tracked = git(['ls-files', 'lib']).trim().split('\n').filter(line => line !== '')
  const untracked = git(['ls-files', '--others', '--exclude-standard', 'lib']).trim().split('\n').filter(line => line !== '')
  const problems = []

  for (const rel of tracked) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) {
      problems.push(`${rel}: committed but missing from the working tree (run pnpm run bundle)`)
      continue
    }
    let head
    try {
      head = git(['show', `HEAD:${rel}`])
    } catch {
      problems.push(`${rel}: not committed yet — commit the rebuilt lib/ with the source change`)
      continue
    }
    if (normalize(head) !== normalize(readFileSync(abs, 'utf8'))) {
      problems.push(`${rel}: working tree differs from the committed build output`)
    }
  }

  for (const rel of untracked) {
    problems.push(`${rel}: built but not committed`)
  }

  if (problems.length > 0) {
    console.error('check-lib-drift: lib/ is out of date — run `pnpm run bundle` and commit lib/ together with the source change:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`check-lib-drift: OK — ${tracked.length} committed lib file(s) match a fresh build`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
