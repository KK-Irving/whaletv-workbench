# Changelog

Notable changes per version. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely; pre-1.0 minor bumps carry feature-level changes because the API surface is still shaping up.

## 0.7.0 — 2026-09-03

Roadmap execution release: P1 (update experience), the core of P2 (workbench
capabilities) and P3 (skill versioning), per [ROADMAP.md](./docs/ROADMAP.md).

### Added

- **Update experience (P1)**, modeled on x-hub's upgrade chain:
  - `GET /update/check` — "检查更新" split from "更新": fetches the remote,
    reports ahead/behind and the newest 20 incoming commits without touching
    the working tree; the panel shows a commit-list banner with apply/skip.
  - `GET /update/history` + `POST /update/rollback` — every update attempt is
    recorded to `$DSH_HOME/whaletv-workbench/updates.json` (capped at 20);
    the panel's footer shows the last successful update and a "回滚上一版本"
    button (`git reset --hard` to the recorded before-SHA + rebuild; refuses
    a dirty worktree).
  - `POST /update/skip` — "跳过此版本": marks the upstream head
    (`skippedHead` settings field) so the checker flags it instead of
    nagging; a successful update clears the marker.
- **最近使用 rail (P2-12)**: `GET /usage` + `POST /usage/record` track per-item
  launch counts (`usage.json`, capped at 500); the panel renders the top 10
  as clickable chips above the groups.
- **Alt+W toggles the panel (P2-13)** from anywhere on the page.
- **Search keyboard navigation (P2-14)**: ↑↓ move a visible cursor across
  the flattened matches, Enter runs the selected entry, the cursor row
  scrolls into view.
- **Drag reorder (P2-15)**: in edit mode, entries drag within and across
  groups; drops land before a target card or append to the group body.
- **Reachability check (P2-16)**: `GET /health` probes every entry (HEAD
  with GET fallback for 403/405 shields, 5s timeout; path existence for
  local targets); edit mode grows a "检查可达性" button and cards show ✓/✗
  badges with detail tooltips.
- **Favicon proxy (P2-17)**: `GET /icon?url=<origin>` caches per-origin
  favicons under the workbench state dir (private-network origins refused,
  512KB cap) and web cards show the icon.
- **Skill versioning (P3-20)**: installs/imports now record
  `$DSH_HOME/whaletv-workbench/installed-skills.json` — per-skill source
  URL, sub-path, ref, and source-head SHA; `/skills` exposes the record as
  `origin`, and skill cards show "来源：… @ sha · date".
- **Per-skill "检查更新" (P3-21)**: `POST /skills/update` re-clones the
  recorded origin and applies a newer head (`changed` reports whether the
  SHA moved); the button only appears for skills with a Git origin.
- **Smoke covers the security boundaries (P4-28)**: the host smoke now
  asserts that git-import rejects `file://` URLs, the reserved `skill` name,
  non-kebab names, ref metacharacters, and `..` traversal before any
  subprocess spawns; that `/update/skip` validates the SHA charset; and that
  the favicon proxy refuses loopback origins.

### Removed

- **Skill panel editor** (P3-23 prototype, removed in the same-cycle review):
  an accidental edit could silently corrupt an installed SKILL.md, and
  delete + reinstall is the safer recovery for ordinary users. The
  `GET /skills/source` route went with the UI — no dead surface shipped.
- **Standalone header「更新」button**: merged into a single two-phase flow —
  「检查更新」fetches and shows the commit banner, and the banner's 更新
  button is the only path that pulls (mirrors x-hub's check → dialog →
  apply pattern; the two parallel entries duplicated each other).

### Fixed

- **Install-over-existing no longer erases versioning records**: writing a
  skill that already has an origin record (e.g. reinstalling the same name
  through the inline install form) now preserves the previous
  sourceUrl/sha/subPath/ref and only refreshes the install timestamp.

### Changed

- Settings tab label is plain registrant-owned text on
  `settings.plugins.tab` (0.6.1's migration, now with an explicit order).

## 0.6.1 — 2026-09-03

Alignment release for dsh **0.1.6-alpha.2**. The 0.1.6 client surface moved
twice under this plugin: the sessions catalog dropped the `current` field
(navigation moved to view owners) and the keyed `settings.plugin.item` card
slot was replaced by feature-owned tabs in `settings.plugins.tab`. Plus the
roadmap P0 hardening: CI, version-consistency gate, and precise restart
signaling (see [ROADMAP.md](./docs/ROADMAP.md)).

### Fixed

- **`referenceSkill` reads the on-screen session the dsh ≥ 0.1.6 way.**
  `SessionListState` no longer carries `current`; the client now finds the
  session retained by the `mainView` source in `list.getSnapshot().byId` —
  the same heuristic ui-layout's `DocumentTitle` and the workspace browser
  use. No on-screen session → the panel keeps its "open a session first"
  hint.
- **Settings card registers into `settings.plugins.tab`.** The keyed
  `settings.plugin.item` seam is gone upstream; the workbench now
  contributes a feature-owned tab (id `whaletv-workbench`, order 50,
  plain-string label) whose inject face binds the `whaletv-workbench`
  settings scope exactly as before. The `SettingsCard` component itself is
  unchanged. `smoke-apply` expectations moved with it.

### Added

- **CI** (`.github/workflows/ci.yml`): install → `check:version` → bundle →
  mock smoke on every push/PR. Deliberately harness-type-free; real dsh
  types are covered by the weekly alignment job.
- **dsh alignment workflow** (`.github/workflows/align.yml`): weekly cron +
  manual dispatch on Windows — clones `deepseek-ai/deepseek-harness`,
  builds its lib faces, links peers, then runs `tsc --noEmit` + full smoke
  against harness HEAD. This is the drift alarm the mock smokes can't
  provide (the 0.5.0 breakage shipped green).
- **`pnpm run check:version`** (`scripts/check-version.mjs`): fails when
  README.md / docs/DESIGN.md `当前版本 **v…**` markers disagree with
  package.json — the three copies had drifted (v0.5.1 vs 0.6.0).
- **`pnpm run smoke` now gates types**: check:version → `tsc --noEmit` →
  three contract smokes. `smoke:ci` is the harness-free subset for CI.

### Changed

- **`needRestart` is host-diff-precise.** The update pipeline now answers
  "restart needed?" by diffing the pulled range for `src/index.ts` /
  `tsdown.config.ts` / `package.json` instead of always true-on-change;
  client-only pulls hot-inject without the restart nag. The panel message
  branches on the field.
- **`link-harness-deps.mjs` works without `$DSH_HOME`.** The peer-repair
  pass (peerDependencies → harness checkout) now runs even when the flat
  fallback directory is absent — the prerequisite for the CI alignment job
  and for fresh-clone setups.
- Dead code cleanup: the no-op `void readdirSync` tail in `apply()`, the
  identity ternary in the skill-import traversal guard, and a divergent
  `ctx.get('settings')` spelling in the import route now match the rest of
  the file.

## 0.6.0 — 2026-09-03

### Added

- **「打开网页」可在 dsh 桌面客户端内新标签页打开.** `openUrl` 在检测到
  Electron 客户端桥（`window.dshDesktop`）时，给 `window.open` 的 features
  追加 `dsh-tab` 标记；配套的 dsh-web-launcher 主进程（v2.0.6+，`electron/src/main/index.js`
  的 window-open 处理器）把带该标记的 URL 收进客户端自己的标签页，而不是
  `shell.openExternal` 交给系统默认浏览器。普通浏览器忽略未知 feature，
  行为回落为默认浏览器新标签页——两端任缺其一都不劣化。

### Changed

- **侧边栏入口悬停效果与 dsh 原生一致.** 入口按钮原先用不透明的
  `--dsw-specific-sidebar-nav-item-hover`（该 token 实际属于设置弹窗导航格）
  加自创几何（34px 高 / 8px 圆角 / 13px 字号 / 次级墨水悬停变色），与紧邻的
  Settings 触发行及全站悬停面不一致。现完全对齐：42px 高 / 12px 圆角 /
  14px/22px / 主色墨水、共享的半透明 `--dsw-alias-interactive-bg-hover`、
  ±2px 光学外扩、激活态 `interactive-bg-active`、折叠栏 36×36 圆形；原生
  `title` 提示换成 dsh 样式化 `Tooltip`（`delayMs: 500`，宽栏禁用）。

## 0.5.1 — 2026-09-01

### Changed

- **技能专区「使用」改为在当前会话内联引用 skill.** 原先「使用」走
  `agent.followup()` 把"请调用技能：xxx"作为一轮对话发出（无会话时退回新建
  会话），现在改为把 `/<技能名>` 写进**当前会话**的输入框并关闭面板，由用户
  确认后回车，通过 dsh 的 `/` 技能触发器在当前会话内联引用该 skill。实现走
  `ctx.sessions`（取 `list.getSnapshot().current` 与 `scope(id)`）+
  `ctx.conversation.input.for(scope).setDraft(\`/\${name}\`)`；两个服务经
  `ctx.get(...)` 显式取用并断言到客户端 `ISessions` / `IConversation`
  类型，避开 Host 侧 core `dsh-session` 的 `sessions: SessionStore` 环境
  合并冲突。无当前会话时弹提示，请先打开/新建会话。
- **客户端注入 + peer 依赖.** client `inject` 增加 `sessions`、
  `conversation`；`peerDependencies` 增加
  `@deepseek-ai/dsh-api-session-controller`、
  `@deepseek-ai/dsh-client-ui-conversation`。注入面 `WorkbenchInjected` 新增
  `referenceSkill(name)`，`followup` 仍保留给 `prompt` 类型的条目卡片
  （"在会话中使用"）。client bundle 的外部 require 不变（仍只有 react /
  jsx-runtime / dsh-client-store / dsh-client-ui-primitives——两个新服务是
  cordis service，经 `ctx.get` 取用，不进模块表）。

## 0.5.0 — 2026-09-01

Alignment release for dsh **0.1.2-alpha.3** (after `be531688f3 refactor(client):
migrate consumers and remove Runtime` and the 0.1.2 client-surface
reorganizations). On current dsh, the 0.4.0 client bundle crashed at
materialization (`require("@deepseek-ai/dsh-client-runtime/client") missed the
module table`) and the host settings seam failed to typecheck — this release
removes every removed-upstream import and re-points the affected seams.

### Fixed

- **Client bundle no longer requires removed packages.** The client runtime
  package (`@deepseek-ai/dsh-client-runtime`) was removed upstream on
  2026-08-23, so the 0.4.0 artifact threw at every page load. `ClientContext`
  now comes from `@deepseek-ai/cordis`, the store moves to
  `@deepseek-ai/dsh-client-store` (a platform seed), and the settings-card
  types to `@deepseek-ai/dsh-client-ui-settings/client`.
- **Path opening via the session-controller RPC.** The client workspaces
  service lost `openPath`/`startSession`; the workbench now calls
  `ctx.remote.session.openWorkspacePath({ path })` (with a friendly error on
  the `RemoteResult` failure arm) and `ctx.uiWorkspace.startSession()`. The
  client `inject` list becomes `['slots', 'settingsScope', 'uiWorkspace',
  'remote', 'remote.session']` and the `ctx.slots` type merge is pulled from
  `@deepseek-ai/dsh-client-ui-renderer/client`.
- **Settings seam on the new service API.** The standalone
  `installSettingsSection` / `settingsNamespace` helpers were folded into
  `SettingsProvider` as `ctx.settings.installSection(owner, ns, schema, entry,
  hooks)`; the namespace is now the plain `'whaletv-workbench'` literal
  (runtime + type-level validation replaced the old helper).
- **`tsdown` externals trimmed to the shrunken platform table.**
  `dsh-client-web-react`, `dsh-client-schema-form`, `dsh-client-ui-attachment`
  and `dsh-client-runtime/client` are gone from the build; the built bundle
  requires exactly `react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-store`
  and `@deepseek-ai/dsh-client-ui-primitives`. The deprecated `noExternal`
  option became `deps.alwaysBundle`.

### Changed

- **`link-harness-deps.mjs` heals dangling junctions.** dsh's flat fallback
  (`$DSH_HOME/profiles/node_modules`) only rewrites entries in the current
  installation generation, so packages dsh removed or renamed left dangling
  junctions that broke TS resolution. The script now (1) prunes dangling
  junctions with no discoverable source, and (2) repairs/creates the
  `@deepseek-ai/*` peer set from the harness checkout (`DSH_HARNESS_ROOT` or
  the sibling `../deepseek-harness`), indexed by walking `packages/**`.
- **`dsh.client.inject` graph edges** drop the removed
  `@deepseek-ai/dsh-client-runtime` row; the three UI rows (sidebar, layout,
  settings-plugins) remain. Peer dependencies updated to match the new type
  sources (`dsh-client-store`, `dsh-client-ui-settings`, `dsh-client-ui-workspace`,
  `dsh-client-ui-renderer`, `dsh-api-remotes` added; runtime / web-react /
  schema-form removed).

### Notes

- Install/uninstall changes the profile bundle stack, which current dsh does
  not hot-reload — restart `dsh web` after `dsh plugin add` / `remove`
  (README updated accordingly). The in-panel self-update remains hot.

## 0.4.0 — 2026-08-18

Focus of this release: turning "工作台技能" from a fragile shim on top of
dsh-skill-filesystem into a first-class local skill manager. Every path
that touched `$DSH_HOME/skills` was hardened, several catastrophic UI
regressions were fixed, and Git-based skill imports learned to actually
handle the shapes real skill repositories ship in.

### Added

- **Workbench-owned `SkillProvider`** (`ctx.skills.registerProvider`) — the
  panel's "工作台技能" section no longer depends on dsh-skill-filesystem
  behaving. Our provider scans `$DSH_HOME/skills` directly, parses YAML
  frontmatter, and coexists with dsh's built-in provider at rank 450 (built-in
  user-dsh sits at 400, so it wins duplicate names when both are healthy;
  ours fills the gap otherwise).
- **Batch skill import** — a Git repo whose subtree is a directory of
  `<child>/SKILL.md` bundles installs every child in one go. Each child
  bundle uses its own directory name as the skill identity; the form's
  target-name field is ignored in batch mode.
- **`SKILL.md`-aware source resolution** — when the sub-path points at a
  `SKILL.md` file, the importer walks up to the enclosing directory and
  installs it as a bundle (with adjacent `references/` / `scripts/` /
  `assets/` copied along), instead of the old behavior that treated it as
  a flat single-file skill.
- **Persistent success notice** for install / import — shows the installed
  names, the on-disk path, batch results, and whether the catalog has picked
  the skill up. Dismissible via ✕; no longer disappears with the form.
- **`GET /whaletv/workbench/skills/debug`** — diagnostic endpoint returning
  our resolved `$DSH_HOME/skills` path, the directory contents we see, the
  relevant env vars (`DSH_HOME` / `DSH_AGENTS_HOME` / `USERPROFILE`), and
  the raw dsh skill registry snapshot side-by-side. Answers "why is the
  panel empty but the file is on disk?" in one request.
- **Git auth failure translation** — the raw git output (`Interactive
  logon failed`, `could not read Username`, OAuth 2.0 `invalid_client`)
  is replaced by an actionable message that points at SSH URL / SSO-authorized
  PAT / manual pre-cache. HTTP fatal chains no longer overwhelm the panel.
- **Windows staging cleanup** — `fs.rmSync` now retries 8× / 250ms so
  git.exe's still-open pack file handles don't strand a half-clone. An
  additional startup sweep clears any leftover `.staging/skill-*` from
  crashes before the current version landed.
- **Debug diagnostics on the browser console** — `[whaletv-workbench] /skills →`
  logs the raw payload on every reload, so users can see `complete` /
  `skills.length` without popping DevTools' Network tab.

### Changed

- **Bundle-vs-flat detection** now enumerates three shapes and reports each
  in the response: `bundle` (single skill with SKILL.md), `flat` (a lone
  `.md` file), or `batch` (parent directory of bundles). Anything else fails
  with a specific "found N candidates, none installable" message.
- **Auto-derived skill name** in the Git-import form skips a `SKILL.md`
  leaf (`whaletv-dev-power/SKILL.md` → `whaletv-dev-power`, not `skill`),
  and the Host rejects the reserved name `skill` even if a user types it
  manually.
- **Provider invalidation on every write route** — install / import / remove
  each call `skillProvider.invalidate()` after mutating disk, so the next
  `snapshot()` re-scans deterministically instead of waiting on chokidar.
- **Non-interactive Git** — every `execFile` child receives
  `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=Never`. Git fails fast when
  a credential prompt would have hung, and the friendly translation replaces
  the raw error.
- **Skill install form help text** now enumerates the four supported shapes
  (bundle dir, SKILL.md file, flat `*.md`, batch parent) plus the private-repo
  auth options.
- **`inject` list** on the Host plugin includes `settings` — Cordis's inject
  check rejected `ctx.settings.update(...)` in the skill-write routes
  otherwise ("cannot get property settings without inject").
- **Smoke tests** — `smoke-host.mjs` verifies the inject list contract and
  mocks `ctx.skills.registerProvider` so the new workbench provider
  registration doesn't false-fail the harness.

### Fixed

- **Panel crash on "+ 新建技能"** — a stray reference to a removed React
  state (`output`) threw `ReferenceError` at click time, unmounting the
  overlay. All four call-sites cleaned up.
- **`settings.plugin.item` slot** — the type declaration flipped from
  `list` to `keyed` in `dsh-client-ui-settings-plugins@0.1.0-rc.7`; the
  card registration now spells `key: 'whaletv-workbench'` and includes a
  code comment recording which knob to flip together with the type file
  next time it ping-pongs.
- **Flat-file naming bug** — `subPath: whaletv-dev-power/SKILL.md`
  previously ended up at `$DSH_HOME/skills/whaletv-dev-power.md` (a lone
  Markdown file). Now correctly installs the whole enclosing directory
  as a bundle.
- **NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS noise** — pnpm 11's exported
  env var is now stripped from every spawn we own, keeping the plugin's
  captured output clean.

### Notes

Requires a full `dsh web` restart after upgrading — the Host module
changed, and `ctx.clientModules.rebuilt()` only refreshes the browser
bundle. See [README §安装](./README.md#安装) for the install command.

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
