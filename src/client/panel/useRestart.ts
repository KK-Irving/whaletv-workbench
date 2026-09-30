/**
 * Restart domain (v0.8.16 split): the per-open plan probe, the confirm flow
 * and the "wait for the harness to come back" loop. Whether the host may
 * restart itself at all is decided by the Host (see
 * docs/adr/0003-restart-is-manual-on-desktop.md) — this hook only relays.
 */
import { useCallback, useEffect, useState } from 'react'
import type { WorkbenchRestartPlan, WorkbenchState } from '../../shared.ts'
import { HOST_SKEW_HINT } from './notices.ts'
import type { WorkbenchPanelProps } from '../contract.ts'

type Actions = WorkbenchPanelProps['actions']

export interface UseRestartOptions {
  actions: Actions
  /** Store state snapshot — carries `capabilities` for the skew check. */
  state: WorkbenchState | null
  restartPlan: WorkbenchPanelProps['restartPlan']
  restart: WorkbenchPanelProps['restart']
  loadState: WorkbenchPanelProps['loadState']
  askConfirm: (request: { title: string; description: string; confirmLabel: string; cancelLabel: string | null; danger?: boolean; onConfirm: () => void }) => void
}

export function useRestart(options: UseRestartOptions): {
  restartInfo: WorkbenchRestartPlan | null
  restarting: boolean
  runRestart: () => Promise<void>
} {
  const { actions, state, restartPlan, restart, loadState, askConfirm } = options

  /** True from "restart accepted" until the host answers again (③). */
  const [restarting, setRestarting] = useState(false)
  /**
   * What this host can do about restarting (③). Fetched once per panel open:
   * the desktop app cannot restart itself from a plugin, and the UI must not
   * offer a button that only ends in an apology.
   */
  const [restartInfo, setRestartInfo] = useState<WorkbenchRestartPlan | null>(null)

  // Ask the Host once per open what it can do about restarting (③). A failure
  // (older host without the route) leaves the info null and the UI simply does
  // not offer the button — the click path still explains the skew.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const plan = await restartPlan()
        if (!cancelled) setRestartInfo(plan)
      } catch {
        if (!cancelled) setRestartInfo(null)
      }
    })()
    return () => { cancelled = true }
  }, [restartPlan])

  /**
   * Apply the restart (the confirmation dialog's onConfirm): ask the Host to
   * relaunch, then wait for it to serve again and reload onto the new process.
   */
  const performRestart = useCallback(async (): Promise<void> => {
    setRestarting(true)
    try {
      await restart()
    } catch (error) {
      setRestarting(false)
      actions.setLoadError(error instanceof Error ? error.message : String(error))
      return
    }
    // The host answers before it exits, so the first polls still hit the old
    // process. Keep polling until a request succeeds again.
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      try {
        await loadState()
        window.location.reload()
        return
      } catch {
        // Still down — the helper is still bringing it back.
      }
    }
    setRestarting(false)
    actions.setLoadError('重启后 90 秒内未重新连上服务端——请检查 dsh 是否已启动（托盘菜单或终端）。')
  }, [restart, loadState, actions])

  const runRestart = useCallback(async (): Promise<void> => {
    const explainSkew = (): void => {
      askConfirm({
        title: '需要先重启一次 dsh',
        description: HOST_SKEW_HINT,
        confirmLabel: '知道了',
        cancelLabel: null,
        onConfirm: () => { /* informational only */ },
      })
    }
    // A host that reports capabilities without `restart` predates the route.
    if (state?.capabilities !== undefined && !state.capabilities.includes('restart')) {
      explainSkew()
      return
    }
    let plan: WorkbenchRestartPlan
    try {
      plan = await restartPlan()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Older hosts (no capabilities field) answer the miss with this text.
      if (message.includes('未知的工作台路由')) {
        explainSkew()
        return
      }
      actions.setLoadError(message)
      return
    }
    if (!plan.relaunchable) {
      // The plan carries no command for these hosts on purpose: the desktop
      // child's own command line is only valid with the shell-injected env,
      // and running it by hand is what turned advice into a crash loop.
      askConfirm({
        title: '需要手动重启',
        description: `${plan.note ?? '当前形态不支持面板内重启。'}${plan.externalAction !== undefined ? `（入口：${plan.externalAction}）` : ''}`,
        confirmLabel: '知道了',
        cancelLabel: null,
        onConfirm: () => { /* informational only */ },
      })
      return
    }
    askConfirm({
      title: '重启 dsh',
      description: `${plan.note ?? '将结束当前 harness 进程并重新拉起：页面断开约 10–20 秒，恢复后自动刷新。'}进行中的会话会被中断（记录已落盘，重启后可继续）。`,
      confirmLabel: '重启',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performRestart() },
    })
  }, [state, restartPlan, askConfirm, performRestart, actions])

  return { restartInfo, restarting, runRestart }
}
