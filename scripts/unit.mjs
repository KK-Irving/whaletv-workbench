#!/usr/bin/env node
/**
 * Pure-logic unit suite (`node --test`).
 *
 * Unlike the three mock-driven smoke scripts, this suite needs NO build and
 * NO linked `@deepseek-ai/*` peers: it imports the leaf module `src/semver.ts`
 * directly (Node strips the types), so it runs identically on a fresh CI
 * checkout and on a dev machine. It targets the one place a bare-eye review
 * keeps missing — SemVer pre-release ordering — where the previous lexical
 * comparison reported `rc.2` as newer than `rc.10` and a pre-release as newer
 * than its own release.
 *
 * Node ≥ 22 is required (the project's baseline). Type-stripping of the
 * zero-import `.ts` leaf module is native on ≥ 23.6 and available under
 * `--experimental-strip-types` on 22, so the `test:unit` npm script passes
 * that flag (a no-op on newer Node) to stay honest across the whole range.
 *
 * Run it directly (`node --experimental-strip-types scripts/unit.mjs`), NOT
 * through `node --test`: the file registers its tests with `node:test`, which
 * executes them in-process and sets a non-zero exit on failure. `node --test`
 * would instead spawn a per-file child runner — unnecessary here, and blocked
 * outright under a sandbox that denies nested process spawns.
 *
 * Usage: pnpm run test:unit   (or node --experimental-strip-types scripts/unit.mjs)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { isSemverGt, parseVersionField } = await import(
  pathToFileURL(join(ROOT, 'src', 'semver.ts')).href
)

test('isSemverGt — release triple precedence', () => {
  assert.equal(isSemverGt('1.0.1', '1.0.0'), true)
  assert.equal(isSemverGt('1.1.0', '1.0.9'), true)
  assert.equal(isSemverGt('2.0.0', '1.9.9'), true)
  assert.equal(isSemverGt('1.0.0', '1.0.0'), false)
  assert.equal(isSemverGt('1.0.0', '1.0.1'), false)
  assert.equal(isSemverGt('1.0.0', '2.0.0'), false)
})

test('isSemverGt — a release outranks its own pre-releases', () => {
  // The regression that mattered: the tarball checker compares against dsh's
  // `-rc.N` tags, and the lexical version had these two inverted.
  assert.equal(isSemverGt('1.0.0', '1.0.0-rc.1'), true)
  assert.equal(isSemverGt('1.0.0-rc.1', '1.0.0'), false)
  assert.equal(isSemverGt('0.2.0', '0.2.0-rc.2'), true)
})

test('isSemverGt — numeric pre-release identifiers sort numerically', () => {
  // `rc.10` is newer than `rc.2`; the lexical compare said the opposite.
  assert.equal(isSemverGt('1.0.0-rc.10', '1.0.0-rc.2'), true)
  assert.equal(isSemverGt('1.0.0-rc.2', '1.0.0-rc.10'), false)
  assert.equal(isSemverGt('0.2.0-rc.2', '0.2.0-rc.1'), true)
  assert.equal(isSemverGt('1.0.0-alpha.1', '1.0.0-alpha.1'), false)
})

test('isSemverGt — mixed identifier precedence (SemVer §11)', () => {
  // Numeric identifiers rank below alphanumeric ones.
  assert.equal(isSemverGt('1.0.0-rc.1', '1.0.0-rc.beta'), false)
  assert.equal(isSemverGt('1.0.0-rc.beta', '1.0.0-rc.1'), true)
  // A longer identifier list outranks its own prefix.
  assert.equal(isSemverGt('1.0.0-rc.1.1', '1.0.0-rc.1'), true)
  assert.equal(isSemverGt('1.0.0-rc.1', '1.0.0-rc.1.1'), false)
  // Alphanumeric identifiers compare lexically.
  assert.equal(isSemverGt('1.0.0-beta', '1.0.0-alpha'), true)
})

test('isSemverGt — build metadata is ignored for ordering', () => {
  assert.equal(isSemverGt('1.0.0+build.9', '1.0.0+build.1'), false)
  assert.equal(isSemverGt('1.0.1+build', '1.0.0'), true)
})

test('isSemverGt — malformed input sorts as the lowest release', () => {
  assert.equal(isSemverGt('nonsense', '1.0.0'), false)
  assert.equal(isSemverGt('1.0.0', 'nonsense'), true)
  // Missing trailing fields default to zero.
  assert.equal(isSemverGt('1', '1.0.0'), false)
  assert.equal(isSemverGt('1.2', '1.1.0'), true)
})

test('parseVersionField — extracts a well-formed version', () => {
  assert.equal(parseVersionField('{"version":"0.8.17"}'), '0.8.17')
  assert.equal(parseVersionField('{"version":"1.0.0-rc.2"}'), '1.0.0-rc.2')
  assert.equal(parseVersionField('{"name":"x","version":"2.3.4","private":true}'), '2.3.4')
})

test('parseVersionField — rejects malformed / non-semver / non-string', () => {
  assert.equal(parseVersionField('not json'), undefined)
  assert.equal(parseVersionField('{"version":123}'), undefined)
  assert.equal(parseVersionField('{"version":"v1.2.3"}'), undefined)
  assert.equal(parseVersionField('{"version":"1.2"}'), undefined)
  assert.equal(parseVersionField('{}'), undefined)
})