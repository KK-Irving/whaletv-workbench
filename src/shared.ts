/**
 * Workbench wire vocabulary shared by the Host half (state/update routes)
 * and the browser half (panel rendering). Plain JSON only.
 */

/** One workbench entry: exactly one of url / path / prompt drives its action. */
export interface WorkbenchItem {
  /** Stable id, unique inside the config. */
  id: string
  /** Display title. */
  title: string
  /** One-line description shown under the title. */
  description?: string
  /** Web target — opened in a new browser tab. */
  url?: string
  /** Local file/app target — opened by the Host OS default handler. */
  path?: string
  /** Skill prompt — copied to the clipboard when the user starts a session. */
  prompt?: string
}

/** One titled group of entries rendered as a card section. */
export interface WorkbenchGroup {
  id: string
  title: string
  items: WorkbenchItem[]
}

/**
 * The user-editable entry registry. Lives in config/workbench.json (created by
 * the panel's edit mode); the shipped config/workbench.example.json is the
 * fallback template for fresh checkouts.
 */
export interface WorkbenchConfig {
  groups: WorkbenchGroup[]
}

/** POST /whaletv/workbench/config response. */
export interface WorkbenchConfigSaveResult {
  ok: boolean
  error?: string
}

/** Git facts of the plugin directory, read by the Host half. */
export interface WorkbenchGitState {
  configured: boolean
  branch?: string
  head?: string
  remote?: string
}

/** GET /whaletv/workbench/state response. */
export interface WorkbenchState {
  ok: boolean
  version: string
  packageDir: string
  git: WorkbenchGitState
  config: WorkbenchConfig
  error?: string
}

/** POST /whaletv/workbench/update response. */
export interface WorkbenchUpdateResult {
  ok: boolean
  changed?: boolean
  rebuilt?: boolean
  before?: string
  after?: string
  output?: string
  needRestart?: boolean
  error?: string
}
