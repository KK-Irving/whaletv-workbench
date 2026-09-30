/**
 * One-click harness restart (roadmap ③ update loop).
 *
 * The update flow tells the user "重启 dsh 后生效" and then makes them find the
 * tray/app restart by hand. This module closes that gap — but only where a
 * restart can be done honestly:
 *
 * - The relaunch command is derived from THIS process (`execPath` + `argv`),
 *   so it is exactly how the harness was started, and it is only used when
 *   `argv[1]` is a real Node script we can point at again.
 * - Embedded hosts (Electron desktop app, `process.versions.electron`) and
 *   service-managed hosts (systemd's `INVOCATION_ID`) are NOT restarted from
 *   here: killing the process there kills the app or fights the supervisor.
 *   Those callers get `relaunchable: false` plus the exact command to run
 *   themselves.
 * - The restart runs through a detached helper written into the plugin's own
 *   state directory (so it exists for tarball installs, which ship only
 *   `lib/`): the helper waits for this process to exit, gives a supervising
 *   launcher a few seconds to bring the harness back, and only then starts
 *   the replacement itself. A supervisor that wins the race leaves the helper
 *   with nothing to do.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

/** Whether this host can relaunch itself faithfully. */
function embeddedHostReason(): string | undefined {
  if (process.versions.electron !== undefined) return '当前 harness 跑在 Electron 桌面端进程里'
  if (process.env.INVOCATION_ID !== undefined && process.env.INVOCATION_ID !== '') return '当前 harness 由 systemd 托管'
  return undefined
}

/**
 * Derive the restart plan for this process.
 * @returns the plan the UI shows (and the helper executes when relaunchable).
 */
export function buildRestartPlan(): WorkbenchRestartPlan {
  const entry = process.argv[1]
  const args = process.argv.slice(1)
  const command = [process.execPath, ...args].map(quote).join(' ')
  const embedded = embeddedHostReason()
  const entryLooksRunnable = typeof entry === 'string' && /\.(mjs|cjs|js)$/i.test(entry) && existsSync(entry)
  if (embedded !== undefined) {
    return { ok: true, relaunchable: false, command, note: `${embedded}——请用它的重启入口（托盘菜单 / 服务管理器）重启。` }
  }
  if (!entryLooksRunnable) {
    return {
      ok: true, relaunchable: false, command,
      note: '无法确定 harness 的启动入口（argv[1] 不是可执行脚本），请手动重启，或直接使用上面的命令。',
    }
  }
  return { ok: true, relaunchable: true, command }
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
 * Schedule the restart: respond first, then exit this process so the helper's
 * wait can end. Uses a native timer on purpose — `ctx.effect`-scoped timers
 * are bound to the plugin fiber, and this callback runs outside any fiber.
 *
 * @returns the plan for the UI, or an error when the helper could not start.
 */
export function requestRestart(plan: WorkbenchRestartPlan): { ok: boolean; error?: string } {
  if (!plan.relaunchable) return { ok: false, error: plan.note ?? '当前形态不支持面板内重启' }
  const started = spawnRestartHelper()
  if (!started.ok) return started
  // Native setTimeout: the HTTP response is already on the wire by then.
  setTimeout(() => { process.exit(0) }, RESTART_EXIT_DELAY_MS)
  return { ok: true }
}
