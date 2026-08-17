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
import type { MouseEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { WorkbenchInjected, WorkbenchPanelProps } from './contract.ts'
import type {
  WorkbenchConfig, WorkbenchGroup, WorkbenchItem, WorkbenchSkillList, WorkbenchSkillSummary,
} from '../shared.ts'
import { WORKBENCH_ICON } from './icon.ts'
import css from './WorkbenchPanel.module.css'

/** The one action label each entry kind drives. */
function actionLabel(item: WorkbenchItem): string {
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

/** One entry card: title, description, and its kind-specific actions (or the inline form in edit mode). */
function ItemCard(props: {
  item: WorkbenchItem
  editMode: boolean
  editing: boolean
  draft: ItemFormDraft
  saving: boolean
  onDraftChange: (patch: Partial<ItemFormDraft>) => void
  onSaveDraft: () => void
  onCancelDraft: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenUrl: (url: string) => void
  onOpenPath: (path: string) => void
  onUseSkill: (prompt: string) => void
  onCopy: (prompt: string) => void
}) {
  const {
    item, editMode, editing, draft, saving,
    onDraftChange, onSaveDraft, onCancelDraft, onEdit, onDelete,
    onOpenUrl, onOpenPath, onUseSkill, onCopy,
  } = props
  const configured = isConfigured(item)

  const head = (
    <div className={css.itemHead}>
      <span className={css.itemTitle}>{item.title}</span>
      {!configured && <span className={css.badge}>待配置</span>}
    </div>
  )
  if (editing) {
    return (
      <div className={css.item}>
        {head}
        <ItemForm draft={draft} saving={saving} onChange={onDraftChange} onSave={onSaveDraft} onCancel={onCancelDraft} />
      </div>
    )
  }
  return (
    <div className={css.item}>
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
  loadSkills,
  installSkill,
  importSkill,
  removeSkill,
  followup,
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

  const [editMode, setEditMode] = useState(false)
  const [editing, setEditing] = useState<ItemEditing | null>(null)
  const [groupTitleEdit, setGroupTitleEdit] = useState<string | null>(null)
  const [groupTitleDraft, setGroupTitleDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

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
   */
  const reloadSkills = useCallback(async () => {
    actions.setSkillsLoading(true)
    try {
      const next = await loadSkills()
      actions.setSkills(next)
    } catch (error) {
      actions.setSkills({
        ok: false, skills: [], complete: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      actions.setSkillsLoading(false)
    }
  }, [actions, loadSkills])

  const runUpdate = useCallback(async () => {
    clearDismissTimer()
    actions.setUpdating(true)
    actions.setUpdateLog('')
    actions.setLastResult(null)
    try {
      const result = await update()
      if (result.changed === true) {
        actions.setUpdateLog(result.output ?? '')
        actions.setLastResult(
          result.rebuilt === true
            ? '更新完成并已热注入，界面将自动刷新。若本次更新涉及服务端改动，请重启 dsh。'
            : '已拉取到最新提交（无需重建）。',
        )
        void reload()
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
  }, [actions, update, reload, clearDismissTimer])

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
    const { groupId, itemId, draft } = editing
    if (draft.title.trim() === '') {
      setSaveError('条目名称不能为空')
      return
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
  // an independent registry and neither blocks the other's render.
  useEffect(() => {
    if (!open) return
    void reload()
    void reloadSkills()
  }, [open, reload, reloadSkills])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') actions.setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open, actions])

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
   * "Use skill" flow: prime a fresh session with a request to invoke the
   * named skill. The dsh `skill({name})` tool then loads its body on model
   * demand — no need to shove the whole markdown into the composer.
   */
  const handleSkillUse = async (skillName: string): Promise<void> => {
    const invocation = `请调用技能：${skillName}`
    const result = await followup(invocation).catch(() => ({ ok: false as const }))
    if (!result.ok) {
      await handleCopy(invocation)
      startSession()
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
  const onBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) actions.setOpen(false)
  }

  if (!open) return null

  const query = search.trim().toLowerCase()
  const groups = (state?.config.groups ?? []).map(group => ({
    ...group,
    items: query === ''
      ? group.items
      : group.items.filter(item =>
        item.title.toLowerCase().includes(query)
        || (item.description ?? '').toLowerCase().includes(query)),
  })).filter(group => group.items.length > 0)

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
          <Button size="sm" onClick={() => { void reload(); void reloadSkills() }} disabled={updating || saving}>刷新</Button>
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

        <div className={css.search}>
          <Input
            placeholder="搜索网页 / 文档 / 应用 / 技能…"
            value={search}
            onChange={event => { actions.setSearch(event.target.value) }}
          />
        </div>

        <div className={css.body}>
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
              <div className={css.grid}>
                {group.items.map(item => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    editMode={editMode}
                    editing={editMode && editing !== null && editing.groupId === group.id && editing.itemId === item.id}
                    draft={editing?.draft ?? emptyDraft()}
                    saving={saving}
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
                  />
                ))}
                {editMode && editing !== null && editing.groupId === group.id && editing.itemId === null && (
                  <div className={css.item}>
                    <div className={css.itemHead}>
                      <span className={css.itemTitle}>新条目</span>
                    </div>
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
            </div>
          )}
          <SkillsSection
            skills={skills}
            skillsLoading={skillsLoading}
            query={query}
            installSkill={installSkill}
            importSkill={importSkill}
            onUse={(name) => { void handleSkillUse(name) }}
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

/**
 * Guess a kebab-case target name from a git URL + sub-path when the user
 * hasn't picked one yet: prefer the sub-path leaf, fall back to the repo
 * name (strip `.git` and any URL fragment).
 */
function suggestGitName(url: string, subPath: string): string {
  const leaf = subPath.split('/').filter(s => s !== '' && s !== '.').pop()
  if (leaf !== undefined && leaf !== '') {
    return leaf.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  }
  const trimmed = url.replace(/\.git$/i, '').replace(/[?#].*$/, '')
  const tail = trimmed.split(/[/:]/).filter(s => s !== '').pop() ?? ''
  return tail.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
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
function SkillsSection(props: {
  skills: WorkbenchSkillList | null
  skillsLoading: boolean
  /** Panel search draft — reused to filter skill names/descriptions inline. */
  query: string
  installSkill: WorkbenchInjected['installSkill']
  importSkill: WorkbenchInjected['importSkill']
  onUse: (name: string) => void
  onRemove: (name: string) => void
  onReload: () => void
}) {
  const { skills, skillsLoading, query, installSkill, importSkill, onUse, onRemove, onReload } = props
  const [showForm, setShowForm] = useState(false)
  const [mode, setMode] = useState<SkillFormMode>('inline')
  const [inlineDraft, setInlineDraft] = useState<SkillInlineDraft>(emptyInlineDraft)
  const [gitDraft, setGitDraft] = useState<SkillGitDraft>(emptyGitDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)

  const filtered = (skills?.skills ?? []).filter(s =>
    query === ''
    || s.name.toLowerCase().includes(query)
    || s.description.toLowerCase().includes(query))

  const submitInline = async (): Promise<void> => {
    const name = inlineDraft.name.trim()
    const content = inlineDraft.content.trim()
    if (name === '') { setError('技能名称不能为空'); return }
    if (content === '') { setError('技能正文不能为空'); return }
    setBusy(true)
    setError(null)
    setOutput(null)
    try {
      await installSkill({ name, content: composeInlineSkill(inlineDraft) })
      setInlineDraft(emptyInlineDraft())
      setShowForm(false)
      onReload()
    } catch (err) {
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
    setOutput(null)
    try {
      const result = await importSkill({
        url,
        name,
        ...(gitDraft.subPath.trim() !== '' ? { subPath: gitDraft.subPath.trim() } : {}),
        ...(gitDraft.ref.trim() !== '' ? { ref: gitDraft.ref.trim() } : {}),
      })
      if (result.output !== undefined && result.output !== '') setOutput(result.output)
      setGitDraft(emptyGitDraft())
      setShowForm(false)
      onReload()
    } catch (err) {
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
            onClick={() => { setShowForm(v => !v); setError(null); setOutput(null) }}
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
              onClick={() => { setMode('inline'); setError(null); setOutput(null) }}
              disabled={busy}
              role="tab"
              aria-selected={mode === 'inline'}
            >
              手写正文
            </Button>
            <Button
              size="sm"
              variant={mode === 'git' ? 'primary' : 'outline'}
              onClick={() => { setMode('git'); setError(null); setOutput(null) }}
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
                支持两种形态：<code>&lt;subPath&gt;/SKILL.md</code>（bundle，会连同 assets 一起复制）或
                <code>&lt;subPath&gt;.md</code>（flat，单文件）。仅接受 http(s) / ssh 协议。
              </p>
            </>
          )}

          {error !== null && <p className={css.skillsError} role="alert">{error}</p>}
          {output !== null && output !== '' && (
            <pre className={css.skillsOutput}>{output}</pre>
          )}
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

      {skills?.ok === false && skills.error !== undefined && (
        <p className={css.skillsError} role="alert">技能列表读取失败：{skills.error}</p>
      )}

      {skills?.ok === true && filtered.length === 0 && !skillsLoading && (
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
            <div className={css.itemActions}>
              <Button size="sm" variant="outline" onClick={() => { onUse(skill.name) }}>使用</Button>
              {skill.removable && (
                <Button size="sm" variant="outline" className={css.danger} onClick={() => { onRemove(skill.name) }}>
                  删除
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
