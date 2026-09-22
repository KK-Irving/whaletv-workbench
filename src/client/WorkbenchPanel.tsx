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
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { WorkbenchInjected, WorkbenchPanelProps } from './contract.ts'
import type {
  WorkbenchConfig, WorkbenchGroup, WorkbenchHealthEntry, WorkbenchItem, WorkbenchSkillList,
  WorkbenchSkillSummary, WorkbenchUpdateCheckResult, WorkbenchUsageRecord,
} from '../shared.ts'
import { WORKBENCH_ICON } from './icon.ts'
import css from './WorkbenchPanel.module.css'

/** The one action label each entry kind drives. */function actionLabel(item: WorkbenchItem): string {
  if (item.url !== undefined && item.url !== '') return '打开网页'
  if (item.path !== undefined && item.path !== '') return '打开'
  if (item.prompt !== undefined && item.prompt !== '') return '在会话中使用'
  return '未配置'
}

/** Whether an entry has any configured target. */
function isConfigured(item: WorkbenchItem): boolean {
  return actionLabel(item) !== '未配置'
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
  onDropOnItem?: () => void
}) {
  const {
    item, editMode, editing, draft, saving, highlight, health,
    onDraftChange, onSaveDraft, onCancelDraft, onEdit, onDelete,
    onOpenUrl, onOpenPath, onUseSkill, onCopy,
    onDragStartItem, onDropOnItem,
  } = props
  const configured = isConfigured(item)
  const iconSrc = item.url !== undefined && item.url !== '' ? iconSrcFor(item.url) : ''

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
        onDrop: () => { onDropOnItem?.() },
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
      className={clsx(css.item, highlight === true && css.itemActive)}
      data-wb-item={item.id}
    >
      {head}
      {item.description !== undefined && item.description !== ''
        && <p className={css.itemDesc}>{item.description}</p>}
      {editMode ? (
        <div className={css.itemActions}>
          <Button size="sm" variant="outline" onClick={onEdit} disabled={saving}>编辑</Button>
          <Button size="sm" variant="outline" className={css.danger} onClick={onDelete} disabled={saving}>删除</Button>
        </div>
      ) : (
        <div className={css.itemActions}>
          {item.url !== undefined && item.url !== '' && (
            <Button size="sm" variant="outline" onClick={() => { onOpenUrl(item.url!) }}>{actionLabel(item)}</Button>
          )}
          {item.path !== undefined && item.path !== '' && (
            <Button size="sm" variant="outline" onClick={() => { onOpenPath(item.path!) }}>{actionLabel(item)}</Button>
          )}
          {item.prompt !== undefined && item.prompt !== '' && (
            <>
              <Button size="sm" variant="outline" onClick={() => { onUseSkill(item.prompt!) }}>{actionLabel(item)}</Button>
              <Button size="sm" onClick={() => { onCopy(item.prompt!) }}>复制提示词</Button>
            </>
          )}
          {!configured && <Button size="sm" disabled>{actionLabel(item)}</Button>}
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
  skipUpdate,
  rollbackUpdate,
  loadUsage,
  recordUsage,
  checkHealth,
  loadSkills,
  installSkill,
  importSkill,
  removeSkill,
  updateSkill,
  loadSkillSource,
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

  // Auto-dismiss timer for the "already up to date" notification (no log to
  // read → 5s countdown). Cleared on manual ✕, next update start, or unmount.
  const dismissTimerRef = useRef<number | null>(null)
  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])
  const dismissResult = useCallback(() => {
    clearDismissTimer()
    actions.setLastResult(null)
    actions.setUpdateLog('')
  }, [actions, clearDismissTimer])
  useEffect(() => () => { clearDismissTimer() }, [clearDismissTimer])

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
   * live inside the returned WorkbenchSkillList (never thrown), so the
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

  const runUpdate = useCallback(async () => {
    clearDismissTimer()
    actions.setUpdating(true)
    actions.setUpdateLog('')
    actions.setLastResult(null)
    try {
      const result = await update()
      if (result.changed === true) {
        actions.setUpdateLog(result.output ?? '')
        // needRestart is host-diff-precise (see Host runUpdate): only a
        // src/index.ts / tsdown.config.ts / package.json change asks for a
        // restart; client-only pulls hot-inject and refresh on their own.
        actions.setLastResult(
          result.needRestart === true
            ? '更新完成。本次包含服务端改动，请重启 dsh web 后生效。'
            : '更新完成并已热注入，界面将自动刷新。',
        )
        actions.setCheckResult(null)
        void reload()
        void reloadHistory()
      } else {
        // No new commits — no log to read; auto-dismiss after 5s.
        actions.setUpdateLog('')
        actions.setLastResult('已是最新版本，无需更新。')
        dismissTimerRef.current = window.setTimeout(() => {
          dismissTimerRef.current = null
          actions.setLastResult(null)
        }, 5000)
      }
    } catch (error) {
      actions.setUpdateLog(error instanceof Error ? error.message : String(error))
      actions.setLastResult('更新失败，详见下方日志。')
    } finally {
      actions.setUpdating(false)
    }
  }, [actions, update, reload, reloadHistory, clearDismissTimer])

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

  /** Reset to the state before the last successful update (P1-9). */
  const runRollback = useCallback(async () => {
    const previous = updateHistory?.find(entry => entry.ok === true && entry.changed === true)
    if (previous === undefined) return
    if (!window.confirm(`回滚到更新前（${previous.before ?? '?'}）？工作区不能有未提交修改。`)) return
    clearDismissTimer()
    actions.setUpdating(true)
    actions.setUpdateLog('')
    actions.setLastResult(null)
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
  }, [actions, rollbackUpdate, reload, reloadHistory, updateHistory, clearDismissTimer])

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
  }, [actions, saveConfig, reload])

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

  const deleteItem = async (groupId: string, item: WorkbenchItem): Promise<void> => {
    if (state === null) return
    if (!window.confirm(`删除条目「${item.title}」？`)) return
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
  const deleteGroup = async (group: WorkbenchGroup): Promise<void> => {
    if (state === null) return
    if (!window.confirm(`删除分组「${group.title}」及其 ${group.items.length} 个条目？`)) return
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
    void reloadUsage()
  }, [open, reload, reloadSkills, reloadHistory])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') actions.setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open, actions])

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
      window.alert('请先打开或新建一个会话，再从工作台引用技能。')
    }
  }
  /** Uninstall a workbench-managed skill by name; disk + settings registry entry. */
  const handleSkillRemove = async (skillName: string): Promise<void> => {
    if (!window.confirm(`删除技能「${skillName}」？（仅移除工作台安装到 $DSH_HOME/skills 的文件）`)) return
    try {
      await removeSkill(skillName)
      await reloadSkills()
    } catch (error) {
      actions.setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  /** Refresh the 最近使用 ledger (roadmap P2-12). */
  const reloadUsage = async (): Promise<void> => {
    try {
      setUsage((await loadUsage()).usage)
    } catch {
      // Rail-only data — a failed read just leaves the rail stale.
    }
  }

  /** Run one entry's action through its configured kind, counting the launch (P2-12). */
  const runItemAction = (item: WorkbenchItem): void => {
    void recordUsage(item.id).then(() => { void reloadUsage() })
    if (item.url !== undefined && item.url !== '') {
      openUrl(item.url)
      return
    }
    if (item.path !== undefined && item.path !== '') {
      void handleOpenPath(item.path)
      return
    }
    if (item.prompt !== undefined && item.prompt !== '') {
      void handleUseSkill(item.prompt)
    }
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
  // before it) or a group body (append).
  const handleDragStartItem = (groupId: string, itemId: string): void => {
    dragRef.current = { groupId, itemId }
  }
  const handleDropOnItem = async (targetGroupId: string, targetItem: WorkbenchItem): Promise<void> => {
    const drag = dragRef.current
    dragRef.current = null
    if (state === null || drag === null || drag.itemId === targetItem.id) return
    const next = moveItem(state.config, drag, targetGroupId, targetItem.id)
    if (next !== null) await persistConfig(next)
  }
  const handleDropOnGroup = async (targetGroupId: string): Promise<void> => {
    const drag = dragRef.current
    dragRef.current = null
    if (state === null || drag === null || drag.groupId === targetGroupId) return
    const next = moveItem(state.config, drag, targetGroupId, null)
    if (next !== null) await persistConfig(next)
  }
  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) actions.setOpen(false)
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

  // Keep the keyboard cursor in view while arrowing through matches.
  useEffect(() => {
    if (activeItemId === undefined) return
    document.querySelector(`[data-wb-item="${CSS.escape(activeItemId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [activeItemId])

  if (!open) return null

  return (
    <div className={css.backdrop} onClick={onBackdrop} data-whaletv-workbench>
      <section className={css.panel} aria-label="WhaleTV 工作台">
        <header className={css.header}>
          <img src={WORKBENCH_ICON} alt="" className={css.icon} />
          <h1 className={css.title}>WhaleTV 工作台</h1>
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
          <Button size="sm" onClick={() => { void runCheck() }} disabled={updating || checking || saving}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
          <Button size="sm" variant={editMode ? 'primary' : 'outline'} onClick={toggleEditMode} disabled={updating || saving}>
            {editMode ? '完成' : '编辑'}
          </Button>
          <Button size="sm" variant="primary" onClick={() => { void runUpdate() }} disabled={updating || saving}>
            {updating ? '更新中…' : '更新'}
          </Button>
          <Button size="sm" onClick={() => { actions.setOpen(false) }} aria-label="关闭工作台">✕</Button>
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
        ) : checkResult.upToDate === true ? (
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
                const hit = flatMatches[effectiveActive ?? 0]
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
                className={css.grid}
                onDragOver={event => { if (editMode) event.preventDefault() }}
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
                    onDropOnItem={() => { void handleDropOnItem(group.id, item) }}
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
            loadSkillSource={loadSkillSource}
            onUse={(name) => { handleSkillUse(name) }}
            onRemove={(name) => { void handleSkillRemove(name) }}
            onReload={() => { void reloadSkills() }}
          />
        </div>

        {(lastResult !== null || updateLog !== '') && (
          <footer className={clsx(css.footer, lastResult !== null && css.footerWithResult)}>
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
                <Button size="sm" variant="outline" onClick={() => { void runRollback() }} disabled={updating || saving}>
                  回滚上一版本
                </Button>
              </div>
            )}
          </footer>
        )}
      </section>
    </div>
  )
}

/** Two mutually-exclusive skill install modes offered in the form. */
type SkillFormMode = 'inline' | 'git'

/** Inline-write install draft (name + description + Markdown body). */
interface SkillInlineDraft {
  name: string
  description: string
  content: string
}

/** Git-import draft (URL + optional ref + optional sub-path + target name). */
interface SkillGitDraft {
  url: string
  ref: string
  subPath: string
  name: string
}

function emptyInlineDraft(): SkillInlineDraft {
  return { name: '', description: '', content: '' }
}
function emptyGitDraft(): SkillGitDraft {
  return { url: '', ref: '', subPath: '', name: '' }
}

/**
 * Compose a SKILL.md body from the inline form: YAML frontmatter carrying
 * `name` + `description` (the two keys the dsh-skill-filesystem provider
 * reads) followed by the user's markdown body. Description is written on
 * one line and escaped minimally so the frontmatter parser accepts it.
 */
function composeInlineSkill(draft: SkillInlineDraft): string {
  const escapedDesc = draft.description.replace(/"/g, '\\"')
  const front = [
    '---',
    `name: ${draft.name}`,
    `description: "${escapedDesc}"`,
    '---',
    '',
  ].join('\n')
  return front + draft.content
}

/** Normalize any tail-of-path segment to a kebab-case skill identifier. */
function kebabize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Guess a kebab-case target name from a git URL + sub-path when the user
 * hasn't picked one yet. Walks sub-path segments from the leaf inward
 * skipping the reserved `SKILL.md` filename (that's the bundle contract,
 * not the skill's identity — the parent directory names it). Falls back
 * to the repo name (strip `.git` and any URL fragment).
 *
 * Fixes an earlier bug where `subPath: foo/SKILL.md` derived the name
 * "skill" (`SKILL.md` → strip .md → lowercase), then the flat-file branch
 * saved into `$DSH_HOME/skills/skill.md` instead of the real skill name.
 */
function suggestGitName(url: string, subPath: string): string {
  const segments = subPath.split('/').filter(s => s !== '' && s !== '.')
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]
    // `SKILL.md` (case-insensitive) is the reserved bundle filename — its
    // parent directory is the meaningful identity, so skip past it.
    if (/^SKILL\.md$/i.test(seg)) continue
    const stripped = seg.replace(/\.md$/i, '')
    const kebab = kebabize(stripped)
    if (kebab !== '') return kebab
  }
  const trimmed = url.replace(/\.git$/i, '').replace(/[?#].*$/, '')
  const tail = trimmed.split(/[/:]/).filter(s => s !== '').pop() ?? ''
  return kebabize(tail)
}

/**
 * "工作台技能" section: rendered below the user-editable groups. Reads live
 * from ctx.skills via the Host `/skills` route, and lets the user install
 * new skill markdown files two ways:
 *
 *   - Inline: type a Markdown body; the Host wraps it in a YAML frontmatter
 *     carrying name + description and writes to $DSH_HOME/skills/<name>/.
 *   - Git import: clone a repo (shallow, http/https/ssh only) and copy the
 *     skill body at <subPath> into $DSH_HOME/skills/<name>/. Both bundle
 *     form (SKILL.md + assets) and flat form (a single *.md file) are
 *     accepted.
 *
 * Removal is only offered for skills the workbench itself owns (Host reports
 * `removable: true`), so project-scoped and bundled skills stay read-only.
 */
/**
 * Persistent success notice displayed at the top of the skills section after
 * a successful install / import. Persists until the user dismisses it (✕)
 * or hits "刷新" — the previous transient banner disappeared with the form
 * before the user could read the `writtenTo` path.
 *
 * `installed` is the primary display: single-item for bundle/flat imports,
 * multi-item for batch imports (a repo with several `<child>/SKILL.md`).
 */
interface SkillNotice {
  installed: string[]
  skipped?: Array<{ name: string; reason: string }>
  writtenTo?: string
  gitOutput?: string
  /** Set by the per-skill update flow when the source head was unchanged. */
  unchanged?: boolean
  /** Skill name for the unchanged notice. */
  unchangedName?: string
  sha?: string
}

function SkillsSection(props: {
  skills: WorkbenchSkillList | null
  skillsLoading: boolean
  /** Panel search draft — reused to filter skill names/descriptions inline. */
  query: string
  installSkill: WorkbenchInjected['installSkill']
  importSkill: WorkbenchInjected['importSkill']
  updateSkill: WorkbenchInjected['updateSkill']
  loadSkillSource: WorkbenchInjected['loadSkillSource']
  onUse: (name: string) => void
  onRemove: (name: string) => void
  onReload: () => void
}) {
  const { skills, skillsLoading, query, installSkill, importSkill, updateSkill, loadSkillSource, onUse, onRemove, onReload } = props
  const [showForm, setShowForm] = useState(false)
  const [mode, setMode] = useState<SkillFormMode>('inline')
  const [inlineDraft, setInlineDraft] = useState<SkillInlineDraft>(emptyInlineDraft)
  const [gitDraft, setGitDraft] = useState<SkillGitDraft>(emptyGitDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<SkillNotice | null>(null)
  /** Name of the skill currently running 检查更新 (P3-21). */
  const [updatingSkill, setUpdatingSkill] = useState<string | null>(null)
  /** Open panel editor state (P3-23): the skill being edited + its raw body. */
  const [editSkill, setEditSkill] = useState<{ name: string; content: string } | null>(null)
  const [loadingSource, setLoadingSource] = useState(false)

  const filtered = (skills?.skills ?? []).filter(s =>
    query === ''
    || s.name.toLowerCase().includes(query)
    || s.description.toLowerCase().includes(query))

  // How many of the just-installed skills are already visible in the current
  // catalog. Displayed on the success notice so the user can tell at a
  // glance whether dsh-skill-filesystem noticed the writes, or whether they
  // need to hit "刷新" (or wait for chokidar to invalidate).
  const catalogNames = new Set((skills?.skills ?? []).map(s => s.name))
  const noticedCount = notice === null
    ? 0
    : notice.installed.filter(name => catalogNames.has(name)).length
  const allNoticedInCatalog = notice !== null && noticedCount === notice.installed.length

  /** Per-skill "检查更新" (roadmap P3-21): re-clone the origin, apply changes. */
  const submitSkillUpdate = async (name: string): Promise<void> => {
    setUpdatingSkill(name)
    setError(null)
    try {
      const result = await updateSkill(name)
      if (result.changed === true) {
        setNotice({
          installed: result.installed !== undefined && result.installed.length > 0 ? result.installed : [name],
          ...(result.sha !== undefined ? { sha: result.sha } : {}),
        })
      } else {
        setNotice({ installed: [], unchanged: true, unchangedName: name, ...(result.sha !== undefined ? { sha: result.sha } : {}) })
      }
      onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdatingSkill(null)
    }
  }

  /** Open the panel editor with a managed skill's raw body (roadmap P3-23). */
  const startEditSkill = async (name: string): Promise<void> => {
    setLoadingSource(true)
    setError(null)
    try {
      const source = await loadSkillSource(name)
      if (source.ok === true && source.content !== undefined) {
        setEditSkill({ name, content: source.content })
        setShowForm(false)
      } else {
        setError(source.error ?? `读取「${name}」失败`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingSource(false)
    }
  }

  /** Save the panel editor back through the install route (overwrites in place). */
  const submitSkillEdit = async (): Promise<void> => {
    if (editSkill === null) return
    if (editSkill.content.trim() === '') {
      setError('技能正文不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await installSkill({ name: editSkill.name, content: editSkill.content })
      setNotice({ installed: [editSkill.name] })
      setEditSkill(null)
      onReload()
    } catch (err) {
      // Keep the editor open on failure so the user can retry without retyping.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitInline = async (): Promise<void> => {
    const name = inlineDraft.name.trim()
    const content = inlineDraft.content.trim()
    if (name === '') { setError('技能名称不能为空'); return }
    if (content === '') { setError('技能正文不能为空'); return }
    setBusy(true)
    setError(null)
    try {
      const result = await installSkill({ name, content: composeInlineSkill(inlineDraft) })
      setInlineDraft(emptyInlineDraft())
      setShowForm(false)
      setNotice({ installed: [name], writtenTo: result.writtenTo })
      onReload()
    } catch (err) {
      // Keep the form open on failure so the user can retry without retyping.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitGit = async (): Promise<void> => {
    const url = gitDraft.url.trim()
    if (url === '') { setError('Git 仓库地址不能为空'); return }
    const name = gitDraft.name.trim() !== '' ? gitDraft.name.trim() : suggestGitName(url, gitDraft.subPath)
    if (name === '') { setError('目标名称不能为空（无法从 URL 与子路径推断）'); return }
    setBusy(true)
    setError(null)
    try {
      const result = await importSkill({
        url,
        name,
        ...(gitDraft.subPath.trim() !== '' ? { subPath: gitDraft.subPath.trim() } : {}),
        ...(gitDraft.ref.trim() !== '' ? { ref: gitDraft.ref.trim() } : {}),
      })
      setGitDraft(emptyGitDraft())
      setShowForm(false)
      // Batch imports return an array of installed names; single-skill
      // imports return a one-element array. Either way `installed` is
      // authoritative — the user-typed `name` is ignored for batch.
      setNotice({
        installed: result.installed && result.installed.length > 0 ? result.installed : [name],
        ...(result.skipped !== undefined && result.skipped.length > 0 ? { skipped: result.skipped } : {}),
        ...(result.writtenTo !== undefined ? { writtenTo: result.writtenTo } : {}),
        ...(result.output !== undefined && result.output !== '' ? { gitOutput: result.output } : {}),
      })
      onReload()
    } catch (err) {
      // Preserve the git draft so the user can adjust one field and retry.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css.skills} aria-label="工作台技能">
      <div className={css.skillsHead}>
        <h2 className={css.groupTitle}>工作台技能</h2>
        <span className={css.skillsTools}>
          {skillsLoading && <span className={css.skillsMeta}>加载中…</span>}
          {skills?.complete === false && !skillsLoading && (
            <span className={css.skillsMeta} title="部分技能提供者未完成发现">部分</span>
          )}
          <Button
            size="sm"
            variant={showForm ? 'primary' : 'outline'}
            onClick={() => { setShowForm(v => !v); setError(null) }}
            disabled={busy}
          >
            {showForm ? '取消' : '+ 新建技能'}
          </Button>
        </span>
      </div>

      {showForm && (
        <div className={css.skillsForm}>
          <div className={css.skillsTabs} role="tablist">
            <Button
              size="sm"
              variant={mode === 'inline' ? 'primary' : 'outline'}
              onClick={() => { setMode('inline'); setError(null) }}
              disabled={busy}
              role="tab"
              aria-selected={mode === 'inline'}
            >
              手写正文
            </Button>
            <Button
              size="sm"
              variant={mode === 'git' ? 'primary' : 'outline'}
              onClick={() => { setMode('git'); setError(null) }}
              disabled={busy}
              role="tab"
              aria-selected={mode === 'git'}
            >
              从 Git 仓库导入
            </Button>
          </div>

          {mode === 'inline' && (
            <>
              <Input
                placeholder="kebab-case 名称（如 whaletv-build-mp）"
                value={inlineDraft.name}
                onChange={event => { setInlineDraft(d => ({ ...d, name: event.target.value })) }}
              />
              <Input
                placeholder="一行描述（模型看得到的路由提示）"
                value={inlineDraft.description}
                onChange={event => { setInlineDraft(d => ({ ...d, description: event.target.value })) }}
              />
              <textarea
                className={css.skillsTextarea}
                placeholder={'技能正文（Markdown）\n\n可以粘贴现有 SKILL.md 的正文；工作台会自动加上 name + description 的 YAML frontmatter。'}
                value={inlineDraft.content}
                onChange={event => { setInlineDraft(d => ({ ...d, content: event.target.value })) }}
                rows={10}
              />
            </>
          )}

          {mode === 'git' && (
            <>
              <Input
                placeholder="Git 仓库地址（如 https://github.com/user/skills.git 或 git@github.com:user/skills.git）"
                value={gitDraft.url}
                onChange={event => { setGitDraft(d => ({ ...d, url: event.target.value })) }}
              />
              <div className={css.formRow}>
                <Input
                  placeholder="分支 / tag / 提交 SHA（可选，默认默认分支）"
                  value={gitDraft.ref}
                  onChange={event => { setGitDraft(d => ({ ...d, ref: event.target.value })) }}
                />
                <Input
                  placeholder="仓库内子路径（可选，如 commit-message 或 skills/foo.md）"
                  value={gitDraft.subPath}
                  onChange={event => { setGitDraft(d => ({ ...d, subPath: event.target.value })) }}
                />
              </div>
              <Input
                placeholder={`目标名称（可选，留空自动推断为「${suggestGitName(gitDraft.url, gitDraft.subPath) || 'skill-name'}」）`}
                value={gitDraft.name}
                onChange={event => { setGitDraft(d => ({ ...d, name: event.target.value })) }}
              />
              <p className={css.skillsHelp}>
                子路径可以指向：<br/>
                &nbsp;• 一个 <strong>包含 SKILL.md 的目录</strong>（bundle，assets/refs 一起复制）<br/>
                &nbsp;• 一个 <strong>SKILL.md 文件</strong>（自动上溯一级作为 bundle）<br/>
                &nbsp;• 一个 <strong>flat 的 *.md 文件</strong>（单文件安装）<br/>
                &nbsp;• 一个 <strong>目录，下面每个子目录各有 SKILL.md</strong>（<em>批量安装</em>，"目标名称"会被忽略，每个子目录用自己名字挂载）<br/>
                留空 = 仓库根目录同上判定。仅接受 http(s) / ssh 协议。
              </p>
              <p className={css.skillsHelp}>
                <strong>私有仓库</strong>：工作台子进程没有交互终端，无法弹凭据框。请任选一种：
                （a）先在命令行手动 <code>git clone</code> 一次同一仓库，让 Git Credential Manager 缓存凭据；
                （b）改用 SSH 地址（<code>git@host:owner/repo.git</code>）+ 配置好的 SSH key；
                （c）临时用 <code>https://&lt;user&gt;:&lt;token&gt;@host/...</code> 格式内嵌 PAT。
              </p>
            </>
          )}

          {error !== null && <p className={css.skillsError} role="alert">{error}</p>}
          <div className={css.formActions}>
            <Button
              size="sm"
              variant="primary"
              onClick={() => { void (mode === 'inline' ? submitInline() : submitGit()) }}
              disabled={busy}
            >
              {busy ? (mode === 'git' ? '克隆中…' : '安装中…') : (mode === 'git' ? '克隆并安装' : '安装到 $DSH_HOME/skills')}
            </Button>
          </div>
        </div>
      )}

      {editSkill !== null && (
        <div className={css.skillsForm}>
          <div className={css.checkHead}>
            <span>
              编辑技能「{editSkill.name}」<span className={css.checkMeta}>（保存后原文件被覆盖；YAML frontmatter 一并编辑）</span>
            </span>
            <span className={css.spacer} />
            <Button size="sm" className={css.dismiss} onClick={() => { setEditSkill(null) }} aria-label="关闭编辑器" disabled={busy}>✕</Button>
          </div>
          <textarea
            className={css.skillsTextarea}
            placeholder="SKILL.md 全文（含 frontmatter）"
            value={editSkill.content}
            onChange={event => { setEditSkill(prev => prev === null ? prev : { ...prev, content: event.target.value }) }}
            rows={16}
            disabled={busy}
          />
          <div className={css.formActions}>
            <Button size="sm" variant="primary" onClick={() => { void submitSkillEdit() }} disabled={busy}>
              {busy ? '保存中…' : '保存覆盖'}
            </Button>
            <Button size="sm" onClick={() => { setEditSkill(null) }} disabled={busy}>取消</Button>
          </div>
        </div>
      )}

      {notice !== null && (
        <div className={css.skillsSuccess} role="status">
          <div className={css.skillsSuccessHead}>
            <p className={css.skillsSuccessTitle}>
              ✓ {notice.unchanged === true
                ? `「${notice.unchangedName}」已是最新${notice.sha !== undefined ? `（${notice.sha}）` : ''}`
                : notice.installed.length === 1
                  ? `技能「${notice.installed[0]}」已${allNoticedInCatalog ? '安装并挂载' : '写入磁盘'}`
                  : `已批量导入 ${notice.installed.length} 个技能${allNoticedInCatalog ? '，全部已挂载' : `（其中 ${noticedCount} 个已挂载）`}`}
            </p>
            <Button
              size="sm"
              className={css.dismiss}
              onClick={() => { setNotice(null) }}
              aria-label="关闭提示"
            >
              ✕
            </Button>
          </div>
          {notice.installed.length > 1 && (
            <p className={css.skillsSuccessDetail}>
              {notice.installed.map(n => (
                <code key={n} style={{ marginRight: 6 }}>{n}</code>
              ))}
            </p>
          )}
          {notice.writtenTo !== undefined && (
            <p className={css.skillsSuccessDetail}>
              {notice.installed.length === 1 ? '文件位置' : '安装到'}：<code>{notice.writtenTo}</code>
            </p>
          )}
          {notice.skipped !== undefined && notice.skipped.length > 0 && (
            <div className={css.skillsSuccessDetail}>
              以下条目被跳过：
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {notice.skipped.map(s => (
                  <li key={s.name}><code>{s.name}</code> — {s.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {!allNoticedInCatalog && (
            <p className={css.skillsSuccessDetail}>
              dsh 技能注册表还没抓到全部新增；点顶部「刷新」按钮或稍候几秒让 chokidar 触发 —— 如果仍然看不到，说明 dsh 里没挂 <code>dsh-skill-filesystem</code>（跑 <code>dsh --profile web --dump-config</code> 确认）。
            </p>
          )}
          {notice.gitOutput !== undefined && (
            <pre className={css.skillsOutput}>{notice.gitOutput}</pre>
          )}
        </div>
      )}

      {skills?.ok === false && skills.error !== undefined && (
        <p className={css.skillsError} role="alert">技能列表读取失败：{skills.error}</p>
      )}

      {skills?.ok === true && filtered.length === 0 && !skillsLoading && notice === null && (
        <p className={css.hint}>
          {query === '' ? '当前没有可用的技能。点击「+ 新建技能」写入一份，或从 Git 仓库导入。' : '没有匹配的技能。'}
        </p>
      )}

      <div className={css.grid}>
        {filtered.map((skill: WorkbenchSkillSummary) => (
          <div key={`${skill.provider}:${skill.name}`} className={css.item}>
            <div className={css.itemHead}>
              <span className={css.itemTitle}>{skill.name}</span>
              <span className={css.badge} title={`来源：${skill.source}｜提供者：${skill.provider}`}>{skill.source}</span>
            </div>
            <p className={css.itemDesc}>{skill.description}</p>
            {skill.whenToUse !== undefined && skill.whenToUse !== '' && (
              <p className={css.itemDesc}><em>用途：</em>{skill.whenToUse}</p>
            )}
            {skill.origin !== undefined && (
              <p className={css.checkMeta} title={skill.origin.sourceUrl ?? '手写技能'}>
                来源：{skill.origin.sourceUrl ?? '手写'}
                {skill.origin.sha !== undefined ? ` @ ${skill.origin.sha}` : ''}
                {` · ${skill.origin.installedAt.slice(0, 10)}`}
              </p>
            )}
            <div className={css.itemActions}>
              <Button size="sm" variant="outline" onClick={() => { onUse(skill.name) }}>使用</Button>
              {skill.removable && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void startEditSkill(skill.name) }}
                  disabled={loadingSource || updatingSkill !== null}
                  title="在工作台内编辑该技能的 SKILL.md 全文"
                >
                  {loadingSource === true ? '读取中…' : '编辑'}
                </Button>
              )}
              {skill.origin?.sourceUrl !== undefined && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void submitSkillUpdate(skill.name) }}
                  disabled={updatingSkill !== null}
                  title="重新克隆来源仓库并应用新提交"
                >
                  {updatingSkill === skill.name ? '检查中…' : '检查更新'}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
