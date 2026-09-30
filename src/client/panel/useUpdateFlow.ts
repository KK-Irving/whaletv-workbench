/**
 * The update flow (v0.8.16 split): 检查更新 / 更新 / 跳过 / 回滚, the live
 * progress poll (③) and the notice auto-dismiss windows. Owns the pipeline
 * stage snapshot; the component derives what to render from it.
 */
import { useCallback, useEffect, useState } from 'react'
import type { WorkbenchUpdateCheckResult, WorkbenchUpdateProgress, WorkbenchUpdateHistoryEntry } from '../../shared.ts'
import { markReopenAfterRebuild, NOTICE_AUTO_DISMISS_MS, updateAvailable } from './notices.ts'
import type { WorkbenchPanelProps } from '../contract.ts'

type Actions = WorkbenchPanelProps['actions']

export interface UseUpdateFlowOptions {
  actions: Actions
  /** Store reads the effects and notices need. */
  updating: boolean
  checkResult: WorkbenchUpdateCheckResult | null
  lastResult: string | null
  updateHistory: WorkbenchUpdateHistoryEntry[] | null
  /** Injected Host actions. */
  update: WorkbenchPanelProps['update']
  checkUpdate: WorkbenchPanelProps['checkUpdate']
  skipUpdate: WorkbenchPanelProps['skipUpdate']
  rollbackUpdate: WorkbenchPanelProps['rollbackUpdate']
  loadProgress: WorkbenchPanelProps['loadProgress']
  /** Shared reload family from usePanelData. */
  reload: () => Promise<void>
  reloadHistory: () => Promise<void>
  /** The panel's confirmation dialog. */
  askConfirm: (request: { title: string; description: string; confirmLabel: string; cancelLabel: string | null; danger?: boolean; onConfirm: () => void }) => void
}

export function useUpdateFlow(options: UseUpdateFlowOptions): {
  runUpdate: () => Promise<void>
  runCheck: () => Promise<void>
  runSkip: (sha: string) => Promise<void>
  runRollback: () => void
  progress: WorkbenchUpdateProgress | null
  dismissResult: () => void
} {
  const {
    actions, updating, checkResult, lastResult, updateHistory,
    update, checkUpdate, skipUpdate, rollbackUpdate, loadProgress,
    reload, reloadHistory, askConfirm,
  } = options

  /** Live stage of the running update pipeline (③), polled while updating. */
  const [progress, setProgress] = useState<WorkbenchUpdateProgress | null>(null)

  /** Manual close of the update result footer (✕). */
  const dismissResult = useCallback(() => {
    actions.setLastResult(null)
    actions.setUpdateLog('')
  }, [actions])

  // Informational notices close themselves after NOTICE_AUTO_DISMISS_MS. The
  // one exception is an update the user has not acted on yet: that banner
  // stays until it is explicitly closed (or the update is applied).
  useEffect(() => {
    if (lastResult === null) return
    if (updateAvailable(checkResult)) return
    const timer = window.setTimeout(() => {
      actions.setLastResult(null)
      actions.setUpdateLog('')
    }, NOTICE_AUTO_DISMISS_MS)
    return () => { window.clearTimeout(timer) }
  }, [lastResult, checkResult, actions])

  useEffect(() => {
    if (checkResult === null) return
    // Errors keep the retry affordance; an available update waits for a click.
    if (checkResult.ok !== true || updateAvailable(checkResult)) return
    const timer = window.setTimeout(() => { actions.setCheckResult(null) }, NOTICE_AUTO_DISMISS_MS)
    return () => { window.clearTimeout(timer) }
  }, [checkResult, actions])

  // Update progress (③): while a pipeline runs, poll the Host's stage line so
  // the panel shows "正在安装依赖…" instead of a frozen button. The interval
  // clears itself as soon as the update settles; the last polled snapshot is
  // simply not rendered once `updating` goes false (derived in the component).
  useEffect(() => {
    if (!updating) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const next = await loadProgress()
        if (!cancelled) setProgress(next)
      } catch {
        // The host is busy spawning child processes; a missed poll is fine.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [updating, loadProgress])

  const runUpdate = useCallback(async () => {
    actions.setUpdating(true)
    actions.setUpdateLog('')
    actions.setLastResult(null)
    // A successful pull rebuilds + hot-injects: this component instance is
    // about to be unmounted, so mark the panel for reopen by the fresh mount.
    markReopenAfterRebuild()
    try {
      const result = await update()
      if (result.changed === true) {
        actions.setUpdateLog(result.output ?? '')
        // needRestart is host-diff-precise (see Host runUpdate): only a
        // src/index.ts / tsdown.config.ts / package.json change asks for a
        // restart; client-only pulls hot-inject and refresh on their own.
        actions.setLastResult(
          result.tarball === true
            ? '新版本已安装（pnpm add）；重启 dsh 后生效。'
            : result.needRestart === true
              ? '更新完成。本次包含服务端改动，请重启 dsh web 后生效。'
              : '更新完成并已热注入，工作台会自动重载。',
        )
        actions.setCheckResult(null)
        void reload()
        void reloadHistory()
      } else {
        // No new commits — no log to read; the notice auto-dismisses.
        actions.setUpdateLog('')
        actions.setLastResult('已是最新版本，无需更新。')
      }
    } catch (error) {
      actions.setUpdateLog(error instanceof Error ? error.message : String(error))
      actions.setLastResult('更新失败，详见下方日志。')
    } finally {
      actions.setUpdating(false)
    }
  }, [actions, update, reload, reloadHistory])

  /**
   * "检查更新" flow (roadmap P1-8): fetch + ahead/behind + commit list on
   * the Host, no working-tree changes. The result drives the banner; the
   * header git badge reads the same store field.
   */
  const runCheck = useCallback(async () => {
    actions.setChecking(true)
    try {
      const result = await checkUpdate()
      actions.setCheckResult(result)
    } catch (error) {
      actions.setCheckResult({
        ok: false, upToDate: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      actions.setChecking(false)
    }
  }, [actions, checkUpdate])

  /** Mark the remote head skipped, then re-check so the banner reflects it (P1-10). */
  const runSkip = useCallback(async (sha: string) => {
    try {
      await skipUpdate(sha)
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
      return
    }
    await runCheck()
  }, [actions, skipUpdate, runCheck])

  /** Apply the rollback (the confirmation dialog's onConfirm). */
  const performRollback = useCallback(async () => {
    actions.setUpdating(true)
    actions.setUpdateLog('')
    actions.setLastResult(null)
    // Rollback also rebuilds + hot-injects; same remount as runUpdate.
    markReopenAfterRebuild()
    try {
      const result = await rollbackUpdate()
      if (result.ok) {
        actions.setUpdateLog(result.output ?? '')
        actions.setLastResult(`已回滚到 ${result.revertedTo ?? '上一版本'}。服务端已还原，请重启 dsh web 生效。`)
      } else {
        actions.setUpdateLog(result.error ?? '')
        actions.setLastResult('回滚失败，详见下方日志。')
      }
      actions.setCheckResult(null)
      void reload()
      void reloadHistory()
    } catch (error) {
      actions.setUpdateLog(error instanceof Error ? error.message : String(error))
      actions.setLastResult('回滚失败，详见下方日志。')
    } finally {
      actions.setUpdating(false)
    }
  }, [actions, rollbackUpdate, reload, reloadHistory])

  /** Reset to the state before the last successful update (P1-9). */
  const runRollback = useCallback(() => {
    const previous = updateHistory?.find(entry => entry.ok === true && entry.changed === true)
    if (previous === undefined) return
    askConfirm({
      title: '回滚到更新前',
      description: `将把工作区重置到 ${previous.before ?? '?'}。工作区有未提交修改时回滚会被拒绝。`,
      confirmLabel: '回滚',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performRollback() },
    })
  }, [updateHistory, askConfirm, performRollback])

  return { runUpdate, runCheck, runSkip, runRollback, progress, dismissResult }
}
