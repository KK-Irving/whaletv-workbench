/**
 * The WhaleTV workbench dashboard, registered into `shell.overlay`: a centered
 * panel over a click-to-close backdrop with grouped entry cards (web / docs /
 * apps / skills), search, in-panel config editing (edit mode), and the
 * one-click self-update flow.
 *
 * Pure presentation: everything arrives through the four props shares
 * (owner → runtime, store → useStore/actions, inject → Host actions); no
 * cordis imports, no React context. Edit-mode form drafts live in local
 * component state; every mutation is persisted immediately through the Host
 * saveConfig route, then re-read via loadState.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, MouseEvent } from 'react'
import { Button, Input, Modal, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { WorkbenchPanelProps } from './contract.ts'
import type {
  WorkbenchConfig, WorkbenchGroup, WorkbenchHealthEntry, WorkbenchItem, WorkbenchRestartPlan,
  WorkbenchUpdateCheckResult, WorkbenchUpdateProgress, WorkbenchUsageRecord,
} from '../shared.ts'
import { WORKBENCH_ICON } from './icon.ts'
import css from './WorkbenchPanel.module.css'
import { SkillsSection } from './SkillsSection.tsx'

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
const NOTICE_AUTO_DISMISS_MS = 10_000

/**
 * Shown when the running Host half predates what the panel is offering.
 *
 * The client bundle hot-injects after an update; the Host half only loads when
 * the dsh process starts. So right after updating, the panel can be newer than
 * the server it talks to — the restart route simply is not there yet, and the
 * old code answered "未知的工作台路由" instead.
 */
const HOST_SKEW_HINT = '工作台的服务端是 dsh 启动时加载的旧版本（客户端已更新，服务端还没有）。请先用托盘菜单「重启 Web 服务」重启一次 dsh；之后这里就能面板内重启了。'

/**
 * Whether a completed update check found something the user has not acted on.
 * Only this state (and check errors) outlives the auto-dismiss window: an
 * update banner must not disappear before it can be clicked.
 */
function updateAvailable(result: WorkbenchUpdateCheckResult | null): boolean {
  if (result === null || result.ok !== true) return false
  // Tarball installs compare published versions; git checkouts compare refs.
  return result.tarball === true ? result.upToDate === false : (result.behind ?? 0) > 0
}

function markReopenAfterRebuild(): void {
  try {
    sessionStorage.setItem(REOPEN_AFTER_REBUILD_KEY, String(Date.now()))
  } catch {
    // Storage unavailable (hardened browser context): the update still works,
    // the panel just stays closed.
  }
}

/** Consume the flag: true only when it exists AND is still fresh. */
function takeReopenAfterRebuild(): boolean {
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

/** The one configured target of an entry, or null when nothing is set. */
type EntryTarget =
  | { kind: 'url'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'prompt'; value: string }

/**
 * Resolve an entry's action target — THE single source of truth for the
 * url/path/prompt precedence. The old code derived "configured" from a
 * comparison against the Chinese button label, so a copy tweak silently
 * changed behaviour.
 */
function entryTarget(item: WorkbenchItem): EntryTarget | null {
  if (item.url !== undefined && item.url !== '') return { kind: 'url', value: item.url }
  if (item.path !== undefined && item.path !== '') return { kind: 'path', value: item.path }
  if (item.prompt !== undefined && item.prompt !== '') return { kind: 'prompt', value: item.prompt }
  return null
}

/** Fixed label per target kind — each rendered button names its own action. */
const TARGET_LABEL: Record<EntryTarget['kind'], string> = {
  url: '打开网页',
  path: '打开',
  prompt: '在会话中使用',
}

/** Whether an entry has any configured target. */
function isConfigured(item: WorkbenchItem): boolean {
  return entryTarget(item) !== null
}

/** Entry target kinds the edit form offers. */
type TargetKind = 'url' | 'path' | 'prompt'

/** Editable field draft for one entry (new or existing). */
interface ItemFormDraft {
  title: string
  description: string
  kind: TargetKind
  value: string
}

/** Which entry is currently in form editing (null = none). */
interface ItemEditing {
  groupId: string
  itemId: string | null
  draft: ItemFormDraft
}

/** Monotonic per-page id source for new entries/groups. */
let idCounter = 0
function genId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`
}

function emptyDraft(): ItemFormDraft {
  return { title: '', description: '', kind: 'url', value: '' }
}

function draftFromItem(item: WorkbenchItem): ItemFormDraft {
  const kind: TargetKind = item.url !== undefined ? 'url' : item.path !== undefined ? 'path' : item.prompt !== undefined ? 'prompt' : 'url'
  return {
    title: item.title,
    description: item.description ?? '',
    kind,
    value: item.url ?? item.path ?? item.prompt ?? '',
  }
}

/** Build a config item from the form draft; blank optional fields are dropped. */
function itemFromDraft(id: string, draft: ItemFormDraft): WorkbenchItem {
  const item: WorkbenchItem = { id, title: draft.title.trim() }
  const description = draft.description.trim()
  const value = draft.value.trim()
  if (description !== '') item.description = description
  if (value !== '') {
    if (draft.kind === 'url') item.url = value
    else if (draft.kind === 'path') item.path = value
    else item.prompt = value
  }
  return item
}

/** Placeholder for the target value input, per kind. */
function kindPlaceholder(kind: TargetKind): string {
  if (kind === 'url') return 'https://…'
  if (kind === 'path') return 'C:\\path\\to\\app.exe'
  return '提示词文本…'
}

/** Per-origin favicon proxy URL for a web entry ('' when the URL is unusable). */
function iconSrcFor(url: string): string {
  try {
    return `/whaletv/workbench/icon?url=${encodeURIComponent(new URL(url).origin)}`
  } catch {
    return ''
  }
}

/**
 * Move one item across/within groups (roadmap P2-15): remove it from its
 * group and insert it before `beforeItemId` (or appended when null).
 * @returns the new config, or null when the source item vanished.
 */
function moveItem(
  config: WorkbenchConfig,
  from: { groupId: string; itemId: string },
  toGroupId: string,
  beforeItemId: string | null,
): WorkbenchConfig | null {
  let moved: WorkbenchItem | undefined
  const stripped = config.groups.map(group => {
    if (group.id !== from.groupId) return group
    const item = group.items.find(candidate => candidate.id === from.itemId)
    if (item === undefined) return group
    moved = item
    return { ...group, items: group.items.filter(candidate => candidate.id !== from.itemId) }
  })
  if (moved === undefined) return null
  // Definite alias: TS cannot narrow `moved` through the closure above.
  const movedItem: WorkbenchItem = moved
  const groups = stripped.map(group => {
    if (group.id !== toGroupId) return group
    if (beforeItemId === null || beforeItemId === from.itemId) {
      return { ...group, items: [...group.items, movedItem] }
    }
    const index = group.items.findIndex(candidate => candidate.id === beforeItemId)
    if (index < 0) return { ...group, items: [...group.items, movedItem] }
    const items = [...group.items]
    items.splice(index, 0, movedItem)
    return { ...group, items }
  })
  return { groups }
}

/**
 * Move one item by `delta` slots inside its own group — the keyboard-reachable
 * counterpart of drag-and-drop (drag is pointer-only). Returns null when the
 * move would fall off either end.
 */
function moveWithinGroup(
  config: WorkbenchConfig, groupId: string, itemId: string, delta: number,
): WorkbenchConfig | null {
  const group = config.groups.find(candidate => candidate.id === groupId)
  if (group === undefined) return null
  const index = group.items.findIndex(candidate => candidate.id === itemId)
  const target = index + delta
  if (index < 0 || target < 0 || target >= group.items.length) return null
  const items = [...group.items]
  const [moved] = items.splice(index, 1)
  if (moved === undefined) return null
  items.splice(target, 0, moved)
  return { groups: config.groups.map(candidate => (candidate.id === groupId ? { ...candidate, items } : candidate)) }
}

/** Inline entry form (used for both new and existing entries). */
function ItemForm(props: {
  draft: ItemFormDraft
  saving: boolean
  onChange: (patch: Partial<ItemFormDraft>) => void
  onSave: () => void
  onCancel: () => void
}) {
  const { draft, saving, onChange, onSave, onCancel } = props
  return (
    <div className={css.form}>
      <Input
        placeholder="名称（必填）"
        value={draft.title}
        onChange={event => { onChange({ title: event.target.value }) }}
      />
      <Input
        placeholder="描述（可选）"
        value={draft.description}
        onChange={event => { onChange({ description: event.target.value }) }}
      />
      <div className={css.formRow}>
        <select
          className={css.kindSelect}
          value={draft.kind}
          onChange={event => { onChange({ kind: event.target.value as TargetKind }) }}
          aria-label="目标类型"
        >
          <option value="url">网页 URL</option>
          <option value="path">本机路径</option>
          <option value="prompt">技能提示词</option>
        </select>
        <Input
          placeholder={kindPlaceholder(draft.kind)}
          value={draft.value}
          onChange={event => { onChange({ value: event.target.value }) }}
        />
      </div>
      <div className={css.formActions}>
        <Button size="sm" variant="primary" onClick={onSave} disabled={saving}>保存</Button>
        <Button size="sm" onClick={onCancel} disabled={saving}>取消</Button>
      </div>
    </div>
  )
}

/**
 * One entry card: title, description, and its kind-specific actions (or the
 * inline form in edit mode). Edit mode additionally enables drag-reorder
 * (roadmap P2-15); a favicon shows for web entries (P2-17) and a reachability
 * badge after a health run (P2-16).
 */
function ItemCard(props: {
  item: WorkbenchItem
  editMode: boolean
  editing: boolean
  draft: ItemFormDraft
  saving: boolean
  /** Search keyboard-navigation cursor (P2-14). */
  highlight?: boolean
  /** Last health-probe outcome for this item, when a run happened (P2-16). */
  health?: WorkbenchHealthEntry
  onDraftChange: (patch: Partial<ItemFormDraft>) => void
  onSaveDraft: () => void
  onCancelDraft: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenUrl: (url: string) => void
  onOpenPath: (path: string) => void
  onUseSkill: (prompt: string) => void
  onCopy: (prompt: string) => void
  onDragStartItem?: () => void
  onDragEnterItem?: () => void
  onDropOnItem?: () => void
  onDragEndItem?: () => void
  /** Keyboard-reachable reorder (drag is pointer-only). */
  onMoveBy?: (delta: number) => void
  canMoveUp?: boolean
  canMoveDown?: boolean
  /** This card is the one being dragged right now. */
  dragging?: boolean
  /** A drag is hovering this card (drop inserts before it). */
  dropTarget?: boolean
}) {
  const {
    item, editMode, editing, draft, saving, highlight, health,
    onDraftChange, onSaveDraft, onCancelDraft, onEdit, onDelete,
    onOpenUrl, onOpenPath, onUseSkill, onCopy,
    onDragStartItem, onDragEnterItem, onDropOnItem, onDragEndItem,
    onMoveBy, canMoveUp, canMoveDown, dragging, dropTarget,
  } = props
  const url = item.url ?? ''
  const path = item.path ?? ''
  const prompt = item.prompt ?? ''
  const configured = isConfigured(item)
  const iconSrc = url !== '' ? iconSrcFor(url) : ''

  const head = (
    <div className={css.itemHead}>
      {iconSrc !== '' && (
        <img
          src={iconSrc}
          alt=""
          className={css.itemIcon}
          onError={event => { event.currentTarget.style.display = 'none' }}
        />
      )}
      <span className={css.itemTitle}>{item.title}</span>
      {!configured && <span className={css.badge}>待配置</span>}
      {health !== undefined && (
        <span
          className={clsx(css.healthDot, health.ok ? css.healthOk : css.healthBad)}
          title={health.detail ?? (health.ok ? '可达' : '不可达')}
        >
          {health.ok ? '✓' : '✗'}
        </span>
      )}
    </div>
  )
  const dragHandlers = editMode && !editing
    ? {
        draggable: true,
        onDragStart: () => { onDragStartItem?.() },
        onDragOver: (event: DragEvent<HTMLDivElement>) => { event.preventDefault() },
        onDragEnter: () => { onDragEnterItem?.() },
        onDrop: () => { onDropOnItem?.() },
        // dragend fires even when the drop landed outside every target — the
        // parent's drag state stayed dirty (stuck ghost highlight) without it.
        onDragEnd: () => { onDragEndItem?.() },
      }
    : {}
  if (editing) {
    return (
      <div className={clsx(css.item, css.itemEditing)} data-wb-item={item.id}>
        {head}
        <ItemForm draft={draft} saving={saving} onChange={onDraftChange} onSave={onSaveDraft} onCancel={onCancelDraft} />
      </div>
    )
  }
  return (
    <div
      {...dragHandlers}
      className={clsx(
        css.item,
        highlight === true && css.itemActive,
        dragging === true && css.itemDragging,
        dropTarget === true && css.itemDropTarget,
      )}
      data-wb-item={item.id}
    >
      {head}
      {item.description !== undefined && item.description !== ''
        && <p className={css.itemDesc}>{item.description}</p>}
      {editMode ? (
        <div className={css.itemActions}>
          <Button size="sm" variant="outline" onClick={() => { onMoveBy?.(-1) }} disabled={saving || canMoveUp !== true} aria-label="上移">↑</Button>
          <Button size="sm" variant="outline" onClick={() => { onMoveBy?.(1) }} disabled={saving || canMoveDown !== true} aria-label="下移">↓</Button>
          <Button size="sm" variant="outline" onClick={onEdit} disabled={saving}>编辑</Button>
          <Button size="sm" variant="outline" className={css.danger} onClick={onDelete} disabled={saving}>删除</Button>
        </div>
      ) : (
        <div className={css.itemActions}>
          {url !== '' && (
            <Button size="sm" variant="outline" onClick={() => { onOpenUrl(url) }}>{TARGET_LABEL.url}</Button>
          )}
          {path !== '' && (
            <Button size="sm" variant="outline" onClick={() => { onOpenPath(path) }}>{TARGET_LABEL.path}</Button>
          )}
          {prompt !== '' && (
            <>
              <Button size="sm" variant="outline" onClick={() => { onUseSkill(prompt) }}>{TARGET_LABEL.prompt}</Button>
              <Button size="sm" onClick={() => { onCopy(prompt) }}>复制提示词</Button>
            </>
          )}
          {!configured && <Button size="sm" disabled>未配置</Button>}
        </div>
      )}
    </div>
  )
}

/** 最近使用 rail (roadmap P2-12): top launched entries as clickable chips. */
function RecentBar(props: {
  entries: Array<{ id: string; title: string; count: number; lastUsed: string }>
  onRun: (id: string) => void
}) {
  const { entries, onRun } = props
  if (entries.length === 0) return null
  return (
    <section className={css.recentBar} aria-label="最近使用">
      <h2 className={css.groupTitle}>最近使用</h2>
      <div className={css.recentChips}>
        {entries.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={css.recentChip}
            title={`${entry.title} · 已用 ${entry.count} 次`}
            onClick={() => { onRun(entry.id) }}
          >
            {entry.title}
            <span className={css.recentCount}>{entry.count}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * "检查更新" result banner (roadmap P1-8 / P1-10): the incoming commit list
 * plus apply / skip / dismiss actions. Rendered between the header and the
 * search row while a check result is on screen.
 */
function UpdateCheckBanner(props: {
  result: WorkbenchUpdateCheckResult
  disabled: boolean
  onUpdate: () => void
  onSkip: (sha: string) => void
  onDismiss: () => void
}) {
  const { result, disabled, onUpdate, onSkip, onDismiss } = props
  if (result.tarball === true) {
    return (
      <div className={css.checkBanner}>
        <div className={css.checkHead}>
          <span>
            {result.upToDate === true
              ? `已是最新（${result.installedVersion}）。`
              : `有新版本：${result.installedVersion} → ${result.latestVersion}。`}
          </span>
          <span className={css.spacer} />
          <Button size="sm" className={css.dismiss} onClick={onDismiss} aria-label="关闭检查结果">✕</Button>
        </div>
        {result.upToDate !== true && (
          <p className={css.checkMeta}>
            点「更新」在线安装新版本（pnpm add github 仓库最新提交）；完成后<b>重启 dsh</b> 生效。
          </p>
        )}
        <div className={css.checkActions}>
          {result.upToDate !== true && (
            <Button size="sm" variant="primary" onClick={onUpdate} disabled={disabled}>更新</Button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className={css.checkBanner}>
      <div className={css.checkHead}>
        <span>
          {result.skipped === true
            ? `远端有 ${result.behind} 个新提交；最新版本（${result.remoteHead}）已被你跳过。`
            : `远端（${result.upstream ?? 'upstream'}）有 ${result.behind} 个新提交。`}
        </span>
        <span className={css.spacer} />
        <Button size="sm" className={css.dismiss} onClick={onDismiss} aria-label="关闭检查结果">✕</Button>
      </div>
      <p className={css.checkMeta}>
        最新为 <code>{result.remoteHead}</code>；「更新」立即拉取，「跳过此版本」暂停提醒（远端再前进会重新提醒）。
      </p>
      {result.commits !== undefined && result.commits.length > 0 && (
        <ul className={css.checkList}>
          {result.commits.map(commit => (
            <li key={commit.sha} className={css.checkItem}>
              <span className={css.checkSha}>{commit.sha}</span>
              <span>{commit.subject}</span>
            </li>
          ))}
        </ul>
      )}
      <div className={css.checkActions}>
        <Button size="sm" variant="primary" onClick={onUpdate} disabled={disabled}>更新</Button>
        {result.remoteHead !== undefined && result.skipped !== true && (
          <Button size="sm" variant="outline" onClick={() => { onSkip(result.remoteHead!) }} disabled={disabled}>跳过此版本</Button>
        )}
      </div>
    </div>
  )
}

/**
 * One in-panel confirmation request. `cancelLabel: null` renders an
 * information-only dialog (the old window.alert sites).
 */
interface ConfirmRequest {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string | null
  /** Destructive action: confirms with the danger tone. */
  danger?: boolean
  onConfirm: () => void
}

/**
 * dsh-native replacement for window.confirm / window.alert: themed, escaped
 * by the modal layer, and it returns focus to the invoking control (the
 * native dialogs block the page and ignore the product's own styling).
 */
function ConfirmDialog({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  if (request === null) return null
  return (
    <Modal
      open
      onClose={onClose}
      title={request.title}
      description={request.description}
      closeLabel="关闭"
      footer={(
        <>
          {request.cancelLabel !== null && (
            <Button size="sm" variant="outline" onClick={onClose}>{request.cancelLabel}</Button>
          )}
          <Button
            size="sm"
            variant="primary"
            className={request.danger === true ? css.danger : undefined}
            data-modal-autofocus
            onClick={() => { onClose(); request.onConfirm() }}
          >
            {request.confirmLabel}
          </Button>
        </>
      )}
    />
  )
}

/** The workbench dashboard (see module doc). */
export function WorkbenchPanel({
  useStore,
  actions,
  openUrl,
  openPath,
  startSession,
  copyPrompt,
  loadState,
  saveConfig,
  update,
  checkUpdate,
  loadUpdateHistory,
  loadProgress,
  restartPlan,
  restart,
  skipUpdate,
  rollbackUpdate,
  loadUsage,
  recordUsage,
  checkHealth,
  loadSkills,
  installSkill,
  importSkill,
  updateSkill,
  followup,
  referenceSkill,
}: WorkbenchPanelProps) {
  const open = useStore(s => s.open)
  const search = useStore(s => s.search)
  const state = useStore(s => s.state)
  const loadError = useStore(s => s.loadError)
  const updating = useStore(s => s.updating)
  const updateLog = useStore(s => s.updateLog)
  const lastResult = useStore(s => s.lastResult)
  const skills = useStore(s => s.skills)
  const skillsLoading = useStore(s => s.skillsLoading)
  const checking = useStore(s => s.checking)
  const checkResult = useStore(s => s.checkResult)
  const updateHistory = useStore(s => s.updateHistory)
  /**
   * Whether the RUNNING Host half knows the restart route. `undefined` on
   * hosts older than 0.8.11 (no capabilities field), where the only way to
   * find out is to try — and to translate the miss into the same advice.
   */
  const hostSupportsRestart = state?.capabilities === undefined
    ? undefined
    : state.capabilities.includes('restart')

  const [editMode, setEditMode] = useState(false)
  const [editing, setEditing] = useState<ItemEditing | null>(null)
  const [groupTitleEdit, setGroupTitleEdit] = useState<string | null>(null)
  const [groupTitleDraft, setGroupTitleDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** 最近使用 ledger (P2-12); refreshed on open and after every launch. */
  const [usage, setUsage] = useState<Record<string, WorkbenchUsageRecord>>({})
  /** Last health-run results (P2-16); lives until the next run / remount. */
  const [health, setHealth] = useState<Record<string, WorkbenchHealthEntry> | null>(null)
  const [healthBusy, setHealthBusy] = useState(false)
  /** Search keyboard-navigation cursor into the flat match list (P2-14). */
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  /** Item currently being drag-reordered (P2-15). */
  const dragRef = useRef<{ groupId: string; itemId: string } | null>(null)
  /** Drag visuals: the source card and the current hover target. */
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)
  /** The one open confirmation dialog (replaces window.confirm/alert). */
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  /** Live stage of the running update pipeline (③), polled while updating. */
  const [progress, setProgress] = useState<WorkbenchUpdateProgress | null>(null)
  /** True from "restart accepted" until the host answers again (③). */
  const [restarting, setRestarting] = useState(false)
  /** Whether the footer's full update history is expanded (③). */
  const [historyOpen, setHistoryOpen] = useState(false)
  /** Dialog element: the modal layer owns Escape, Tab trapping and focus return. */
  const panelRef = useRef<HTMLElement | null>(null)

  const askConfirm = useCallback((request: ConfirmRequest) => { setConfirmRequest(request) }, [])
  const closeConfirm = useCallback(() => { setConfirmRequest(null) }, [])
  const closePanel = useCallback(() => { actions.setOpen(false) }, [actions])
  // Escape + focus trap + return-to-invoker focus, from dsh's own modal layer.
  // The panel announces itself as a real dialog so nested dialogs (the
  // confirmation Modal) take the foreground first.
  useModalLayer(panelRef, open, closePanel)

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

  // Reachability badges are a snapshot of one probe run, not permanent state:
  // they clear on the same window so a stale ✓/✗ never lingers on the cards
  // (including the "✓ n / m 可达" line in the edit bar). A running probe is
  // never cut short — the countdown starts when its results land.
  useEffect(() => {
    if (health === null || healthBusy) return
    const timer = window.setTimeout(() => { setHealth(null) }, NOTICE_AUTO_DISMISS_MS)
    return () => { window.clearTimeout(timer) }
  }, [health, healthBusy])

  // Update progress (③): while a pipeline runs, poll the Host's stage line so
  // the panel shows "正在安装依赖…" instead of a frozen button. The interval
  // clears itself as soon as the update settles; the last polled snapshot is
  // simply not rendered once `updating` goes false (derived below).
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

  /**
   * One-click restart (③). The Host decides whether it may relaunch itself:
   * embedded (Electron) and service-managed (systemd) hosts answer
   * `relaunchable: false`, and the dialog then hands over the exact command
   * instead of pretending the button can work.
   */
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
    if (hostSupportsRestart === false) {
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
      askConfirm({
        title: '重启 dsh',
        description: `${plan.note ?? '当前形态不支持面板内重启。'} 启动命令：${plan.command}`,
        confirmLabel: '复制命令',
        cancelLabel: '关闭',
        onConfirm: () => { void copyPrompt(plan.command) },
      })
      return
    }
    askConfirm({
      title: '重启 dsh',
      description: '将结束当前 harness 进程并重新拉起：页面断开约 10–20 秒，恢复后自动刷新。进行中的会话会被中断（记录已落盘，重启后可继续）。',
      confirmLabel: '重启',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performRestart() },
    })
  }, [restartPlan, askConfirm, copyPrompt, performRestart, actions, hostSupportsRestart])

  /** Persist a whole config; on success re-read state from the Host. */
  const persistConfig = useCallback(async (next: WorkbenchConfig): Promise<boolean> => {
    setSaving(true)
    setSaveError(null)
    try {
      await saveConfig(next)
      await reload()
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }, [saveConfig, reload])

  const toggleEditMode = useCallback(() => {
    setEditMode(mode => {
      if (mode) {
        setEditing(null)
        setGroupTitleEdit(null)
        setSaveError(null)
      }
      return !mode
    })
  }, [])

  const startAddItem = (groupId: string): void => {
    setEditing({ groupId, itemId: null, draft: emptyDraft() })
  }
  const startEditItem = (groupId: string, item: WorkbenchItem): void => {
    setEditing({ groupId, itemId: item.id, draft: draftFromItem(item) })
  }
  const cancelDraft = (): void => { setEditing(null) }

  const submitDraft = async (): Promise<void> => {
    if (state === null || editing === null) return
    const { groupId, itemId } = editing
    let draft = editing.draft
    if (draft.title.trim() === '') {
      draft = { ...draft, title: '新条目' }
    }
    const next: WorkbenchConfig = {
      groups: state.config.groups.map(group => {
        if (group.id !== groupId) return group
        const items = itemId === null
          ? [...group.items, itemFromDraft(genId('item'), draft)]
          : group.items.map(item => (item.id === itemId ? itemFromDraft(itemId, draft) : item))
        return { ...group, items }
      }),
    }
    if (await persistConfig(next)) setEditing(null)
  }

  const deleteItem = (groupId: string, item: WorkbenchItem): void => {
    if (state === null) return
    askConfirm({
      title: '删除条目',
      description: `确定删除「${item.title}」？此操作立即写入 workbench.json。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performDeleteItem(groupId, item) },
    })
  }
  const performDeleteItem = async (groupId: string, item: WorkbenchItem): Promise<void> => {
    if (state === null) return
    const next: WorkbenchConfig = {
      groups: state.config.groups.map(group => (
        group.id !== groupId ? group : { ...group, items: group.items.filter(i => i.id !== item.id) }
      )),
    }
    await persistConfig(next)
  }

  const startRenameGroup = (group: WorkbenchGroup): void => {
    setGroupTitleEdit(group.id)
    setGroupTitleDraft(group.title)
  }
  const submitRenameGroup = async (groupId: string): Promise<void> => {
    if (state === null) return
    const title = groupTitleDraft.trim()
    if (title === '') {
      setSaveError('分组名称不能为空')
      return
    }
    const next: WorkbenchConfig = {
      groups: state.config.groups.map(group => (group.id === groupId ? { ...group, title } : group)),
    }
    if (await persistConfig(next)) {
      setGroupTitleEdit(null)
      setGroupTitleDraft('')
    }
  }
  const deleteGroup = (group: WorkbenchGroup): void => {
    if (state === null) return
    askConfirm({
      title: '删除分组',
      description: `确定删除分组「${group.title}」及其 ${group.items.length} 个条目？`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performDeleteGroup(group) },
    })
  }
  const performDeleteGroup = async (group: WorkbenchGroup): Promise<void> => {
    if (state === null) return
    const next: WorkbenchConfig = { groups: state.config.groups.filter(g => g.id !== group.id) }
    if (await persistConfig(next)) {
      if (editing !== null && editing.groupId === group.id) setEditing(null)
      if (groupTitleEdit === group.id) {
        setGroupTitleEdit(null)
        setGroupTitleDraft('')
      }
    }
  }
  const addGroup = async (): Promise<void> => {
    if (state === null) return
    const group: WorkbenchGroup = { id: genId('group'), title: '新分组', items: [] }
    const next: WorkbenchConfig = { groups: [...state.config.groups, group] }
    if (await persistConfig(next)) startRenameGroup(group)
  }

  // Hot-inject survival (v0.8.4): when this instance is the fresh bundle
  // mounted right after an in-panel update/rollback rebuilt the plugin, the
  // store starts closed (open=false) — exactly what made a successful update
  // look like a crash. Consume the flag the old instance left behind, reopen,
  // and refill the history/log surfaces the remount wiped.
  useEffect(() => {
    if (!takeReopenAfterRebuild()) return
    actions.setOpen(true)
    actions.setLastResult('工作台已更新并自动重载。')
    void reload()
    void reloadHistory()
  }, [actions, reload, reloadHistory])

  // Load state + skills catalog when the panel opens; Esc and backdrop
  // click close it. Skills refresh in parallel with state — they come from
  // an independent registry and neither blocks the other's render. The
  // update history loads alongside (cheap local read feeding the rollback
  // affordance); the network-touching update CHECK stays explicit.
  useEffect(() => {
    if (!open) return
    void reload()
    void reloadSkills()
    void reloadHistory()
    // The setState inside lands after an awaited fetch, not during the effect
    // body — the synchronous-cascade the rule guards against cannot happen.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadUsage()
  }, [open, reload, reloadSkills, reloadHistory, reloadUsage])

  // Alt+W toggles the panel from anywhere on the page (roadmap P2-13).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && (event.key === 'w' || event.key === 'W')) {
        event.preventDefault()
        actions.toggleOpen()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions])

  const handleOpenPath = async (path: string): Promise<void> => {
    try {
      await openPath(path)
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
    }
  }
  const handleCopy = async (prompt: string): Promise<void> => {
    try {
      await copyPrompt(prompt)
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
    }
  }
  const handleUseSkill = async (prompt: string): Promise<void> => {
    // followup() is the modern path (agent.followup on the visible session);
    // it silently no-ops when no sessionId is known and the Host initiator is
    // absent — in that case fall back to clipboard + new session so the user
    // still gets the prompt into a chat.
    const result = await followup(prompt).catch(() => ({ ok: false as const }))
    if (!result.ok) {
      await handleCopy(prompt)
      startSession()
    }
  }
  /**
   * "Use skill" flow: reference the skill inline in the CURRENT session —
   * drop `/<skillName>` into its composer (dsh's `/` trigger resolves it) and
   * close the panel so the composer is in view; the user edits/sends it
   * themselves. Falls back to a hint when no session is open to receive it.
   */
  const handleSkillUse = (skillName: string): void => {
    const result = referenceSkill(skillName)
    if (result.ok) {
      actions.setOpen(false)
      return
    }
    if (result.reason === 'no-session') {
      askConfirm({
        title: '无法引用技能',
        description: '请先打开或新建一个会话，再从工作台引用技能。',
        confirmLabel: '知道了',
        cancelLabel: null,
        onConfirm: () => { /* informational only */ },
      })
    }
  }

  /** Run one entry's action through its configured kind, counting the launch (P2-12). */
  const runItemAction = (item: WorkbenchItem): void => {
    const target = entryTarget(item)
    if (target === null) return
    void recordUsage(item.id).then(() => { void reloadUsage() })
    if (target.kind === 'url') {
      openUrl(target.value)
      return
    }
    if (target.kind === 'path') {
      void handleOpenPath(target.value)
      return
    }
    void handleUseSkill(target.value)
  }

  /** Probe every entry's reachability and badge the cards (roadmap P2-16). */
  const runHealth = async (): Promise<void> => {
    setHealthBusy(true)
    try {
      setHealth((await checkHealth()).results)
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setHealthBusy(false)
    }
  }

  // Drag-reorder plumbing (roadmap P2-15): the payload rides a ref (no data
  // transfer needed inside one document); drops land on a card (insert
  // before it) or a group body (append). The visible drag state lives in
  // React state so the source card and the hover target can be styled, and
  // dragend clears everything even when the drop missed every target.
  const clearDragState = (): void => {
    dragRef.current = null
    setDraggingId(null)
    setDragOverId(null)
    setDragOverGroupId(null)
  }
  const handleDragStartItem = (groupId: string, itemId: string): void => {
    dragRef.current = { groupId, itemId }
    setDraggingId(itemId)
  }
  const handleDropOnItem = async (targetGroupId: string, targetItem: WorkbenchItem): Promise<void> => {
    const drag = dragRef.current
    clearDragState()
    if (state === null || drag === null || drag.itemId === targetItem.id) return
    const next = moveItem(state.config, drag, targetGroupId, targetItem.id)
    if (next !== null) await persistConfig(next)
  }
  const handleDropOnGroup = async (targetGroupId: string): Promise<void> => {
    const drag = dragRef.current
    clearDragState()
    if (state === null || drag === null || drag.groupId === targetGroupId) return
    const next = moveItem(state.config, drag, targetGroupId, null)
    if (next !== null) await persistConfig(next)
  }

  /** Keyboard-reachable reorder: shift one entry inside its own group. */
  const moveItemBy = async (groupId: string, item: WorkbenchItem, delta: number): Promise<void> => {
    if (state === null) return
    const next = moveWithinGroup(state.config, groupId, item.id, delta)
    if (next !== null) await persistConfig(next)
  }
  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) closePanel()
  }

  // Search projection + flat match list live before the early return so the
  // keyboard-navigation effect can read them (roadmap P2-14).
  const query = search.trim().toLowerCase()
  const groups = (state?.config.groups ?? []).map(group => ({
    ...group,
    items: query === ''
      ? group.items
      : group.items.filter(item =>
        item.title.toLowerCase().includes(query)
        || (item.description ?? '').toLowerCase().includes(query)),
  })).filter(group => editMode || group.items.length > 0)
  const flatMatches = query === '' ? [] : groups.flatMap(group => group.items)
  const effectiveActive = activeIndex !== null && flatMatches.length > 0
    ? Math.min(activeIndex, flatMatches.length - 1)
    : null
  const activeItemId = effectiveActive !== null ? flatMatches[effectiveActive]?.id : undefined
  const lastOkUpdate = updateHistory?.find(entry => entry.ok === true && entry.changed === true)
  /** Progress is shown only while an update is genuinely in flight, so a stale
   *  snapshot from the previous run never lingers in the footer. */
  const liveProgress = updating && progress?.running === true ? progress : null

  // Keep the keyboard cursor in view while arrowing through matches.
  useEffect(() => {
    if (activeItemId === undefined) return
    document.querySelector(`[data-wb-item="${CSS.escape(activeItemId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeItemId])

  if (!open) return null

  return (
    <div className={css.backdrop} onClick={onBackdrop} data-whaletv-workbench>
      {/* role=dialog + aria-modal put this panel into dsh's own modal layer:
          Escape/Tab ownership, focus trapping and return-to-invoker focus all
          come from useModalLayer, and nested dialogs (the confirm Modal) take
          the foreground first. */}
      <section
        ref={panelRef}
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whaletv-workbench-title"
      >
        <header className={css.header}>
          <img src={WORKBENCH_ICON} alt="" className={css.icon} />
          <h1 className={css.title} id="whaletv-workbench-title">WhaleTV 工作台</h1>
          <span className={css.version}>v{state?.version ?? '…'}</span>
          <span className={css.spacer} />
          {state?.git.configured === true && (
            <span className={css.git} title={state.git.remote}>
              {state.git.branch}@{state.git.head}
            </span>
          )}
          {checkResult?.ok === true && (checkResult.behind ?? 0) > 0 && (
            <span className={css.checkMeta} title={`upstream ${checkResult.upstream ?? ''}`}>
              落后 {checkResult.behind} 提交
            </span>
          )}
          <Button size="sm" onClick={() => { void reload(); void reloadSkills() }} disabled={updating || saving}>刷新</Button>
          {/* Single update entry (review 2026-09-03): 检查更新 fetches and shows
              the result banner; the banner's 更新 button is the only path that
              applies. Both install kinds are supported: git checkouts compare
              refs; tarball installs compare versions and hand the update to
              the dsh plugin-manager. */}
          <Button
            size="sm"
            variant={checkResult?.ok === true && ((checkResult.behind ?? 0) > 0 || checkResult.upToDate === false) ? 'primary' : undefined}
            onClick={() => { void runCheck() }}
            disabled={updating || checking || saving}
          >
            {updating ? '更新中…' : checking ? '检查中…' : '检查更新'}
          </Button>
          <Button size="sm" variant={editMode ? 'primary' : 'outline'} onClick={toggleEditMode} disabled={updating || saving}>
            {editMode ? '完成' : '编辑'}
          </Button>
          {hostSupportsRestart === false && (
            <span className={css.skewBadge} title={HOST_SKEW_HINT}>服务端待重启</span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void runRestart() }}
            disabled={updating || saving || restarting}
            title={hostSupportsRestart === false ? HOST_SKEW_HINT : '结束并重新拉起 dsh；面板会等待服务恢复后自动刷新'}
          >
            {restarting ? '重启中…' : '重启 dsh'}
          </Button>
          <Button size="sm" onClick={closePanel} aria-label="关闭工作台">✕</Button>
        </header>

        {loadError !== null && (
          <div className={css.errorBanner} role="alert">
            {loadError}
            <Button size="sm" onClick={() => { void reload() }}>重试</Button>
          </div>
        )}
        {saveError !== null && (
          <div className={css.errorBanner} role="alert">
            {saveError}
            <Button size="sm" onClick={() => { setSaveError(null) }}>知道了</Button>
          </div>
        )}
        {checkResult !== null && (checkResult.ok === false ? (
          <div className={css.errorBanner} role="alert">
            检查更新失败：{checkResult.error}
            <Button size="sm" onClick={() => { void runCheck() }} disabled={checking}>重试</Button>
          </div>
        ) : checkResult.upToDate === true && checkResult.tarball !== true ? (
          <div className={css.checkBanner}>
            <div className={css.checkHead}>
              <span>
                已是最新
                {(checkResult.ahead ?? 0) > 0 ? `（本地领先 ${checkResult.ahead} 提交，尚未推送）` : ''}。
              </span>
              <span className={css.spacer} />
              <Button size="sm" className={css.dismiss} onClick={() => { actions.setCheckResult(null) }} aria-label="关闭检查结果">✕</Button>
            </div>
          </div>
        ) : (
          <UpdateCheckBanner
            result={checkResult}
            disabled={updating || checking || saving}
            onUpdate={() => { void runUpdate() }}
            onSkip={sha => { void runSkip(sha) }}
            onDismiss={() => { actions.setCheckResult(null) }}
          />
        ))}

        <div className={css.search}>
          <Input
            data-modal-autofocus
            placeholder="搜索网页 / 文档 / 应用 / 技能…（↑↓ 选择，Enter 打开）"
            value={search}
            onChange={event => {
              actions.setSearch(event.target.value)
              setActiveIndex(null)
            }}
            onKeyDown={event => {
              if (query === '' || flatMatches.length === 0) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex(prev => prev === null ? 0 : Math.min(prev + 1, flatMatches.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex(prev => prev === null ? flatMatches.length - 1 : Math.max(prev - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                // First Enter with nothing highlighted only MOVES the cursor:
                // executing straight away would launch a local program (path
                // entries) from a stray Enter right after typing. The second
                // Enter runs the highlighted entry.
                if (effectiveActive === null) {
                  setActiveIndex(0)
                  return
                }
                const hit = flatMatches[effectiveActive]
                if (hit !== undefined) runItemAction(hit)
              }
            }}
          />
        </div>

        <div className={css.body}>
          {query === '' && (
            <RecentBar
              entries={Object.entries(usage)
                .sort(([, a], [, b]) => (a.lastUsed < b.lastUsed ? 1 : -1))
                .slice(0, 10)
                .map(([id, record]) => {
                  const item = (state?.config.groups ?? []).flatMap(group => group.items).find(candidate => candidate.id === id)
                  return item !== undefined
                    ? { id, title: item.title, count: record.count, lastUsed: record.lastUsed }
                    : null
                })
                .filter((entry): entry is { id: string; title: string; count: number; lastUsed: string } => entry !== null)}
              onRun={id => {
                const item = (state?.config.groups ?? []).flatMap(group => group.items).find(candidate => candidate.id === id)
                if (item !== undefined) runItemAction(item)
              }}
            />
          )}
          {state === null && loadError === null && <p className={css.hint}>正在加载工作台配置…</p>}
          {state !== null && groups.length === 0 && (
            <p className={css.hint}>
              {query === ''
                ? (editMode ? '暂无条目：点击下方「+ 新建分组」开始添加。' : '暂无条目：点击右上角「编辑」添加。')
                : '没有匹配的条目。'}
            </p>
          )}
          {groups.map(group => (
            <section key={group.id} className={css.group}>
              {editMode && groupTitleEdit === group.id ? (
                <div className={css.groupTitleRow}>
                  <Input
                    placeholder="分组名称"
                    value={groupTitleDraft}
                    onChange={event => { setGroupTitleDraft(event.target.value) }}
                    aria-label="分组名称"
                  />
                  <Button size="sm" variant="primary" onClick={() => { void submitRenameGroup(group.id) }} disabled={saving}>保存</Button>
                  <Button size="sm" onClick={() => { setGroupTitleEdit(null) }} disabled={saving}>取消</Button>
                </div>
              ) : (
                <div className={css.groupHead}>
                  <h2 className={css.groupTitle}>{group.title}</h2>
                  {editMode && (
                    <span className={css.groupTools}>
                      <Button size="sm" variant="outline" onClick={() => { startRenameGroup(group) }} disabled={saving}>重命名</Button>
                      <Button size="sm" variant="outline" onClick={() => { startAddItem(group.id) }} disabled={saving}>+ 条目</Button>
                      <Button size="sm" variant="outline" className={css.danger} onClick={() => { void deleteGroup(group) }} disabled={saving}>删除分组</Button>
                    </span>
                  )}
                </div>
              )}
              <div
                className={clsx(css.grid, dragOverGroupId === group.id && css.gridDropActive)}
                onDragOver={event => {
                  if (!editMode) return
                  event.preventDefault()
                  if (draggingId !== null && dragOverGroupId !== group.id) setDragOverGroupId(group.id)
                }}
                onDragLeave={event => {
                  // Leaving the body (not just crossing an inner card) clears
                  // the highlight; relatedTarget inside the grid is not a leave.
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  setDragOverGroupId(prev => (prev === group.id ? null : prev))
                }}
                onDrop={() => { if (editMode) void handleDropOnGroup(group.id) }}
              >
                {group.items.map(item => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    editMode={editMode}
                    editing={editMode && editing !== null && editing.groupId === group.id && editing.itemId === item.id}
                    draft={editing?.draft ?? emptyDraft()}
                    saving={saving}
                    highlight={activeItemId === item.id}
                    health={health !== null ? health[item.id] : undefined}
                    dragging={draggingId === item.id}
                    dropTarget={dragOverId === item.id}
                    canMoveUp={group.items[0]?.id !== item.id}
                    canMoveDown={group.items[group.items.length - 1]?.id !== item.id}
                    onMoveBy={delta => { void moveItemBy(group.id, item, delta) }}
                    onDraftChange={patch => {
                      setEditing(prev => prev === null ? prev : { ...prev, draft: { ...prev.draft, ...patch } })
                    }}
                    onSaveDraft={() => { void submitDraft() }}
                    onCancelDraft={cancelDraft}
                    onEdit={() => { startEditItem(group.id, item) }}
                    onDelete={() => { void deleteItem(group.id, item) }}
                    onOpenUrl={url => { openUrl(url) }}
                    onOpenPath={path => { void handleOpenPath(path) }}
                    onUseSkill={prompt => { void handleUseSkill(prompt) }}
                    onCopy={prompt => { void handleCopy(prompt) }}
                    onDragStartItem={() => { handleDragStartItem(group.id, item.id) }}
                    onDragEnterItem={() => { setDragOverId(item.id) }}
                    onDropOnItem={() => { void handleDropOnItem(group.id, item) }}
                    onDragEndItem={clearDragState}
                  />
                ))}
                {editMode && editing !== null && editing.groupId === group.id && editing.itemId === null && (
                  <div className={clsx(css.item, css.itemEditing)}>
                    <ItemForm
                      draft={editing.draft}
                      saving={saving}
                      onChange={patch => {
                        setEditing(prev => prev === null ? prev : { ...prev, draft: { ...prev.draft, ...patch } })
                      }}
                      onSave={() => { void submitDraft() }}
                      onCancel={cancelDraft}
                    />
                  </div>
                )}
              </div>
            </section>
          ))}
          {editMode && state !== null && (
            <div className={css.editBar}>
              <Button size="sm" variant="outline" onClick={() => { void addGroup() }} disabled={saving}>+ 新建分组</Button>
              <Button size="sm" variant="outline" onClick={() => { void runHealth() }} disabled={healthBusy || saving} title="逐条探测 URL 可达性与本地路径存在性">
                {healthBusy ? '检查中…' : '检查可达性'}
              </Button>
              {health !== null && !healthBusy && (
                <span className={css.checkMeta}>
                  ✓ {Object.values(health).filter(entry => entry.ok).length} / {Object.keys(health).length} 可达
                </span>
              )}
            </div>
          )}
          <SkillsSection
            skills={skills}
            skillsLoading={skillsLoading}
            query={query}
            installSkill={installSkill}
            importSkill={importSkill}
            updateSkill={updateSkill}
            onUse={(name) => { handleSkillUse(name) }}
            onReload={() => { void reloadSkills() }}
          />
        </div>

        {(lastResult !== null || updateLog !== '' || liveProgress !== null || historyOpen) && (
          <footer className={clsx(css.footer, lastResult !== null && css.footerWithResult)}>
            {liveProgress !== null && (
              <p className={css.progressLine} role="status">
                <span className={css.progressDot} aria-hidden="true" />
                {liveProgress.detail}
                {liveProgress.elapsedSeconds !== undefined ? `（已 ${liveProgress.elapsedSeconds}s）` : ''}
              </p>
            )}
            <div className={css.footerHead}>
              {lastResult !== null && <p className={css.result}>{lastResult}</p>}
              <Button size="sm" className={css.dismiss} onClick={dismissResult} aria-label="关闭提示">✕</Button>
            </div>
            {updateLog !== '' && <pre className={css.log}>{updateLog}</pre>}
            {lastOkUpdate !== undefined && (
              <div className={css.rollbackRow}>
                <span>
                  上次成功更新 {lastOkUpdate.time.slice(0, 16).replace('T', ' ')}
                  （{lastOkUpdate.before ?? '?'} → {lastOkUpdate.after ?? '?'}）
                </span>
                <Button size="sm" variant="outline" onClick={runRollback} disabled={updating || saving}>
                  回滚上一版本
                </Button>
              </div>
            )}
            {/* Update history (③): the rolling attempts log was already on the
                wire for the rollback affordance; this exposes all of it. */}
            {updateHistory !== null && updateHistory.length > 0 && (
              <div className={css.historyBlock}>
                <button
                  type="button"
                  className={css.historyToggle}
                  aria-expanded={historyOpen}
                  onClick={() => { setHistoryOpen(open => !open) }}
                >
                  {historyOpen ? '▾' : '▸'} 更新历史（{updateHistory.length}）
                </button>
                {historyOpen && (
                  <ul className={css.historyList}>
                    {updateHistory.map(entry => (
                      <li key={`${entry.time}-${entry.after ?? ''}`} className={css.historyItem}>
                        <span className={css.historyTime}>{entry.time.slice(0, 16).replace('T', ' ')}</span>
                        <span className={clsx(css.historyBadge, entry.ok ? css.historyOk : css.historyBad)}>
                          {entry.ok ? '成功' : '失败'}
                        </span>
                        <span className={css.historyDetail}>
                          {entry.ok
                            ? `${entry.changed === true ? '有更新' : '无变化'}${entry.before !== undefined && entry.after !== undefined ? ` ${entry.before.slice(0, 7)} → ${entry.after.slice(0, 7)}` : ''}${entry.needRestart === true ? '（需重启）' : ''}`
                            : (entry.error ?? '未知错误')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </footer>
        )}
      </section>
      {restarting && (
        <div className={css.restartOverlay} role="status" aria-live="polite">
          <p className={css.restartTitle}>正在重启 dsh…</p>
          <p className={css.restartHint}>服务恢复后面板会自动刷新；若长时间没有动静，请用托盘菜单重启 Web 服务。</p>
        </div>
      )}
      <ConfirmDialog request={confirmRequest} onClose={closeConfirm} />
    </div>
  )
}
