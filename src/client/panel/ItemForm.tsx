/**
 * Inline entry form (used for both new and existing entries). Extracted from
 * WorkbenchPanel.tsx in the v0.8.16 split; props-only, no hooks.
 */
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import css from '../WorkbenchPanel.module.css'
import { kindPlaceholder } from './entry-helpers.ts'
import type { ItemFormDraft, TargetKind } from './entry-helpers.ts'

export function ItemForm(props: {
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
