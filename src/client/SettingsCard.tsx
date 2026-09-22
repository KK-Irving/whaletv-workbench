/**
 * REMOVED in 0.7.1 — the custom settings card is gone.
 *
 * Review decision (2026-09-03): dsh ≥ 0.1.7 projects the plugin's exported
 * `Config` schema (src/index.ts) straight into the Plugins settings page as
 * an auto-generated form (gitRemote / customSkillDirs are declared
 * `.volatile()` and stay live-editable there). Keeping a second, hand-rolled
 * card for the same two fields would duplicate the surface and drag in the
 * `configForms` / settings-scope seams that changed three times across
 * 0.1.4 → 0.1.7. The plugin's bookkeeping (installed skills, skipped update
 * heads) lives in Host-owned JSON documents under
 * `$DSH_HOME/whaletv-workbench/` instead of the settings document.
 *
 * This tombstone exists because the file tree has no delete path in the
 * editing toolchain; nothing imports this module. Delete the file when a
 * shell is available.
 */
export const REMOVED_SETTINGS_CARD = true
