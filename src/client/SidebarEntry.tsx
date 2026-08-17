/**
 * Sidebar footer trigger: the WhaleTV workbench entry beside Settings.
 * Wide mode renders icon + label; the collapsed rail renders the icon alone.
 * Pure presentation — open state and the toggle live in the shared store.
 */
import clsx from 'clsx'
import type { SidebarEntryProps } from './contract.ts'
import { WORKBENCH_ICON } from './icon.ts'
import css from './SidebarEntry.module.css'

export function SidebarEntry({ wide, useStore, actions }: SidebarEntryProps) {
  const open = useStore(s => s.open)
  return (
    <button
      type="button"
      className={clsx(css.entry, !wide && css.rail, open && css.active)}
      onClick={actions.toggleOpen}
      title="WhaleTV 工作台"
      aria-expanded={open}
    >
      <img src={WORKBENCH_ICON} alt="" className={css.icon} />
      {wide && <span className={css.label}>WhaleTV 工作台</span>}
    </button>
  )
}
