/**
 * Entry-domain pure helpers (v0.8.16 split): target resolution, draft
 * conversion, id generation, favicon URLs and reorder algebra. No React.
 */
import type { WorkbenchConfig, WorkbenchGroup, WorkbenchItem } from '../../shared.ts'

/** The one configured target of an entry, or null when nothing is set. */
export type EntryTarget =
  | { kind: 'url'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'prompt'; value: string }

/**
 * Resolve an entry's action target — THE single source of truth for the
 * url/path/prompt precedence. The old code derived "configured" from a
 * comparison against the Chinese button label, so a copy tweak silently
 * changed behaviour.
 */
export function entryTarget(item: WorkbenchItem): EntryTarget | null {
  if (item.url !== undefined && item.url !== '') return { kind: 'url', value: item.url }
  if (item.path !== undefined && item.path !== '') return { kind: 'path', value: item.path }
  if (item.prompt !== undefined && item.prompt !== '') return { kind: 'prompt', value: item.prompt }
  return null
}

/** Fixed label per target kind — each rendered button names its own action. */
export const TARGET_LABEL: Record<EntryTarget['kind'], string> = {
  url: '打开网页',
  path: '打开',
  prompt: '在会话中使用',
}

/** Whether an entry has any configured target. */
export function isConfigured(item: WorkbenchItem): boolean {
  return entryTarget(item) !== null
}

/** Entry target kinds the edit form offers. */
export type TargetKind = 'url' | 'path' | 'prompt'

/** Editable field draft for one entry (new or existing). */
export interface ItemFormDraft {
  title: string
  description: string
  kind: TargetKind
  value: string
}

/** Which entry is currently in form editing (null = none). */
export interface ItemEditing {
  groupId: string
  itemId: string | null
  draft: ItemFormDraft
}

/** Monotonic per-page id source for new entries/groups. */
let idCounter = 0
export function genId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`
}

export function emptyDraft(): ItemFormDraft {
  return { title: '', description: '', kind: 'url', value: '' }
}

export function draftFromItem(item: WorkbenchItem): ItemFormDraft {
  const kind: TargetKind = item.url !== undefined ? 'url' : item.path !== undefined ? 'path' : item.prompt !== undefined ? 'prompt' : 'url'
  return {
    title: item.title,
    description: item.description ?? '',
    kind,
    value: item.url ?? item.path ?? item.prompt ?? '',
  }
}

/** Build a config item from the form draft; blank optional fields are dropped. */
export function itemFromDraft(id: string, draft: ItemFormDraft): WorkbenchItem {
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
export function kindPlaceholder(kind: TargetKind): string {
  if (kind === 'url') return 'https://…'
  if (kind === 'path') return 'C:\\path\\to\\app.exe'
  return '提示词文本…'
}

/** Per-origin favicon proxy URL for a web entry ('' when the URL is unusable). */
export function iconSrcFor(url: string): string {
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
export function moveItem(
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
export function moveWithinGroup(
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

/** Convenience re-export so consumers can type group collections. */
export type { WorkbenchGroup }
