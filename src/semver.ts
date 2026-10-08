/**
 * Standalone semantic-version helpers for the tarball update channel.
 *
 * Deliberately a LEAF module: it imports nothing (no node builtins, no dsh
 * graph), so the pure-logic unit suite (`scripts/unit.mjs`, `node --test`)
 * can import it directly on a fresh checkout — before `pnpm run bundle` and
 * without the linked `@deepseek-ai/*` peers that the host smoke needs. The
 * update domain re-exports both functions so the public surface is unchanged.
 *
 * Precedence follows the SemVer §11 rules the update checker actually meets:
 * numeric release triples compared field by field, then the pre-release tail
 * compared identifier by identifier (numeric identifiers numerically, so
 * `rc.2` sorts BEFORE `rc.10`), and a release always outranks any of its own
 * pre-releases (`1.0.0` is newer than `1.0.0-rc.9`). Build metadata (`+…`)
 * is ignored for ordering.
 */

/** A parsed version: the release triple plus its raw pre-release identifiers. */
interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated pre-release identifiers; empty for a plain release. */
  prerelease: string[]
}

/**
 * Parse `x.y.z[-pre.release][+build]` into comparable parts. Missing numeric
 * fields default to 0; build metadata is stripped (it never affects order).
 * Non-numeric or absent cores collapse to zeros so a malformed string simply
 * sorts as the lowest possible release rather than throwing.
 */
function parseVersion(value: string): ParsedVersion {
  // Strip build metadata first: it is not part of precedence (SemVer §10).
  const withoutBuild = value.split('+', 1)[0] ?? ''
  const dash = withoutBuild.indexOf('-')
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
  const pre = dash === -1 ? '' : withoutBuild.slice(dash + 1)
  const [major = 0, minor = 0, patch = 0] = core.split('.').map(part => Number.parseInt(part, 10) || 0)
  const prerelease = pre === '' ? [] : pre.split('.')
  return { major, minor, patch, prerelease }
}

/** Whether an identifier is a pure non-negative integer (numeric per SemVer §11). */
function isNumericIdentifier(identifier: string): boolean {
  return /^\d+$/.test(identifier)
}

/**
 * Compare two pre-release identifier lists per SemVer §11.
 *   - An empty list (a release) always ranks HIGHER than a non-empty one.
 *   - Numeric identifiers compare numerically; `rc.2` < `rc.10`.
 *   - Numeric identifiers always rank lower than alphanumeric ones.
 *   - A longer list ranks higher when all earlier identifiers are equal.
 * @returns 1 when `a` > `b`, -1 when `a` < `b`, 0 when equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
  // A plain release outranks any pre-release of the same release triple.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const ai = a[i]
    const bi = b[i]
    if (ai === bi) continue
    const aNumeric = isNumericIdentifier(ai)
    const bNumeric = isNumericIdentifier(bi)
    if (aNumeric && bNumeric) {
      const diff = Number.parseInt(ai, 10) - Number.parseInt(bi, 10)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    // Numeric identifiers have lower precedence than alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return ai > bi ? 1 : -1
  }
  // All shared identifiers equal: the longer list has higher precedence.
  if (a.length === b.length) return 0
  return a.length > b.length ? 1 : -1
}

/**
 * Whether `latest` is strictly newer than `installed` under SemVer precedence.
 *
 * Fixes the pre-release boundary the lexical comparison got wrong:
 *   - `1.0.0-rc.2` vs `1.0.0-rc.10` → rc.10 is newer (numeric, not lexical);
 *   - `1.0.0` vs `1.0.0-rc.1`      → the release is newer than its rc.
 */
function isSemverGt(latest: string, installed: string): boolean {
  const l = parseVersion(latest)
  const i = parseVersion(installed)
  if (l.major !== i.major) return l.major > i.major
  if (l.minor !== i.minor) return l.minor > i.minor
  if (l.patch !== i.patch) return l.patch > i.patch
  return comparePrerelease(l.prerelease, i.prerelease) > 0
}

/**
 * Pull the semver `version` field out of a package.json document, accepting
 * only a well-formed `x.y.z[…]` value. Malformed JSON or a non-string /
 * non-semver field yields undefined so the probe chain moves to the next
 * source rather than trusting garbage.
 */
function parseVersionField(packageJson: string): string | undefined {
  try {
    const version = (JSON.parse(packageJson) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

export { isSemverGt, parseVersionField }