# Changelog

Notable changes per version. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; pre-1.0 minor bumps carry feature-level changes because the API surface is still shaping up.

## 0.3.0 — 2026-08-17

Major alignment with the official DeepSeek Harness plugin surface: this release
turns the workbench from a "shortcut launcher plugin" into a first-class
`dsh plugin add`-installable bundle that also manages harness skills through
`ctx.skills`, seeds sessions through `agent.followup()`, and edits its prefs
through the standard `ctx.settings` + settings card seam.

### Added
- **Official bundle manifest** (`dsh.bundle.patch` + repo-root `cordis.patch.yml`) — `dsh plugin --profile web add ...` now auto-mounts the plugin; `dsh plugin ... remove whaletv-workbench` removes it in one command.
- **Workbench skills panel** — a dedicated "工作台技能" section reads live from `ctx.skills.snapshot()`, with:
  - Inline "手写正文" install form (name / description / Markdown body → wrapped in YAML frontmatter, written to `$DSH_HOME/skills/<name>/SKILL.md`).
  - "从 Git 仓库导入" install form (URL / branch / sub-path / target name) — shallow-clones an http(s)/ssh repo, copies bundle-form (`<subPath>/SKILL.md` + assets) or flat-form (`<subPath>.md`) into `$DSH_HOME/skills/<name>/`.
  - Per-skill "使用" button — routes through `agent.followup()` when a session is known, falls back to clipboard + new session when not.
  - Per-skill "删除" button — only for skills the workbench itself wrote (project / agent / bundled sources stay read-only).
- **Settings namespace `whaletv-workbench`** registered via `installSettingsSection`, with a browser card on the settings page's Plugins tab. Fields: `gitRemote`, `customSkillDirs`, and the internal `installedSkills` registry.
- **`Learn more`** README section linking to the official harness reference pages.
- **`prepare` script gate** (`scripts/maybe-prepare.mjs`) — respects `DSH_SKIP_PREPARE=1`, and skips a redundant bundle when `lib/client.js` already exists.
- **LICENSE (MIT)** and `package.json` license / repository / bugs / homepage fields.
- **CHANGELOG.md** (this file).

### Changed
- **Route consolidation** — three exact routes (`/state`, `/config`, `/update`) plus the new skills/session routes now register as a single `kind: 'prefix'` seat on `/whaletv/workbench` and dispatch internally.
- **Config storage moved** — user's `workbench.json` now lives at `$DSH_HOME/whaletv-workbench/workbench.json` instead of `<plugin>/config/workbench.json`. First read migrates the legacy path automatically; nothing to do.
- **Update flow footer** — when `git pull` reports no new commits, the notification auto-dismisses after 5s and exposes an ✕ close button instead of blindly stacking the log output.
- **Peer deps expanded** — `@deepseek-ai/dsh-agent`, `dsh-llm`, `dsh-session`, `dsh-settings`, `dsh-skill`, `dsh-client-ui-settings-plugins`, and `schemastery` are now required for the new surfaces.
- **Sanitized child env** — every `execFile` / `spawnSync` this plugin issues strips `NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS` before spawning, so pnpm 11 → npm 11 noise never leaks into the plugin's captured output.
- **Example config** (`config/workbench.example.json`) dropped its "技能" group — real skills come from `ctx.skills`, and duplicating them as prompt cards is confusing. Existing user configs are untouched.

### Fixed
- `updating` flag moved into the `apply()` closure — a hot-reloaded plugin no longer leaks a stale in-flight guard into its next mount.
- Settings card slot registration uses `id` (list slot), not `key` — the cookbook example spelled it `key`, but the runtime type declares `kind: 'list'`, so registration was rejected with "list slot ... requires options.id".
- Update notification popup no longer stacks a scrollbar for the "already up to date" case; the whole footer sizes to content, only the log block scrolls when it exists.

## 0.2.0 and earlier

Initial dual-face plugin: sidebar entry + `shell.overlay` panel with grouped
entry cards (web / docs / apps / prompt skills), in-panel config editing,
one-click self-update pipeline (git pull → pnpm install → bundle →
`ctx.clientModules.rebuilt`). See git history for details.
