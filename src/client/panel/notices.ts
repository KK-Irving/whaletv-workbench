/**
 * Panel notice + rebuild-survival constants and helpers (v0.8.16 split).
 * Pure module: no React imports, so both components and hooks can share it.
 */
import type { WorkbenchUpdateCheckResult } from '../../shared.ts'

/**
 * sessionStorage key set right before a self-update / rollback rebuild.
 *
 * `ctx.clientModules.rebuilt()` disposes this client half and mounts the
 * fresh bundle, which rebuilds the module-scope store with `open: false` —
 * so a successful in-panel update looked like the panel "crashing" and
 * vanishing. The fresh mount consumes a still-fresh flag, reopens the panel
 * and resurfaces the outcome.
 */
const REOPEN_AFTER_REBUILD_KEY = 'whaletv-workbench.reopen-after-rebuild'

/** A rebuild + remount lands within seconds; anything older is stale. */
const REOPEN_FLAG_TTL_MS = 90_000

/** How long an informational notice stays before it closes itself. */
export const NOTICE_AUTO_DISMISS_MS = 10_000

/**
 * Shown when the running Host half predates what the panel is offering.
 *
 * The client bundle hot-injects after an update; the Host half only loads when
 * the dsh process starts. So right after updating, the panel can be newer than
 * the server it talks to — the restart route simply is not there yet, and the
 * old code answered "未知的工作台路由" instead.
 */
export const HOST_SKEW_HINT = '工作台的服务端是 dsh 启动时加载的旧版本（客户端已更新，服务端还没有）。请先用托盘菜单「重启 Web 服务」重启一次 dsh；之后这里就能面板内重启了。'

/**
 * Whether a completed update check found something the user has not acted on.
 * Only this state (and check errors) outlives the auto-dismiss window: an
 * update banner must not disappear before it can be clicked.
 */
export function updateAvailable(result: WorkbenchUpdateCheckResult | null): boolean {
  if (result === null || result.ok !== true) return false
  // Tarball installs compare published versions; git checkouts compare refs.
  return result.tarball === true ? result.upToDate === false : (result.behind ?? 0) > 0
}

export function markReopenAfterRebuild(): void {
  try {
    sessionStorage.setItem(REOPEN_AFTER_REBUILD_KEY, String(Date.now()))
  } catch {
    // Storage unavailable (hardened browser context): the update still works,
    // the panel just stays closed.
  }
}

/** Consume the flag: true only when it exists AND is still fresh. */
export function takeReopenAfterRebuild(): boolean {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(REOPEN_AFTER_REBUILD_KEY)
    if (raw !== null) sessionStorage.removeItem(REOPEN_AFTER_REBUILD_KEY)
  } catch {
    return false
  }
  if (raw === null) return false
  const at = Number.parseInt(raw, 10)
  return Number.isFinite(at) && Date.now() - at <= REOPEN_FLAG_TTL_MS
}
