/**
 * pnpm build-approval plumbing for the tarball update channel (v0.8.10).
 *
 * pnpm ≥10 refuses lifecycle scripts of dependencies by default, and pnpm 11
 * additionally treats a **git-hosted** dependency as needing a "prepare": the
 * profile must carry an explicit approval, or `pnpm add github:...` dies with
 *
 *   [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts:
 *     whaletv-workbench@https://codeload.github.com/.../tar.gz/<sha>
 *   Run "pnpm approve-builds" ...
 *
 *   [ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... Add the package to "allowBuilds":
 *     whaletv-workbench@git+https://github.com/...git#<sha>: true
 *
 * The approval key is pinned to the fetched commit, so every new release asks
 * for a new key — a one-time manual `pnpm approve-builds` never unblocks the
 * next update. This module extracts the key pnpm itself printed and merges it
 * into the profile's `pnpm-workspace.yaml`, so the in-panel update keeps
 * working without the user editing pnpm config by hand.
 *
 * This package ships a prebuilt `lib/`, so it genuinely needs no build step:
 * the update command also skips lifecycle scripts for that reason.
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Our package name — only our own keys are ever approved. */
const PACKAGE_NAME = 'whaletv-workbench'

/**
 * Extract the approval keys pnpm demanded for THIS package from its refusal
 * message. Covers both shapes pnpm prints: the tarball URL form that
 * `ERR_PNPM_IGNORED_BUILDS` lists, and the `git+…#<sha>` form that
 * `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` asks to put into `allowBuilds`.
 *
 * @param message - the captured pnpm stderr/stdout.
 * @returns unique keys, empty when the message was not an approval refusal.
 */
export function approvalKeysFor(message: string): string[] {
  const matches = message.match(new RegExp(`${PACKAGE_NAME}@[^\\s,;)\\]"']+`, 'g')) ?? []
  const keys = matches
    .map(key => key.replace(/[.,;:]+$/, ''))
    // A real approval key carries the fetched URL; the prose around the
    // example ("the package whaletv-workbench@0.8.9 needs…") does not.
    .filter(key => key.includes('://'))
  return [...new Set(keys)]
}

/** Quote a value as a YAML double-quoted scalar. */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Merge build approvals into the profile's `pnpm-workspace.yaml`.
 *
 * Both spellings are written because pnpm split them across versions:
 * `onlyBuiltDependencies` (the name-level list `pnpm approve-builds` writes on
 * pnpm 10/early 11) and `allowBuilds` (the commit-pinned map newer pnpm
 * demands). Unknown keys are ignored by the other version, and nothing is ever
 * removed — an existing file keeps every line it had.
 *
 * @param profileDir - the dsh profile directory owning the install.
 * @param keys - commit-pinned keys from `approvalKeysFor`.
 * @returns whether the file changed, and an error when it could not be written.
 */
export function grantBuildApproval(
  profileDir: string, keys: readonly string[],
): { ok: boolean; changed: boolean; error?: string } {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  try {
    const original = existsSync(file) ? readFileSync(file, 'utf8') : ''
    let next = original
    const newline = (text: string): string => (text === '' || text.endsWith('\n') ? '' : '\n')

    // Name-level list first: the form pnpm's own approve-builds writes.
    if (!/^onlyBuiltDependencies:/m.test(next)) {
      next += `${newline(next)}onlyBuiltDependencies:\n  - ${PACKAGE_NAME}\n`
    } else if (!/^\s*-\s*"?whaletv-workbench"?\s*$/m.test(next)) {
      next = next.replace(/^(onlyBuiltDependencies:[^\n]*\n)/m, `$1  - ${PACKAGE_NAME}\n`)
    }

    // Commit-pinned map second: what pnpm 11.x actually matches a git fetch against.
    const wanted = keys.map(key => `  ${yamlQuote(key)}: true`)
    if (wanted.length > 0) {
      if (!/^allowBuilds:/m.test(next)) {
        next += `${newline(next)}allowBuilds:\n${wanted.join('\n')}\n`
      } else {
        const missing = wanted.filter(line => !next.includes(line.trim()))
        if (missing.length > 0) {
          next = next.replace(/^(allowBuilds:[^\n]*\n)/m, `$1${missing.join('\n')}\n`)
        }
      }
    }

    if (next === original) return { ok: true, changed: false }
    if (original !== '') writeFileSync(`${file}.whaletv.bak`, original, 'utf8')
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, next, 'utf8')
    renameSync(tmp, file)
    return { ok: true, changed: true }
  } catch (error) {
    return { ok: false, changed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Locate the dsh profile directory that owns this install.
 *
 * The old derivation (`packageDir/../..`) only holds for the flat
 * `node_modules/<pkg>` layout; under a `link:`/junction install it points at
 * the checkout's grandparent. Two robust sources instead:
 *   1. a `node_modules/<pkg>` parent whose grandparent is a profile;
 *   2. any profile under `$DSH_HOME/profiles` that lists this package as a
 *      dependency (the link: case).
 *
 * @param packageDir - this package's root (the Host half's PACKAGE_DIR).
 * @param dshHome - resolved $DSH_HOME.
 * @returns the profile directory, or undefined when none can be proven.
 */
export function resolveProfileDir(packageDir: string, dshHome: string): string | undefined {
  const pkgParent = dirname(packageDir)
  if (basename(pkgParent) === 'node_modules') {
    const candidate = dirname(pkgParent)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  try {
    const profilesRoot = join(dshHome, 'profiles')
    for (const entry of readdirSync(profilesRoot)) {
      const candidate = join(profilesRoot, entry)
      const manifest = join(candidate, 'package.json')
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> }
      if (parsed.dependencies?.[PACKAGE_NAME] !== undefined) return candidate
    }
  } catch {
    // No profiles directory / unreadable manifest: fall through to undefined.
  }
  return undefined
}

/**
 * Whether a pnpm failure is the build-approval refusal (as opposed to a
 * network or lockfile error), so the caller knows a retry can help.
 * @param message - captured pnpm output.
 */
export function isBuildApprovalRefusal(message: string): boolean {
  return /ERR_PNPM_IGNORED_BUILDS|ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|approve-builds|allowBuilds|needs to execute build scripts/i.test(message)
}
