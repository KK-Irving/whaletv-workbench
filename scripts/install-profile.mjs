/**
 * Install whaletv-workbench into a dsh profile ($DSH_HOME/profiles/<name>):
 *
 * 1. Build the Host/client bundles (pnpm run bundle) so a hot insert never
 *    serves a missing lib/client.js.
 * 2. Add `whaletv-workbench` as a `link:` dependency of the profile manifest
 *    (link, not file: updates apply in place after git pull) and pnpm install
 *    the profile.
 * 3. Insert the plugin row into the profile's cordis.patch.yml (idempotent;
 *    the running dsh web hot-reloads this user layer and mounts the plugin
 *    without a restart).
 * 4. Mirror the installation's module fallback into this project's
 *    node_modules (link-harness-deps) so the Host half resolves its peers.
 *
 * Usage: node scripts/install-profile.mjs [profile]  (default: web)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE_NAME = 'whaletv-workbench'
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
const profile = process.argv[2] ?? 'web'
const PROFILE_DIR = join(DSH_HOME, 'profiles', profile)
const MANIFEST_PATH = join(PROFILE_DIR, 'package.json')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')

const INSERT_ROW = `- insert:\n    - id: ${PACKAGE_NAME}\n      name: '${PACKAGE_NAME}'\n`

/**
 * Drop pnpm 11's noisy `NPM_CONFIG_*` env vars before spawning; npm 11 warns
 * about them as unknown and floods this script's captured output otherwise.
 * pnpm subprocesses still honor the setting through their own config sources.
 */
function sanitizedEnv() {
  const env = { ...process.env }
  delete env.NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS
  delete env.npm_config_manage_package_manager_versions
  return env
}

/** Resolve spawn options for this platform (npm/pnpm are .cmd shims on Windows). */
function spawnOptions(command) {
  const needsShell = process.platform === 'win32' && (command === 'pnpm' || command === 'npm')
  return { cwd: undefined, stdio: 'inherit', windowsHide: true, shell: needsShell, env: sanitizedEnv() }
}

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { ...spawnOptions(command), cwd })
}

function fail(message) {
  console.error(`install-profile: ${message}`)
  process.exitCode = 1
}

if (!existsSync(join(ROOT, 'lib', 'client.js'))) {
  console.log('未找到 lib/client.js，先构建…')
  run('pnpm', ['run', 'bundle'], ROOT)
}

if (!existsSync(MANIFEST_PATH)) {
  fail(`profile 目录不存在：${PROFILE_DIR}（请先运行一次 dsh web 初始化 profile）`)
} else {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const spec = `link:${resolve(ROOT).replaceAll('\\', '/')}`
  if (manifest.dependencies?.[PACKAGE_NAME] === spec) {
    console.log(`profile 依赖已就绪：${PACKAGE_NAME} = ${spec}`)
  } else {
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: spec }
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, undefined, 2)}\n`)
    console.log(`已写入 profile 依赖：${PACKAGE_NAME} = ${spec}`)
  }
  run('pnpm', ['install'], PROFILE_DIR)
}

if (!existsSync(PATCH_PATH)) {
  writeFileSync(PATCH_PATH, `# dsh profile user patch layer\n- insert:\n    - id: ${PACKAGE_NAME}\n      name: '${PACKAGE_NAME}'\n`)
  console.log(`已创建 ${PATCH_PATH} 并插入插件行`)
} else {
  const patch = readFileSync(PATCH_PATH, 'utf8')
  if (patch.includes(`id: ${PACKAGE_NAME}`)) {
    console.log(`cordis.patch.yml 已包含插件行，跳过`)
  } else {
    const trimmed = patch.trimEnd()
    const next = trimmed === '[]' || trimmed.endsWith('[]')
      ? trimmed.replace(/\[\s*\]\s*$/, INSERT_ROW.trimEnd())
      : `${trimmed}\n${INSERT_ROW}`
    writeFileSync(PATCH_PATH, `${next}\n`)
    console.log(`已向 cordis.patch.yml 插入插件行`)
  }
}

run('node', ['scripts/link-harness-deps.mjs'], ROOT)

console.log(`
安装完成。运行中的 dsh web 会热加载 cordis.patch.yml 并自动挂载插件；
若未在运行，执行 dsh web 后刷新浏览器即可看到侧边栏底部的「WhaleTV 工作台」入口。
卸载：从 ${PATCH_PATH} 删除插件行，并从 profile 依赖中移除 ${PACKAGE_NAME} 后 pnpm install。
`)
