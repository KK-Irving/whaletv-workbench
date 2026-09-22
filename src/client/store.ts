/**
 * The workbench viewing store: panel open state, search draft, loaded Host
 * state, and the update flow status. One handle is created in apply and
 * shared by the sidebar entry and the panel registrations (root scope), so
 * both surfaces read and mutate the same live instance.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type {
  WorkbenchSkillList, WorkbenchState, WorkbenchUpdateCheckResult, WorkbenchUpdateHistoryEntry,
} from '../shared.ts'

/** Workbench store state. */
export type WorkbenchStoreState = {
  /** Panel visibility. */
  open: boolean
  /** Search draft filtering entries by title/description. */
  search: string
  /** Host state (version, git facts, entry config); null until first load. */
  state: WorkbenchState | null
  /** Last state-load failure, shown as an inline warning. */
  loadError: string | null
  /** True while an update is in flight. */
  updating: boolean
  /** Captured update pipeline output (or the failure message). */
  updateLog: string
  /** Human summary of the last update outcome. */
  lastResult: string | null
  /** Current skill catalog projection; null until first load. */
  skills: WorkbenchSkillList | null
  /** True while the skills catalog is being refreshed. */
  skillsLoading: boolean
  /** True while the update checker is fetching the remote. */
  checking: boolean
  /** Last "检查更新" outcome; null until the first check in this panel life. */
  checkResult: WorkbenchUpdateCheckResult | null
  /** Rolling update-attempt log (newest first); null until first load. */
  updateHistory: WorkbenchUpdateHistoryEntry[] | null
}

/** Workbench store actions (draft mutators). */
export type WorkbenchStoreActions = {
  setOpen: (d: WorkbenchStoreState, open: boolean) => void
  toggleOpen: (d: WorkbenchStoreState) => void
  setSearch: (d: WorkbenchStoreState, search: string) => void
  setState: (d: WorkbenchStoreState, state: WorkbenchState) => void
  setLoadError: (d: WorkbenchStoreState, error: string | null) => void
  setUpdating: (d: WorkbenchStoreState, updating: boolean) => void
  setUpdateLog: (d: WorkbenchStoreState, log: string) => void
  setLastResult: (d: WorkbenchStoreState, result: string | null) => void
  setSkills: (d: WorkbenchStoreState, skills: WorkbenchSkillList | null) => void
  setSkillsLoading: (d: WorkbenchStoreState, loading: boolean) => void
  setChecking: (d: WorkbenchStoreState, checking: boolean) => void
  setCheckResult: (d: WorkbenchStoreState, result: WorkbenchUpdateCheckResult | null) => void
  setUpdateHistory: (d: WorkbenchStoreState, entries: WorkbenchUpdateHistoryEntry[] | null) => void
}

/**
 * Create the shared workbench store handle.
 * @returns the store handle (spec + identity + factory in one).
 */
export function createWorkbenchStore(): EngineStoreHandle<WorkbenchStoreState, WorkbenchStoreActions> {
  return defineStore({
    init: (): WorkbenchStoreState => ({
      open: false,
      search: '',
      state: null,
      loadError: null,
      updating: false,
      updateLog: '',
      lastResult: null,
      skills: null,
      skillsLoading: false,
      checking: false,
      checkResult: null,
      updateHistory: null,
    }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
      toggleOpen: (d) => { d.open = !d.open },
      setSearch: (d, search: string) => { d.search = search },
      setState: (d, state: WorkbenchState) => { d.state = state },
      setLoadError: (d, error: string | null) => { d.loadError = error },
      setUpdating: (d, updating: boolean) => { d.updating = updating },
      setUpdateLog: (d, log: string) => { d.updateLog = log },
      setLastResult: (d, result: string | null) => { d.lastResult = result },
      setSkills: (d, skills: WorkbenchSkillList | null) => { d.skills = skills },
      setSkillsLoading: (d, skillsLoading: boolean) => { d.skillsLoading = skillsLoading },
      setChecking: (d, checking: boolean) => { d.checking = checking },
      setCheckResult: (d, checkResult: WorkbenchUpdateCheckResult | null) => { d.checkResult = checkResult },
      setUpdateHistory: (d, updateHistory: WorkbenchUpdateHistoryEntry[] | null) => { d.updateHistory = updateHistory },
    },
  })
}
