/**
 * whaletv-workbench browser half: two slot registrations sharing one store.
 *
 * - SidebarEntry fills `sidebar.footer.action` (the actions beside Settings
 *   at the sidebar foot) with the WhaleTV workbench trigger.
 * - WorkbenchPanel fills `shell.overlay` (the frame-wide floating layer) with
 *   the workbench dashboard: grouped entry cards (web/docs/apps/skills),
 *   search, and the one-click update flow.
 *
 * Both slots are declared by the shipped shell; `ctx.slots.inject` waits on
 * each declaration, so apply order against ui-sidebar/ui-layout is free.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkbenchInjected } from './contract.ts'
import type {
  WorkbenchConfigSaveResult, WorkbenchState, WorkbenchUpdateResult,
} from '../shared.ts'
import { createWorkbenchStore } from './store.ts'
import { SidebarEntry } from './SidebarEntry.tsx'
import { WorkbenchPanel } from './WorkbenchPanel.tsx'

export type { SidebarEntryProps, WorkbenchPanelProps, WorkbenchInjected } from './contract.ts'
export type { WorkbenchItem, WorkbenchGroup, WorkbenchConfig, WorkbenchState, WorkbenchUpdateResult } from '../shared.ts'

/** Required services: slot declarations plus the Host openPath action. */
export const inject = ['slots', 'workspaces']

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
 * Register the workbench trigger and panel once their slot declarations are
 * on the ledger; one store handle shared by both registrations.
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
}
