/**
 * One-click harness restart (roadmap ③ update loop).
 *
 * The update flow tells the user "重启 dsh 后生效" and then makes them find the
 * tray/app restart by hand. This module closes that gap with the strongest
 * mechanism each host actually offers:
 *
 * - Desktop app (Electron main process): `app.relaunch()` + `app.exit()`, the
 *   supported way to restart the app — clean shutdown, same arguments, no PID
 *   games and no command for the user to copy.
 * - Plain Node CLI host: a detached helper (written into the plugin's own
 *   state directory, so tarball installs that ship only `lib/` have it too)
 *   waits for this process to exit, gives a supervising launcher a few seconds
 *   to bring the harness back, and only then starts the replacement itself.
 * - Service-managed hosts (systemd's `INVOCATION_ID`): NOT restarted from
 *   here — exiting would kill the unit's cgroup along with the replacement —
 *   and hosts whose entry cannot be identified get the exact command to run
 *   instead. Those are the only two cases that ask the user to do it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { WORKBENCH_STATE_DIR } from './host-plumbing.ts'
import type { WorkbenchRestartPlan } from './shared.ts'

/** Where the helper script + its plan document live. */
const RESTART_DIR = join(WORKBENCH_STATE_DIR, '.restart')

/** How long this process waits before exiting, so the HTTP response flushes. */
export const RESTART_EXIT_DELAY_MS = 1_200

/** Quote one argv token for a copy-and-paste command line. */
function quote(token: string): string {
  return /[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token
}

/**
 * Electron's own app object, when this Host half runs inside the desktop
 * app's main process (the harness entry is handed to the Electron binary as
 * its main script — `process.versions.electron` is then set).
 *
 * `app.relaunch()` + `app.exit()` is THE supported desktop restart: unlike
 * killing and respawning the process, it lets Electron shut down cleanly and
 * start the same app again with the same arguments. A child process spawned
 * with ELECTRON_RUN_AS_NODE has no `app`, which is exactly why this is probed
 * instead of assumed.
 */
interface ElectronApp {
  relaunch?: () => void
  exit?: (code?: number) => void
}

function electronApp(): ElectronApp | undefined {
  if (process.versions.electron === undefined) return undefined
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as { app?: ElectronApp }
    return electron.app
  } catch {
    return undefined
  }
}

/** Whether this host is service-managed (where killing ourselves kills the unit too). */
function serviceManaged(): boolean {
  return process.env.INVOCATION_ID !== undefined && process.env.INVOCATION_ID !== ''
}

/**
 * Derive the restart plan for this process.
 * @returns the plan the UI shows, including which strategy will run.
 */
export function buildRestartPlan(): WorkbenchRestartPlan {
  const entry = process.argv[1]
  const command = [process.execPath, ...process.argv.slice(1)].map(quote).join(' ')
  // 1. Desktop app: ask Electron to relaunch itself.
  const app = electronApp()
  if (app?.relaunch !== undefined && app.exit !== undefined) {
    return {
      ok: true, relaunchable: true, strategy: 'electron', command,
      note: '将通过桌面端自身的重启机制重启：应用窗口会关闭并自动重新打开（约 10–20 秒）。',
    }
  }
  // 2. Service-managed host: a replacement would fight the supervisor's cgroup.
  if (serviceManaged()) {
    return {
      ok: true, relaunchable: false, strategy: 'manual', command,
      note: '当前 harness 由 systemd 托管——从这里退出会连同 unit 的 cgroup 一起被杀，请用服务管理器重启。',
    }
  }
  // 3. Plain Node CLI host: relaunch the exact command through the helper.
  const entryLooksRunnable = typeof entry === 'string' && /\.(mjs|cjs|js)$/i.test(entry) && existsSync(entry)
  if (!entryLooksRunnable) {
    return {
      ok: true, relaunchable: false, strategy: 'manual', command,
      note: '无法确定 harness 的启动入口（argv[1] 不是可执行脚本），请手动重启，或直接使用上面的命令。',
    }
  }
  return {
    ok: true, relaunchable: true, strategy: 'helper', command,
    note: '将结束当前 harness 进程并由独立助手重新拉起（约 10–20 秒）。',
  }
}

/**
 * Detached helper source. Kept as a string so it travels with the Host bundle
 * and works for tarball installs that never see this repository's scripts/.
 */
const HELPER_SOURCE = `import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const serving = async () => {
  try {
    const response = await fetch(plan.probeUrl, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch { return false }
}

// 1. Wait for the harness to exit (the route exits ~1.2s after responding).
const deadline = Date.now() + plan.parentTimeoutMs
while (alive(plan.pid) && Date.now() < deadline) await sleep(250)
if (alive(plan.pid)) process.exit(1)

// 2. A supervising launcher (tray app, service manager) may bring it back.
//    Give it a few seconds; a winner here leaves this helper nothing to do.
const superviseDeadline = Date.now() + plan.supervisorGraceMs
while (Date.now() < superviseDeadline) {
  if (await serving()) process.exit(0)
  await sleep(300)
}

// 3. Nothing came back: start the replacement with the captured command.
const child = spawn(plan.command, plan.args, {
  cwd: plan.cwd,
  detached: true,
  stdio: 'ignore',
  env: process.env,
})
child.unref()
`

/** Write the helper + plan and spawn it detached; never throws. */
function spawnRestartHelper(): { ok: boolean; error?: string } {
  try {
    mkdirSync(RESTART_DIR, { recursive: true })
    const helperPath = join(RESTART_DIR, 'restart-helper.mjs')
    const planPath = join(RESTART_DIR, 'restart-plan.json')
    writeFileSync(helperPath, HELPER_SOURCE, 'utf8')
    writeFileSync(planPath, JSON.stringify({
      pid: process.pid,
      command: process.execPath,
      // argv.slice(1) keeps the CLI entry and its arguments, dropping node itself.
      args: process.argv.slice(1),
      cwd: process.cwd(),
      probeUrl: probeUrl(),
      parentTimeoutMs: 15_000,
      supervisorGraceMs: 3_000,
    }, null, 2), 'utf8')
    const child = spawn(process.execPath, [helperPath, planPath], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Address the helper probes to see whether the harness is serving again. */
function probeUrl(): string {
  const port = process.env.PORT ?? process.env.DSH_WEB_PORT ?? '3080'
  return `http://127.0.0.1:${port}/whaletv/workbench/state`
}

/**
 * Schedule the restart: respond first, then hand off to the mechanism this
 * host supports. Uses a native timer on purpose — `ctx.effect`-scoped timers
 * are bound to the plugin fiber, and this callback runs outside any fiber.
 *
 * @returns ok, or an error when the chosen mechanism could not be armed.
 */
export function requestRestart(plan: WorkbenchRestartPlan): { ok: boolean; error?: string } {
  if (!plan.relaunchable) return { ok: false, error: plan.note ?? '当前形态不支持面板内重启' }
  if (plan.strategy === 'electron') {
    const app = electronApp()
    if (app?.relaunch === undefined || app.exit === undefined) {
      return { ok: false, error: '桌面端重启 API 不可用（app.relaunch/app.exit 缺失）' }
    }
    // relaunch() queues the new instance for when this one exits.
    app.relaunch()
    setTimeout(() => { app.exit?.(0) }, RESTART_EXIT_DELAY_MS)
    return { ok: true }
  }
  const started = spawnRestartHelper()
  if (!started.ok) return started
  // Native setTimeout: the HTTP response is already on the wire by then.
  setTimeout(() => { process.exit(0) }, RESTART_EXIT_DELAY_MS)
  return { ok: true }
}
