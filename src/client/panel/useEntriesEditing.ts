/**
 * Entry/group editing domain (v0.8.16 split): edit mode state, draft forms,
 * config persistence, drag-reorder plumbing and the keyboard-reachable
 * reorder. Every mutation persists immediately through the Host saveConfig
 * route, then re-reads via reload.
 */
import { useCallback, useRef, useState } from 'react'
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react'
import type { WorkbenchConfig, WorkbenchGroup, WorkbenchItem, WorkbenchState } from '../../shared.ts'
import { draftFromItem, emptyDraft, genId, itemFromDraft, moveItem, moveWithinGroup } from './entry-helpers.ts'
import type { ItemEditing } from './entry-helpers.ts'
import type { WorkbenchPanelProps } from '../contract.ts'

export interface UseEntriesEditingOptions {
  /** The store's state snapshot; null before the first load. */
  state: WorkbenchState | null
  saveConfig: WorkbenchPanelProps['saveConfig']
  reload: () => Promise<void>
  /** The panel's confirmation dialog (delete confirmations). */
  askConfirm: (request: { title: string; description: string; confirmLabel: string; cancelLabel: string | null; danger?: boolean; onConfirm: () => void }) => void
}

export function useEntriesEditing(options: UseEntriesEditingOptions): {
  editMode: boolean
  editing: ItemEditing | null
  setEditing: Dispatch<SetStateAction<ItemEditing | null>>
  groupTitleEdit: string | null
  setGroupTitleEdit: Dispatch<SetStateAction<string | null>>
  groupTitleDraft: string
  setGroupTitleDraft: Dispatch<SetStateAction<string>>
  saving: boolean
  saveError: string | null
  setSaveError: (error: string | null) => void
  toggleEditMode: () => void
  startAddItem: (groupId: string) => void
  startEditItem: (groupId: string, item: WorkbenchItem) => void
  cancelDraft: () => void
  submitDraft: () => Promise<void>
  deleteItem: (groupId: string, item: WorkbenchItem) => void
  startRenameGroup: (group: WorkbenchGroup) => void
  submitRenameGroup: (groupId: string) => Promise<void>
  deleteGroup: (group: WorkbenchGroup) => void
  addGroup: () => Promise<void>
  draggingId: string | null
  dragOverId: string | null
  dragOverGroupId: string | null
  handleDragStartItem: (groupId: string, itemId: string) => void
  handleDragEnterItem: (itemId: string) => void
  handleDropOnItem: (targetGroupId: string, targetItem: WorkbenchItem) => Promise<void>
  handleDropOnGroup: (targetGroupId: string) => Promise<void>
  handleGridDragOver: (groupId: string, event: ReactMouseEvent<HTMLDivElement>) => void
  handleGridDragLeave: (groupId: string, event: ReactMouseEvent<HTMLDivElement>) => void
  handleDragEndItem: () => void
  moveItemBy: (groupId: string, item: WorkbenchItem, delta: number) => Promise<void>
} {
  const { state, saveConfig, reload, askConfirm } = options

  const [editMode, setEditMode] = useState(false)
  const [editing, setEditing] = useState<ItemEditing | null>(null)
  const [groupTitleEdit, setGroupTitleEdit] = useState<string | null>(null)
  const [groupTitleDraft, setGroupTitleDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Item currently being drag-reordered (P2-15). */
  const dragRef = useRef<{ groupId: string; itemId: string } | null>(null)
  /** Drag visuals: the source card and the current hover target. */
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null)

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

  const startAddItem = useCallback((groupId: string): void => {
    setEditing({ groupId, itemId: null, draft: emptyDraft() })
  }, [])
  const startEditItem = useCallback((groupId: string, item: WorkbenchItem): void => {
    setEditing({ groupId, itemId: item.id, draft: draftFromItem(item) })
  }, [])
  const cancelDraft = useCallback((): void => { setEditing(null) }, [])

  const submitDraft = useCallback(async (): Promise<void> => {
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
  }, [state, editing, persistConfig])

  const performDeleteItem = useCallback(async (groupId: string, item: WorkbenchItem): Promise<void> => {
    if (state === null) return
    const next: WorkbenchConfig = {
      groups: state.config.groups.map(group => (
        group.id !== groupId ? group : { ...group, items: group.items.filter(i => i.id !== item.id) }
      )),
    }
    await persistConfig(next)
  }, [state, persistConfig])

  const deleteItem = useCallback((groupId: string, item: WorkbenchItem): void => {
    if (state === null) return
    askConfirm({
      title: '删除条目',
      description: `确定删除「${item.title}」？此操作立即写入 workbench.json。`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performDeleteItem(groupId, item) },
    })
  }, [state, askConfirm, performDeleteItem])

  const startRenameGroup = useCallback((group: WorkbenchGroup): void => {
    setGroupTitleEdit(group.id)
    setGroupTitleDraft(group.title)
  }, [])

  const performDeleteGroup = useCallback(async (group: WorkbenchGroup): Promise<void> => {
    if (state === null) return
    const next: WorkbenchConfig = { groups: state.config.groups.filter(g => g.id !== group.id) }
    if (await persistConfig(next)) {
      if (editing !== null && editing.groupId === group.id) setEditing(null)
      if (groupTitleEdit === group.id) {
        setGroupTitleEdit(null)
        setGroupTitleDraft('')
      }
    }
  }, [state, persistConfig, editing, groupTitleEdit])

  const submitRenameGroup = useCallback(async (groupId: string): Promise<void> => {
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
  }, [state, groupTitleDraft, persistConfig])

  const deleteGroup = useCallback((group: WorkbenchGroup): void => {
    if (state === null) return
    askConfirm({
      title: '删除分组',
      description: `确定删除分组「${group.title}」及其 ${group.items.length} 个条目？`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      danger: true,
      onConfirm: () => { void performDeleteGroup(group) },
    })
  }, [state, askConfirm, performDeleteGroup])

  const addGroup = useCallback(async (): Promise<void> => {
    if (state === null) return
    const group: WorkbenchGroup = { id: genId('group'), title: '新分组', items: [] }
    const next: WorkbenchConfig = { groups: [...state.config.groups, group] }
    if (await persistConfig(next)) startRenameGroup(group)
  }, [state, persistConfig, startRenameGroup])

  // Drag-reorder plumbing (roadmap P2-15): the payload rides a ref (no data
  // transfer needed inside one document); drops land on a card (insert
  // before it) or a group body (append). The visible drag state lives in
  // React state so the source card and the hover target can be styled, and
  // dragend clears everything even when the drop missed every target.
  const clearDragState = useCallback((): void => {
    dragRef.current = null
    setDraggingId(null)
    setDragOverId(null)
    setDragOverGroupId(null)
  }, [])
  const handleDragStartItem = useCallback((groupId: string, itemId: string): void => {
    dragRef.current = { groupId, itemId }
    setDraggingId(itemId)
  }, [])
  const handleDragEnterItem = useCallback((itemId: string): void => {
    setDragOverId(itemId)
  }, [])
  const handleDropOnItem = useCallback(async (targetGroupId: string, targetItem: WorkbenchItem): Promise<void> => {
    const drag = dragRef.current
    clearDragState()
    if (state === null || drag === null || drag.itemId === targetItem.id) return
    const next = moveItem(state.config, drag, targetGroupId, targetItem.id)
    if (next !== null) await persistConfig(next)
  }, [state, persistConfig, clearDragState])
  const handleDropOnGroup = useCallback(async (targetGroupId: string): Promise<void> => {
    const drag = dragRef.current
    clearDragState()
    if (state === null || drag === null || drag.groupId === targetGroupId) return
    const next = moveItem(state.config, drag, targetGroupId, null)
    if (next !== null) await persistConfig(next)
  }, [state, persistConfig, clearDragState])
  const handleGridDragOver = useCallback((groupId: string, event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!editMode) return
    event.preventDefault()
    if (draggingId !== null && dragOverGroupId !== groupId) setDragOverGroupId(groupId)
  }, [editMode, draggingId, dragOverGroupId])
  const handleGridDragLeave = useCallback((groupId: string, event: ReactMouseEvent<HTMLDivElement>): void => {
    // Leaving the body (not just crossing an inner card) clears the
    // highlight; relatedTarget inside the grid is not a leave.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragOverGroupId(prev => (prev === groupId ? null : prev))
  }, [])

  /** Keyboard-reachable reorder: shift one entry inside its own group. */
  const moveItemBy = useCallback(async (groupId: string, item: WorkbenchItem, delta: number): Promise<void> => {
    if (state === null) return
    const next = moveWithinGroup(state.config, groupId, item.id, delta)
    if (next !== null) await persistConfig(next)
  }, [state, persistConfig])

  return {
    editMode, editing, setEditing, groupTitleEdit, setGroupTitleEdit,
    groupTitleDraft, setGroupTitleDraft,
    saving, saveError, setSaveError,
    toggleEditMode, startAddItem, startEditItem, cancelDraft, submitDraft,
    deleteItem, startRenameGroup, submitRenameGroup, deleteGroup, addGroup,
    draggingId, dragOverId, dragOverGroupId,
    handleDragStartItem, handleDragEnterItem, handleDropOnItem, handleDropOnGroup,
    handleGridDragOver, handleGridDragLeave, handleDragEndItem: clearDragState, moveItemBy,
  }
}
