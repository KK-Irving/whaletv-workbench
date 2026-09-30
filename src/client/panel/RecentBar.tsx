/**
 * 最近使用 rail (roadmap P2-12): top launched entries as clickable chips.
 * Extracted in the v0.8.16 split.
 */
import css from '../WorkbenchPanel.module.css'

export function RecentBar(props: {
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
