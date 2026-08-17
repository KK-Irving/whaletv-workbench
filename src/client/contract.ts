/**
 * Browser-half contracts: the props composition for the two slot registrations
 * (sidebar footer action + frame-wide overlay panel) and the injected face the
 * panel drives. Data reads come from the shared workbench store; Host actions
 * arrive through the inject factories.
 */
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the sidebar's SlotMap merge (sidebar.footer.action).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pull the layout's SlotMap merge (shell.overlay).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  WorkbenchConfig, WorkbenchConfigSaveResult, WorkbenchState, WorkbenchUpdateResult,
} from '../shared.ts'
import type { createWorkbenchStore } from './store.ts'

/** Injected face shared by both registrations (plain data and callbacks only). */
export type WorkbenchInjected = {
  /** Open a web target in a new tab. */
  openUrl: (url: string) => void
  /** Open a local file/app with the Host OS default handler. */
  openPath: (path: string) => Promise<void>
  /** Start a new blank session (the skill-entry "use in session" action). */
  startSession: () => void
  /** Copy the skill prompt to the clipboard. */
  copyPrompt: (text: string) => Promise<void>
  /** Fetch the workbench state (version, git, entry config) from the Host. */
  loadState: () => Promise<WorkbenchState>
  /** Persist the whole entry config; the Host writes config/workbench.json. */
  saveConfig: (config: WorkbenchConfig) => Promise<WorkbenchConfigSaveResult>
  /** POST the one-click update; resolves the Host's structured result. */
  update: () => Promise<WorkbenchUpdateResult>
}

/** Full sidebar entry props: owner wide flag + store share + injected face. */
export type SidebarEntryProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & WorkbenchInjected

/** Full panel props: overlay owner (empty) + store share + injected face. */
export type WorkbenchPanelProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & WorkbenchInjected
