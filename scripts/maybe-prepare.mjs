/**
 * `prepare` gate: pnpm runs `prepare` after `git install` (so a
 * `dsh plugin add github:...` install of this bundle self-builds its lib/),
 * on `pnpm install` in this checkout, and before `pnpm publish`. When the
 * consumer already has built artifacts or does not want the build to run
 * (CI split into separate install / build stages, monorepo hoist, throwaway
 * containers), set `DSH_SKIP_PREPARE=1` to skip the bundle step.
 *
 * Delegates to `pnpm run bundle` otherwise; the exit code and streamed
 * output pass through so the outer pnpm sees the build failure directly.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// One env-var short-circuit covers every skip case (CI stage split, monorepo
// re-install, or an intentional consumer who packages built artifacts).
if (process.env.DSH_SKIP_PREPARE !== undefined && process.env.DSH_SKIP_PREPARE !== '') {
  console.log('maybe-prepare: DSH_SKIP_PREPARE set — skipping bundle build.')
  process.exit(0)
}

// A pre-built lib/client.js indicates the consumer already ran bundle (e.g.
// a git tag published with `pnpm pack`); skip so redundant work never fires
// on hoisted monorepo installs. `pnpm run bundle` remains available for a
// deliberate rebuild.
if (existsSync(join(ROOT, 'lib', 'client.js')) && existsSync(join(ROOT, 'lib', 'index.js'))) {
  console.log('maybe-prepare: lib/ already built — skipping bundle build.')
  process.exit(0)
}

// pnpm 11 exports `NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS`, which npm 11
// warns about as unknown when it appears in any subprocess env. Drop the
// noise vars before spawning; pnpm still reads its own config sources.
const cleanEnv = { ...process.env }
delete cleanEnv.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS
delete cleanEnv.npm_config_manage_package_manager_versions

const needsShell = process.platform === 'win32'
const result = spawnSync('pnpm', ['run', 'bundle'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: needsShell, // pnpm is a .cmd shim on Windows and must go through the shell.
  windowsHide: true,
  env: cleanEnv,
})
process.exit(result.status ?? 1)
