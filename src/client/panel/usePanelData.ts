/**
 * Panel data loading (v0.8.16 split): the reload family the header, effects
 * and every other hook share, plus the 最近使用 ledger and the reachability
 * probe snapshot with its auto-clear window.
 */
import { useCallback, useEffect, useState } from 'react'
import type { WorkbenchHealthEntry, WorkbenchUsageRecord } from '../../shared.ts'
import { NOTICE_AUTO_DISMISS_MS } from './notices.ts'
import type { WorkbenchPanelProps } from '../contract.ts'

type Actions = WorkbenchPanelProps['actions']

/** Hook inputs: the store actions plus the injected loaders this domain needs. */
export interface UsePanelDataOptions {
  actions: Actions
  loadState: WorkbenchPanelProps['loadState']
  loadSkills: WorkbenchPanelProps['loadSkills']
  loadUpdateHistory: WorkbenchPanelProps['loadUpdateHistory']
  loadUsage: WorkbenchPanelProps['loadUsage']
  checkHealth: WorkbenchPanelProps['checkHealth']
}

export function usePanelData(options: UsePanelDataOptions): {
  reload: () => Promise<void>
  reloadSkills: () => Promise<void>
  reloadHistory: () => Promise<void>
  reloadUsage: () => Promise<void>
  usage: Record<string, WorkbenchUsageRecord>
  health: Record<string, WorkbenchHealthEntry> | null
  healthBusy: boolean
  runHealth: () => Promise<void>
} {
  const { actions, loadState, loadSkills, loadUpdateHistory, loadUsage, checkHealth } = options
  /** 最近使用 ledger (P2-12); refreshed on open and after every launch. */
  const [usage, setUsage] = useState<Record<string, WorkbenchUsageRecord>>({})
  /** Last health-run results (P2-16); lives until the next run / remount. */
  const [health, setHealth] = useState<Record<string, WorkbenchHealthEntry> | null>(null)
  const [healthBusy, setHealthBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const next = await loadState()
      actions.setState(next)
      actions.setLoadError(null)
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [actions, loadState])

  /**
   * Re-read the skills catalog through the Host's `/skills` route. Errors
   * live inside the returned skill catalog (never thrown), so the
   * panel decides whether to badge them without a separate try/catch.
   * The full payload is logged to the browser console so users hitting
   * "why is the section empty?" can diagnose without opening a devtool
   * network waterfall — one console line surfaces both `complete` and the
   * skill count directly.
   */
  const reloadSkills = useCallback(async () => {
    actions.setSkillsLoading(true)
    try {
      const next = await loadSkills()
      // eslint-disable-next-line no-console -- deliberate diagnostic surface for users
      console.info('[whaletv-workbench] /skills →', next)
      actions.setSkills(next)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // eslint-disable-next-line no-console
      console.warn('[whaletv-workbench] /skills failed:', message)
      actions.setSkills({
        ok: false, skills: [], complete: false, error: message,
      })
    } finally {
      actions.setSkillsLoading(false)
    }
  }, [actions, loadSkills])

  /** Read the rolling update history for the footer rollback affordance (P1-9). */
  const reloadHistory = useCallback(async () => {
    try {
      const history = await loadUpdateHistory()
      actions.setUpdateHistory(history.entries)
    } catch {
      // History is an affordance, not a requirement — keep whatever we had.
    }
  }, [actions, loadUpdateHistory])

  /**
   * Refresh the 最近使用 ledger (roadmap P2-12). Declared before the effects
   * that call it: an arrow-function const read from an earlier effect only
   * ever sees its first-render closure (react-hooks flags this as
   * "accessed before it is declared").
   */
  const reloadUsage = useCallback(async (): Promise<void> => {
    try {
      setUsage((await loadUsage()).usage)
    } catch {
      // Rail-only data — a failed read just leaves the rail stale.
    }
  }, [loadUsage])

  /** Probe every entry's reachability and badge the cards (roadmap P2-16). */
  const runHealth = useCallback(async (): Promise<void> => {
    setHealthBusy(true)
    try {
      setHealth((await checkHealth()).results)
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setHealthBusy(false)
    }
  }, [actions, checkHealth])

  // Reachability badges are a snapshot of one probe run, not permanent state:
  // they clear on the same window so a stale ✓/✗ never lingers on the cards
  // (including the "✓ n / m 可达" line in the edit bar). A running probe is
  // never cut short — the countdown starts when its results land.
  useEffect(() => {
    if (health === null || healthBusy) return
    const timer = window.setTimeout(() => { setHealth(null) }, NOTICE_AUTO_DISMISS_MS)
    return () => { window.clearTimeout(timer) }
  }, [health, healthBusy])

  return { reload, reloadSkills, reloadHistory, reloadUsage, usage, health, healthBusy, runHealth }
}
