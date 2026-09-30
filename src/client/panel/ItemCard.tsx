/**
 * One entry card: title, description, and its kind-specific actions (or the
 * inline form in edit mode). Edit mode additionally enables drag-reorder
 * (roadmap P2-15); a favicon shows for web entries (P2-17) and a reachability
 * badge after a health run (P2-16). Extracted in the v0.8.16 split.
 */
import type { DragEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { WorkbenchHealthEntry, WorkbenchItem } from '../../shared.ts'
import css from '../WorkbenchPanel.module.css'
import { iconSrcFor, isConfigured, TARGET_LABEL } from './entry-helpers.ts'
import type { ItemFormDraft } from './entry-helpers.ts'
import { ItemForm } from './ItemForm.tsx'

export function ItemCard(props: {
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
