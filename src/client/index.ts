/**
 * whaletv-workbench browser half: three slot registrations sharing one
 * store — the sidebar entry, the frame-wide dashboard panel, and the
 * settings page card that edits `whaletv-workbench` namespace prefs.
 *
 * - SidebarEntry fills `sidebar.footer.action` with the workbench trigger.
 * - WorkbenchPanel fills `shell.overlay` with the dashboard (groups /
 *   skills / update flow).
 * - SettingsCard fills `settings.plugin.item` on the settings page's
 *   Plugins tab with a schema-driven form for the two scalar prefs.
 *
 * Slot declarations from the shipped shell are awaited via
 * `ctx.slots.inject`, so apply order against ui-sidebar / ui-layout /
 * ui-settings-plugins is free.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pull the settings-plugins SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { WorkbenchInjected } from './contract.ts'
import type {
  WorkbenchConfigSaveResult, WorkbenchSessionFollowupResult, WorkbenchSkillImportRequest,
  WorkbenchSkillImportResult, WorkbenchSkillInstallRequest, WorkbenchSkillInstallResult,
  WorkbenchSkillList, WorkbenchSkillRemoveResult, WorkbenchState, WorkbenchUpdateResult,
} from '../shared.ts'
import { createWorkbenchStore } from './store.ts'
import { SidebarEntry } from './SidebarEntry.tsx'
import { WorkbenchPanel } from './WorkbenchPanel.tsx'
import { SettingsCard } from './SettingsCard.tsx'

export type { SidebarEntryProps, WorkbenchPanelProps, WorkbenchInjected } from './contract.ts'
export type {
  WorkbenchItem, WorkbenchGroup, WorkbenchConfig, WorkbenchState, WorkbenchUpdateResult,
  WorkbenchSkillSummary, WorkbenchSkillList,
} from '../shared.ts'

/**
 * Required client services:
 * - slots: keyed / list slot registrations
 * - workspaces: openPath + startSession actions for entry cards
 * - settingsScope: bound namespace scope reads and writes for the settings card
 */
export const inject = ['slots', 'workspaces', 'settingsScope']

/**
 * Raise a Host route's JSON payload; non-ok results throw their error text.
 * Tolerant of non-JSON bodies so a stale Host (route not yet loaded, e.g.
 * before a dsh web restart) surfaces as an actionable message instead of a
 * cryptic JSON parse error.
 */
async function fetchJson<T extends { ok: boolean; error?: string }>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  if (text !== '') {
    try { body = JSON.parse(text) } catch { body = null }
  }
  if (response.ok && body !== null && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
    return body as T
  }
  if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    throw new Error((body as { error: string }).error)
  }
  if (text === '') {
    throw new Error(`服务端返回空响应（HTTP ${response.status}）。工作台的服务端接口可能尚未加载：请重启 dsh web 后重试。`)
  }
  if (text.trimStart().startsWith('<!doctype') || text.trimStart().startsWith('<html')) {
    throw new Error(`接口 ${url} 未在服务端注册（HTTP ${response.status} 返回了页面）。请重启 dsh web 后重试。`)
  }
  throw new Error(`HTTP ${response.status}`)
}

/**
 * Register the sidebar entry, the panel, and the settings card once their
 * slot declarations land on the ledger; one store handle is shared by all
 * three registrations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const store = createWorkbenchStore()

  const injected = (): WorkbenchInjected => ({
    openUrl: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    openPath: async (path) => {
      await ctx.workspaces.openPath(path)
    },
    startSession: () => {
      ctx.workspaces.startSession()
    },
    copyPrompt: async (text) => {
      await writeClipboard(text)
    },
    loadState: () => fetchJson<WorkbenchState>('/whaletv/workbench/state'),
    saveConfig: (config) => fetchJson<WorkbenchConfigSaveResult>('/whaletv/workbench/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }),
    update: () => fetchJson<WorkbenchUpdateResult>('/whaletv/workbench/update', { method: 'POST' }),
    loadSkills: () => fetchJson<WorkbenchSkillList>('/whaletv/workbench/skills'),
    installSkill: (request: WorkbenchSkillInstallRequest) =>
      fetchJson<WorkbenchSkillInstallResult>('/whaletv/workbench/skills/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    importSkill: (request: WorkbenchSkillImportRequest) =>
      fetchJson<WorkbenchSkillImportResult>('/whaletv/workbench/skills/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    removeSkill: (name: string) =>
      fetchJson<WorkbenchSkillRemoveResult>('/whaletv/workbench/skills/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    followup: (prompt, sessionId) =>
      fetchJson<WorkbenchSessionFollowupResult>('/whaletv/workbench/session/followup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, ...(sessionId !== undefined ? { sessionId } : {}) }),
      }),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      // name = the declared slot key being filled; id = this entry's identity
      // inside the list slot (required for kind 'list').
      name: 'sidebar.footer.action',
      id: 'whaletv-workbench.sidebar',
      store,
      inject: injected,
    },
    SidebarEntry,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'whaletv-workbench.panel',
      store,
      inject: injected,
    },
    WorkbenchPanel,
  ))
  // Settings page card — the `settings.plugin.item` slot is declared
  // `kind: 'list'` (see @deepseek-ai/dsh-client-ui-settings-plugins/client),
  // so registration takes `id` like the other list slots even though the
  // cookbook example spells it as `key`. The Plugins tab renders every
  // registered card in order; the settings namespace connects this card
  // to its Host counterpart through `ctx.settingsScope.bind`, not through
  // the slot key.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    {
      name: 'settings.plugin.item',
      id: 'whaletv-workbench.settings',
      inject: () => ({
        scope: ctx.settingsScope.bind({ namespace: 'whaletv-workbench' }),
      }),
    },
    SettingsCard,
  ))
}
