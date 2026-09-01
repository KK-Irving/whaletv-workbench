/**
 * whaletv-workbench settings card, registered into
 * `settings.plugin.item` under the `whaletv-workbench` namespace.
 *
 * A namespaced settings scope from `ctx.settingsScope.bind({namespace})` is
 * this card's read/write channel. Snapshot fields:
 *   status:   'loading' | 'ready' | 'unavailable'
 *   value:    the schema-resolved section (or `undefined` before first accept)
 *   user:     raw stored user layer — presence marks overridden fields
 *   revision: fencing for the next write
 *   writable: whether Host document accepts writes
 *
 * Per the cookbook's bundle-purity note, the card renders its own chrome
 * rather than importing shared card components from ui-settings-plugins.
 * Save/discard operate on a local draft; committing calls `scope.set` per
 * changed field so the write queue carries the current revision.
 */
import { useEffect, useMemo, useState } from 'react'
// Type-only: the client settings-scope contract lives with ui-settings since
// dsh folded the schema-form/runtime packages away.
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Config } from '../index.ts'
import css from './SettingsCard.module.css'

/** Props the panel receives via slot registration; only the injected scope is used. */
export interface SettingsCardProps {
  scope: SettingsScope<Config>
}

/**
 * Local draft shape (all fields present as edit strings, translated back to
 * the wire schema on save). Keeps the form controlled without repeatedly
 * decoding a partial section from the snapshot.
 */
interface Draft {
  gitRemote: string
  /** Comma-separated for UI convenience; parsed back to array on save. */
  customSkillDirsCsv: string
}

/**
 * Project the snapshot value into a draft with sensible fallbacks so the
 * inputs never read `undefined`. The empty defaults mirror the schema.
 */
function draftFromSnapshot(snapshot: SettingsScopeSnapshot<Config>): Draft {
  const value = snapshot.value
  return {
    gitRemote: value?.gitRemote ?? '',
    customSkillDirsCsv: (value?.customSkillDirs ?? []).join(', '),
  }
}

/** Split a CSV string into a trimmed, deduplicated string array. */
function splitCsv(input: string): string[] {
  const set = new Set<string>()
  for (const raw of input.split(',')) {
    const trimmed = raw.trim()
    if (trimmed !== '') set.add(trimmed)
  }
  return Array.from(set)
}

/**
 * The whaletv-workbench plugin card.
 *
 * Reads live from the injected settings scope, tracks local edits until save,
 * writes each changed field through `scope.set` (revision-fenced per the
 * SettingsScope contract), and mirrors errors inline.
 */
export function SettingsCard({ scope }: SettingsCardProps) {
  const [snapshot, setSnapshot] = useState<SettingsScopeSnapshot<Config>>(() => scope.getSnapshot())
  const [draft, setDraft] = useState<Draft>(() => draftFromSnapshot(scope.getSnapshot()))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Snapshot subscription: replace draft whenever the accepted section changes
  // upstream (Host write from another surface, provider push, or first accept
  // after loading). Local edits between two snapshots would be lost by design
  // — the source-of-truth is the Host document.
  useEffect(() => {
    const dispose = scope.subscribe(() => {
      const next = scope.getSnapshot()
      setSnapshot(next)
      setDraft(draftFromSnapshot(next))
    })
    return () => { dispose() }
  }, [scope])

  const dirty = useMemo(() => {
    const persisted = draftFromSnapshot(snapshot)
    return persisted.gitRemote !== draft.gitRemote
      || persisted.customSkillDirsCsv !== draft.customSkillDirsCsv
  }, [snapshot, draft])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const persisted = draftFromSnapshot(snapshot)
      if (persisted.gitRemote !== draft.gitRemote) {
        // Empty input clears the field back to the composition/schema default.
        if (draft.gitRemote.trim() === '') await scope.unset('gitRemote')
        else await scope.set('gitRemote', draft.gitRemote.trim())
      }
      const nextDirs = splitCsv(draft.customSkillDirsCsv)
      if (persisted.customSkillDirsCsv !== nextDirs.join(', ')) {
        if (nextDirs.length === 0) await scope.unset('customSkillDirs')
        else await scope.set('customSkillDirs', nextDirs)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setDraft(draftFromSnapshot(snapshot))
    setError(null)
  }

  // Snapshot status governs visibility — an unavailable namespace shows
  // nothing (a deployment that never composed the Host half should show no
  // trace of the card).
  if (snapshot.status === 'unavailable') return null

  return (
    <section className={css.card} aria-label="WhaleTV 工作台">
      <header className={css.head}>
        <h3 className={css.title}>WhaleTV 工作台</h3>
        <p className={css.desc}>
          自更新 git 源地址、自定义 skill 目录（未来的 skill 提供者会读这个列表）。
          {snapshot.mode === 'memory' && '（当前连接为内存模式，改动仅保存在本进程。）'}
        </p>
      </header>

      <div className={css.field}>
        <label className={css.label} htmlFor="whaletv-git-remote">
          Git 远程地址
          <span className={css.hint}>留空则使用 <code>git remote get-url origin</code> 的现有配置</span>
        </label>
        <Input
          id="whaletv-git-remote"
          value={draft.gitRemote}
          placeholder="https://github.com/owner/repo.git"
          disabled={saving || !snapshot.writable}
          onChange={event => { setDraft(d => ({ ...d, gitRemote: event.target.value })) }}
        />
      </div>

      <div className={css.field}>
        <label className={css.label} htmlFor="whaletv-custom-dirs">
          自定义 skill 目录（逗号分隔）
          <span className={css.hint}>为将来的 skill 提供者预留；$DSH_HOME/skills 默认就会扫描</span>
        </label>
        <Input
          id="whaletv-custom-dirs"
          value={draft.customSkillDirsCsv}
          placeholder="D:\\team-skills, C:\\dsh-shared\\skills"
          disabled={saving || !snapshot.writable}
          onChange={event => { setDraft(d => ({ ...d, customSkillDirsCsv: event.target.value })) }}
        />
      </div>

      {error !== null && <p className={css.error} role="alert">{error}</p>}

      <div className={css.actions}>
        <Button
          size="sm"
          variant="primary"
          onClick={() => { void save() }}
          disabled={!dirty || saving || !snapshot.writable}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button size="sm" onClick={discard} disabled={!dirty || saving}>
          还原
        </Button>
      </div>
    </section>
  )
}
