/**
 * Harness restart support (roadmap ③ update loop).
 *
 * Host code only loads when the dsh process starts (the client bundle is what
 * hot-injects), so an update needs a restart to take effect. Whether this
 * module may perform that restart depends entirely on how the harness is
 * hosted — see docs/adr/0003-restart-is-manual-on-desktop.md for the full
 * evidence:
 *
 * - Plain Node CLI host (`dsh web`): a detached helper (written into the
 *   plugin's own state directory, so tarball installs that ship only `lib/`
 *   have it too) waits for this process to exit, gives a supervising launcher
 *   a few seconds to bring the harness back, then starts the replacement
 *   itself with the captured command.
 * - Desktop app (Electron): NOT restarted from here — and deliberately without
 *   a copyable command either. The harness is an IPC child of the Electron
 *   shell, whose protocol carries no restart; an unsolicited exit is reported
 *   as a crash, and the child's raw command line only works with the
 *   shell-injected ELECTRON_RUN_AS_NODE, so running it by hand starts a second
 *   app instance (port conflict + single-instance lock). The panel names the
 *   real entry point instead.
 * - Service-managed hosts (systemd's `INVOCATION_ID`): NOT restarted from here
 *   either — exiting kills the unit's cgroup along with any replacement.
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

/** Whether this host is service-managed (where killing ourselves kills the unit too). */
function serviceManaged(): boolean {
  return process.env.INVOCATION_ID !== undefined && process.env.INVOCATION_ID !== ''
}

/**
 * Derive the restart plan for this process.
 *
 * The desktop case is why this function is written defensively. The harness
 * runs as an IPC child of the Electron shell (`spawn(node, [hostEntry…],
 * {stdio: […, 'ipc']})`), and that protocol carries only `shutdown`,
 * `quit-inspection` and `update-tasks` — there is NO restart message, and the
 * shell treats any unsolicited child exit as a crash ("dsh desktop host
 * stopped"). Worse, the child's own command line (`Harness.exe <hostEntry>`)
 * only makes sense WITH the `ELECTRON_RUN_AS_NODE=1` the shell injects:
 * running it by hand starts a second app instance that fails to bind the port
 * (EADDRINUSE) and trips the single-instance lock — that is what turned the
 * old "copy this command" advice into a crash loop.
 *
 * So the desktop reports `manual` and hands over no command at all, while a
 * plain Node CLI host keeps the detached-helper relaunch.
 *
 * @returns the plan the UI shows, including which strategy would run.
 */
export function buildRestartPlan(): WorkbenchRestartPlan {
  const entry = process.argv[1]
  const command = [process.execPath, ...process.argv.slice(1)].map(quote).join(' ')
  // 1. Electron desktop host: the shell owns the process tree and exposes no
  //    restart to its child; a hand-run command would break the running app.
  if (process.versions.electron !== undefined) {
    return {
      ok: true, relaunchable: false, strategy: 'manual', command: '',
      externalAction: '托盘/菜单 →「Restart App and Host」',
      note: '桌面端不支持面板内重启：harness 作为桌面应用的子进程运行，应用没有向插件开放重启接口（直接结束子进程会被判定为崩溃）。请用应用自带的重启入口：托盘菜单 →「Restart App and Host」（重启 App 和 Host）。',
    }
  }
  // 2. Service-managed host: a replacement would fight the supervisor's cgroup.
  if (serviceManaged()) {
    return {
      ok: true, relaunchable: false, strategy: 'manual', command: '',
      externalAction: '服务管理器（systemctl restart …）',
      note: '当前 harness 由 systemd 托管：从这里退出会连同 unit 的 cgroup 一起被杀，替代进程也起不来，请用服务管理器重启。',
    }
  }
  // 3. Plain Node CLI host: relaunch the exact command through the helper.
  const entryLooksRunnable = typeof entry === 'string' && /\.(mjs|cjs|js)$/i.test(entry) && existsSync(entry)
  if (!entryLooksRunnable) {
    return {
      ok: true, relaunchable: false, strategy: 'manual', command: '',
      note: '无法确定 harness 的启动入口（argv[1] 不是可执行脚本），无法安全地自动重启，请手动重启 dsh。',
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
 * Schedule the restart: respond first, then hand off to the detached helper.
 * Uses a native timer on purpose — `ctx.effect`-scoped timers are bound to the
 * plugin fiber, and this callback runs outside any fiber.
 *
 * @returns ok, or an error when the helper could not be armed.
 */
export function requestRestart(plan: WorkbenchRestartPlan): { ok: boolean; error?: string } {
  if (!plan.relaunchable) return { ok: false, error: plan.note ?? '当前形态不支持面板内重启' }
  const started = spawnRestartHelper()
  if (!started.ok) return started
  // Native setTimeout: the HTTP response is already on the wire by then.
  setTimeout(() => { process.exit(0) }, RESTART_EXIT_DELAY_MS)
  return { ok: true }
}
