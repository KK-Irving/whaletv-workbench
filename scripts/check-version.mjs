#!/usr/bin/env node
/**
 * Version-consistency gate (roadmap P0-5): the package.json version must
 * equal the version quoted in README.md and docs/DESIGN.md
 * (`当前版本 **vX.Y.Z**` in both). The three copies drifted once already
 * (README said v0.5.1 while package.json said 0.6.0), so this check runs as
 * part of `pnpm run smoke` and fails loudly on drift.
 *
 * Usage: node scripts/check-version.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = manifest.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`check-version: package.json version 缺失或格式非法：${String(version)}`)
  process.exit(1)
}

/** Files whose `当前版本 **v…**` marker must match package.json. */
const MARKERS = [
  ['README.md', /当前版本\s*\*\*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\*\*/],
  ['docs/DESIGN.md', /当前版本\s*\*\*v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\*\*/],
]

let failed = false
for (const [file, pattern] of MARKERS) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const match = pattern.exec(text)
  if (match === null) {
    console.error(`check-version: ${file} 未找到「当前版本 **v…**」标记 —— 请补上 v${version}`)
    failed = true
  } else if (match[1] !== version) {
    console.error(`check-version: ${file} 标记 v${match[1]} ≠ package.json ${version}`)
    failed = true
  }
}
if (failed) process.exit(1)
console.log(`check-version: OK — package.json ${version} 与 README.md / docs/DESIGN.md 一致`)
