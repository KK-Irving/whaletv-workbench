/**
 * Workbench wire vocabulary shared by the Host half (state/update/skills/
 * session routes) and the browser half (panel rendering). Plain JSON only.
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
 * The user-editable entry registry. Persisted at
 * `$DSH_HOME/whaletv-workbench/workbench.json` (moved out of the plugin dir
 * so a git-cloned install and pnpm reconciliation cannot lose user data).
 * The shipped `config/workbench.example.json` remains the fallback template
 * on first read.
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
  /**
   * True only when host-side inputs changed in the pulled range
   * (src/index.ts / tsdown.config.ts / package.json) — i.e. the running dsh
   * process still serves the old Host module. Client-only updates hot-inject
   * and leave this false.
   */
  needRestart?: boolean
  error?: string
}

/** One incoming commit listed by GET /whaletv/workbench/update/check. */
export interface WorkbenchUpdateCheckCommit {
  /** Short SHA. */
  sha: string
  /** First line of the commit message. */
  subject: string
}

/** GET /whaletv/workbench/update/check response (roadmap P1-8). */
export interface WorkbenchUpdateCheckResult {
  ok: boolean
  /** Local branch name ('HEAD' when detached). */
  branch?: string
  /** Resolved upstream short name (e.g. origin/main) used for the comparison. */
  upstream?: string
  /** True when the upstream has nothing new (behind === 0). */
  upToDate: boolean
  /** Commits the upstream has that HEAD lacks. */
  behind?: number
  /** Commits HEAD has that the upstream lacks (local-only work). */
  ahead?: number
  /** Short SHA of the upstream head, present when behind > 0. */
  remoteHead?: string
  /** Newest incoming commits, newest first, capped at 20. */
  commits?: WorkbenchUpdateCheckCommit[]
  /** True when remoteHead equals the user's skipped-head marker. */
  skipped?: boolean
  error?: string
}

/** One persisted self-update attempt (newest first on the wire). */
export interface WorkbenchUpdateHistoryEntry {
  /** ISO-8601 timestamp of when the pipeline finished. */
  time: string
  ok: boolean
  changed?: boolean
  rebuilt?: boolean
  needRestart?: boolean
  before?: string
  after?: string
  error?: string
}

/** GET /whaletv/workbench/update/history response (roadmap P1-9). */
export interface WorkbenchUpdateHistory {
  ok: boolean
  entries: WorkbenchUpdateHistoryEntry[]
  error?: string
}

/** POST /whaletv/workbench/update/skip payload (roadmap P1-10). */
export interface WorkbenchUpdateSkipRequest {
  /** Short or full SHA of the upstream head to stop being reminded about. */
  sha: string
}

/** POST /whaletv/workbench/update/skip response. */
export interface WorkbenchUpdateSkipResult {
  ok: boolean
  skippedHead?: string
  error?: string
}

/** POST /whaletv/workbench/update/rollback response (roadmap P1-9). */
export interface WorkbenchUpdateRollbackResult {
  ok: boolean
  /** Short SHA the working tree was reset to. */
  revertedTo?: string
  output?: string
  /** Always true after a successful rollback: the Host module reverted too. */
  needRestart?: boolean
  error?: string
}

/** One entry's launch record (roadmap P2-12). */
export interface WorkbenchUsageRecord {
  count: number
  lastUsed: string
}

/** GET /whaletv/workbench/usage response. */
export interface WorkbenchUsage {
  ok: boolean
  usage: Record<string, WorkbenchUsageRecord>
}

/** POST /whaletv/workbench/usage/record response. */
export interface WorkbenchUsageRecordResult {
  ok: boolean
  error?: string
}

/** One entry's reachability outcome (roadmap P2-16). */
export interface WorkbenchHealthEntry {
  ok: boolean
  detail?: string
}

/** GET /whaletv/workbench/health response. */
export interface WorkbenchHealth {
  ok: boolean
  results: Record<string, WorkbenchHealthEntry>
  error?: string
}

/**
 * Versioning record for one workbench-installed skill (roadmap P3-20).
 * Persisted at `$DSH_HOME/whaletv-workbench/installed-skills.json` — a plain
 * Host-owned JSON document rather than a settings field, so the schema stays
 * flat and old user layers never need migrating.
 */
export interface WorkbenchInstalledSkill {
  /** Kebab-case skill name (the on-disk identity). */
  name: string
  /** Source repo URL for Git imports; absent for hand-written skills. */
  sourceUrl?: string
  /** Short SHA of the source commit the install came from. */
  sha?: string
  /** Repo sub-path this skill was installed from (batch children get their own). */
  subPath?: string
  /** Ref (branch/tag) recorded at import time, when given. */
  ref?: string
  /** ISO-8601 install timestamp. */
  installedAt: string
}

/** Wire projection of one skill summary from `ctx.skills.list()`. Model-facing
 * body / paths omitted (see `SkillSummary` in dsh-skill).
 */
export interface WorkbenchSkillSummary {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  /** Whether this skill was installed by this workbench (i.e., safe to remove). */
  removable: boolean
  /** Versioning record for workbench-installed skills with a known origin. */
  origin?: WorkbenchInstalledSkill
}

/** GET /whaletv/workbench/skills response. */
export interface WorkbenchSkillList {
  ok: boolean
  skills: WorkbenchSkillSummary[]
  /** True only when every provider completed the discovery. */
  complete: boolean
  error?: string
}

/** POST /whaletv/workbench/skills/install payload. */
export interface WorkbenchSkillInstallRequest {
  /** Kebab-case name (^[a-z0-9]+(?:-[a-z0-9]+)*$). */
  name: string
  /** Raw markdown body (with optional YAML frontmatter). */
  content: string
}

/** POST /whaletv/workbench/skills/install response. */
export interface WorkbenchSkillInstallResult {
  ok: boolean
  /** Filesystem path where the skill was written; useful for troubleshooting. */
  writtenTo?: string
  error?: string
}

/**
 * POST /whaletv/workbench/skills/import payload.
 *
 * Shallow-clones a git repo, locates the skill body inside (bundle
 * `<subPath>/SKILL.md` or flat `<subPath>.md`), and copies it into
 * `$DSH_HOME/skills/<name>/`. Anything outside the resolved sub-path is
 * discarded together with the staging clone.
 */
export interface WorkbenchSkillImportRequest {
  /** Repository URL; only http(s) and git@ SSH URLs are accepted. */
  url: string
  /** Kebab-case name the imported skill is installed under. */
  name: string
  /** Path inside the repo pointing to a SKILL.md bundle or a flat *.md file; empty = repo root. */
  subPath?: string
  /** Optional branch / tag / commit ref passed to `git clone --branch`. */
  ref?: string
}

/** POST /whaletv/workbench/skills/import response. */
export interface WorkbenchSkillImportResult {
  ok: boolean
  /**
   * Names of the skills the Host wrote to `$DSH_HOME/skills/`. Single-skill
   * imports return one entry; batch mode (a repo with multiple
   * `<child>/SKILL.md` bundles) returns each installed child.
   */
  installed?: string[]
  /**
   * Batch-mode candidates that were skipped, each with the reason (bad
   * kebab-case name, name collision with a reserved bundle filename, etc.).
   */
  skipped?: Array<{ name: string; reason: string }>
  /**
   * For single-skill imports, the path of the installed SKILL.md or *.md.
   * For batch imports, the parent directory (`$DSH_HOME/skills`) so the
   * user can jump there in a file manager.
   */
  writtenTo?: string
  /** Captured `git clone` output when it succeeded, or the failure text. */
  output?: string
  error?: string
}

/** POST /whaletv/workbench/skills/remove payload. */
export interface WorkbenchSkillRemoveRequest {
  name: string
}

/** POST /whaletv/workbench/skills/remove response. */
export interface WorkbenchSkillRemoveResult {
  ok: boolean
  error?: string
}

/** POST /whaletv/workbench/skills/update payload (roadmap P3-21). */
export interface WorkbenchSkillUpdateRequest {
  /** Installed skill name; must have a Git origin in the versioning records. */
  name: string
}

/** POST /whaletv/workbench/skills/update response (roadmap P3-21). */
export interface WorkbenchSkillUpdateResult {
  ok: boolean
  /** True when the source head differs from the recorded SHA (and was applied). */
  changed?: boolean
  /** Short SHA of the source head after the check/update. */
  sha?: string
  /** Names re-installed when a change was applied. */
  installed?: string[]
  error?: string
}

/**
 * POST /whaletv/workbench/session/followup payload.
 *
 * `agent.followup()` on the target live agent — the modern replacement for
 * "copy prompt + start blank session" clipboard flows. When `sessionId` is
 * omitted, the Host falls back to `ctx.agents.currentInitiator()`, which is
 * usually unavailable inside an HTTP handler; browsers should therefore pass
 * the visible session's id when they can.
 */
export interface WorkbenchSessionFollowupRequest {
  sessionId?: string
  prompt: string
}

/** POST /whaletv/workbench/session/followup response. */
export interface WorkbenchSessionFollowupResult {
  ok: boolean
  /** Which agent was targeted, for the browser to reconcile UI focus. */
  sessionId?: string
  error?: string
}
