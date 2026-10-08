/**
 * The WhaleTV workbench dashboard, registered into `shell.overlay`: a centered
 * panel over a click-to-close backdrop with grouped entry cards (web / docs /
 * apps / skills), search, in-panel config editing (edit mode), and the
 * one-click self-update flow.
 *
 * This file is the shell: store reads, hook orchestration and the JSX. The
 * domains live in `panel/` — pure entry helpers, the extracted components
 * (ItemForm / ItemCard / RecentBar / UpdateCheckBanner / ConfirmDialog) and
 * the domain hooks (usePanelData / useUpdateFlow / useEntriesEditing).
 * Everything arrives through the props shares (owner → runtime,
 * store → useStore/actions, inject → Host actions); no cordis imports, no
 * React context.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Button, Input, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { WorkbenchPanelProps } from './contract.ts'
import type { WorkbenchItem, WorkbenchUpdateProgress } from '../shared.ts'
import { WORKBENCH_ICON } from './icon.ts'
import css from './WorkbenchPanel.module.css'
import { SkillsSection } from './SkillsSection.tsx'
import { ConfirmDialog } from './panel/ConfirmDialog.tsx'
import type { ConfirmRequest } from './panel/ConfirmDialog.tsx'
import { ItemCard } from './panel/ItemCard.tsx'
import { ItemForm } from './panel/ItemForm.tsx'
import { RecentBar } from './panel/RecentBar.tsx'
import { UpdateCheckBanner } from './panel/UpdateCheckBanner.tsx'
import { entryTarget, emptyDraft } from './panel/entry-helpers.ts'
import { takeReopenAfterRebuild } from './panel/notices.ts'
import { usePanelData } from './panel/usePanelData.ts'
import { useUpdateFlow } from './panel/useUpdateFlow.ts'
import { useEntriesEditing } from './panel/useEntriesEditing.ts'

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
  skipUpdate,
  rollbackUpdate,
  loadUsage,
  recordUsage,
  checkHealth,
  loadSkills,
  installSkill,
  importSkill,
  updateSkill,
  marketSearch,
  marketDetail,
  marketInstall,
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

  /** Search keyboard-navigation cursor into the flat match list (P2-14). */
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  /** The one open confirmation dialog (replaces window.confirm/alert). */
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
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

  // Data loading domain: the reload family plus usage/health snapshots.
  const {
    reload, reloadSkills, reloadHistory, reloadUsage,
    usage, health, healthBusy, runHealth,
  } = usePanelData({ actions, loadState, loadSkills, loadUpdateHistory, loadUsage, checkHealth })

  // Update flow domain: 检查更新/更新/跳过/回滚 + progress poll + auto-dismiss.
  const {
    runUpdate, runCheck, runSkip, runRollback, progress, dismissResult,
  } = useUpdateFlow({
    actions, updating, checkResult, lastResult, updateHistory,
    update, checkUpdate, skipUpdate, rollbackUpdate, loadProgress,
    reload, reloadHistory, askConfirm,
  })

  // Entry/group editing domain: edit mode, drafts, persistence, drag-reorder.
  const {
    editMode, editing, setEditing, groupTitleEdit, setGroupTitleEdit, groupTitleDraft, setGroupTitleDraft,
    saving, saveError, setSaveError,
    toggleEditMode, startAddItem, startEditItem, cancelDraft, submitDraft,
    deleteItem, startRenameGroup, submitRenameGroup, deleteGroup, addGroup,
    draggingId, dragOverId, dragOverGroupId,
    handleDragStartItem, handleDragEnterItem, handleDropOnItem, handleDropOnGroup,
    handleGridDragOver, handleGridDragLeave, handleDragEndItem, moveItemBy,
  } = useEntriesEditing({ state, saveConfig, reload, askConfirm })

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
  const liveProgress: WorkbenchUpdateProgress | null = updating && progress?.running === true ? progress : null

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
                      <Button size="sm" variant="outline" className={css.danger} onClick={() => { deleteGroup(group) }} disabled={saving}>删除分组</Button>
                    </span>
                  )}
                </div>
              )}
              <div
                className={clsx(css.grid, dragOverGroupId === group.id && css.gridDropActive)}
                onDragOver={event => { handleGridDragOver(group.id, event) }}
                onDragLeave={event => { handleGridDragLeave(group.id, event) }}
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
                    onDelete={() => { deleteItem(group.id, item) }}
                    onOpenUrl={url => { openUrl(url) }}
                    onOpenPath={path => { void handleOpenPath(path) }}
                    onUseSkill={prompt => { void handleUseSkill(prompt) }}
                    onCopy={prompt => { void handleCopy(prompt) }}
                    onDragStartItem={() => { handleDragStartItem(group.id, item.id) }}
                    onDragEnterItem={() => { handleDragEnterItem(item.id) }}
                    onDropOnItem={() => { void handleDropOnItem(group.id, item) }}
                    onDragEndItem={handleDragEndItem}
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
            marketSearch={marketSearch}
            marketDetail={marketDetail}
            marketInstall={marketInstall}
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
      <ConfirmDialog request={confirmRequest} onClose={closeConfirm} />
    </div>
  )
}
