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
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: ctx.remote (openWorkspacePath) Context merge from the API remotes.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// The client Session object layer. Imported as an explicit type (not the
// ambient `ctx.sessions` merge) because the Host half also pulls in core
// dsh-session's conflicting `sessions: SessionStore` merge into the shared
// tsc program — the cast below picks the client ISessions unambiguously.
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: ctx.slots (SlotRegistry) Context merge, owned by ui-renderer.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// The per-session input resolver, acquired by explicit type for symmetry with
// ISessions above.
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pull the settings-plugins SlotMap merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: pull the uiWorkspace Context merge (startSession navigation).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkbenchInjected } from './contract.ts'
// Type-only: the Host Config type parameterizes the settings scope binding.
import type { Config } from '../index.ts'
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
 * - settingsScope: bound namespace scope reads and writes for the settings card
 * - uiWorkspace: startSession navigation (the workspaces controller no longer
 *   carries it; dsh moved session-start to the uiWorkspace service)
 * - remote / remote.session: Host RPC for the native path opener
 *   (`session.openWorkspacePath` replaced the old client workspaces.openPath)
 * - sessions: current-session selection + per-session scope resolution
 * - conversation: per-session input resolver, to drop `/<skill>` into the
 *   current session's composer
 */
export const inject = [
  'slots', 'settingsScope', 'uiWorkspace', 'remote', 'remote.session', 'sessions', 'conversation',
]

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
      // Inside the Electron desktop client (dsh-web-launcher), hand the URL
      // to the client's own tabbed browser: its window-open handler treats
      // the 'dsh-tab' window feature as "open a client tab" instead of
      // shell.openExternal. Plain browsers ignore the unknown feature and
      // open a normal tab in the default browser.
      const inDesktop = (window as unknown as { dshDesktop?: unknown }).dshDesktop !== undefined
      window.open(url, '_blank', inDesktop ? 'noopener,noreferrer,dsh-tab' : 'noopener,noreferrer')
    },
    openPath: async (path) => {
      // dsh ≥ 0.1.2: native path opening is the session-controller RPC
      // `session.openWorkspacePath` (the client workspaces service lost
      // openPath when the client runtime package was removed).
      const result = await ctx.remote.session.openWorkspacePath({ path })
      if (!result.ok) {
        throw new Error(`打开路径失败：${result.error.message}`)
      }
    },
    startSession: () => {
      ctx.uiWorkspace.startSession()
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
    referenceSkill: (name) => {
      // Reference the skill inline in the CURRENT session: write `/<name>`
      // into its composer draft and let the user send it (dsh's `/` skill
      // trigger resolves it), instead of spawning a new session.
      const sessions = ctx.get('sessions') as unknown as ISessions | undefined
      const conversation = ctx.get('conversation') as unknown as IConversation | undefined
      if (sessions === undefined || conversation === undefined) return { ok: false, reason: 'no-session' }
      const currentId = sessions.list.getSnapshot().current
      if (currentId === undefined) return { ok: false, reason: 'no-session' }
      const actx = sessions.scope(currentId)
      if (actx === undefined) return { ok: false, reason: 'no-session' }
      conversation.input.for(actx).setDraft(`/${name}`)
      return { ok: true }
    },
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
  // `kind: 'keyed'` (see @deepseek-ai/dsh-client-ui-settings-plugins/client)
  // and pairs each card to its Host counterpart by the shared settings
  // namespace. Registration therefore takes `key: '<settings-namespace>'`,
  // not `id`. If a future dsh RC flips this back to `kind: 'list'`, the
  // runtime error will name the missing option again and this pair should
  // change together with the type file.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    {
      name: 'settings.plugin.item',
      key: 'whaletv-workbench',
      inject: () => ({
        scope: ctx.settingsScope.bind<Config>({ namespace: 'whaletv-workbench' }),
      }),
    },
    SettingsCard,
  ))
}
