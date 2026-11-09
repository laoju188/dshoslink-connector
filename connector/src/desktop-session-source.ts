import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { readRuntimeDshKind, readRuntimeDshVersion } from './runtime-version.js'
import type { DesktopAction, DesktopActionOutcome, DesktopSessionRow, DesktopSessionsSource } from './desktop-sessions.js'
import type { SessionListSource } from './session-list.js'

function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(x => typeof x === 'string') }
interface RpcResult { ok: boolean; value?: Record<string, unknown>; error?: { code: string; details: Record<string, unknown> } }
async function rpc(ctx: Context, group: 'sessions' | 'workspace', method: string, payload: Record<string, unknown>): Promise<RpcResult> {
  const api: unknown = ctx.get('apiProxy') ?? ctx.get('dshosNativeApi')
  if (!object(api) || !object(api[group]) || typeof api[group][method] !== 'function') throw Error('desktop API unavailable')
  const service = api[group]; const rpcId = randomUUID()
  const result: unknown = await (service[method] as (r: unknown) => Promise<unknown>).call(service, { rpcId, payload })
  if (!object(result) || result.rpcId !== rpcId || !object(result.result) || typeof result.result.ok !== 'boolean') throw Error('desktop RPC invalid')
  if (result.result.ok && object(result.result.value)) return { ok: true, value: result.result.value }
  if (!result.result.ok && object(result.result.error) && typeof result.result.error.code === 'string' && object(result.result.error.details)) {
    return { ok: false, error: { code: result.result.error.code, details: result.result.error.details } }
  }
  throw Error('desktop RPC invalid')
}
export function createDesktopSessionsSource(ctx: Context, query: SessionListSource,
  owner: () => string | undefined): DesktopSessionsSource {
  const directory: NonNullable<DesktopSessionsSource['directory']> = async (signal) => {
      signal?.throwIfAborted()
      const [listing, workspaces, records] = await Promise.all([
        rpc(ctx, 'sessions', 'list', {}), rpc(ctx, 'workspace', 'list', {}), query.listSessions(signal),
      ])
      signal?.throwIfAborted()
      if (!listing.ok || !workspaces.ok || !Array.isArray(listing.value?.items) || !Array.isArray(workspaces.value?.items)
        || !strings(workspaces.value.archivedSessionIds) || !strings(workspaces.value.pinnedSessionIds)) throw Error('desktop directory unavailable')
      const recordsById = new Map(records.map(r => [r.header.id, r]))
      const summaries = listing.value.items.filter(v => {
        if (!object(v) || typeof v.sessionId !== 'string' || typeof v.blank !== 'boolean' || !Number.isSafeInteger(v.updatedAt)) throw Error('desktop summary invalid')
        // Same ordinary-history membership as Desktop: subagents and unselected provisional blanks stay hidden.
        return !v.blank && v.origin !== 'subagent'
      }) as Record<string, unknown>[]
      const snapshots = await query.readTitleSnapshots(summaries.map(r => String(r.sessionId)), signal)
      const titles = new Map(snapshots.filter(r => r.status === 'fulfilled').map(r => [r.sessionId, r.status === 'fulfilled' ? r.value.title?.title ?? '' : '']))
      const archived = new Set(workspaces.value.archivedSessionIds), pinned = new Set(workspaces.value.pinnedSessionIds)
      const memberships = new Map<string, { id: string; title: string; order: number }>()
      workspaces.value.items.forEach((workspace, index) => {
        if (!object(workspace) || typeof workspace.workspaceId !== 'string' || typeof workspace.title !== 'string' || !strings(workspace.sessionIds)) throw Error('desktop workspace invalid')
        for (const sessionId of workspace.sessionIds) {
          if (memberships.has(sessionId)) throw Error('ambiguous desktop membership')
          memberships.set(sessionId, { id: workspace.workspaceId, title: workspace.title, order: index })
        }
      })
      const rows = summaries.map(s => {
        const sessionId = String(s.sessionId), record = recordsById.get(sessionId)
        if (!record) throw Error('desktop directory changed')
        const workspace = memberships.get(sessionId)
        return { sessionId, title: Array.from(titles.get(sessionId) ?? '').slice(0, 200).join(''),
          createdAt: record.header.createdAt, updatedAt: Number(s.updatedAt), live: record.live, persisted: record.persisted,
          workspaceId: workspace?.id ?? '', workspaceTitle: Array.from(workspace?.title ?? '未分组').slice(0, 200).join(''),
          pinned: pinned.has(sessionId) && !archived.has(sessionId), archived: archived.has(sessionId) } satisfies DesktopSessionRow
      })
      rows.sort((a, b) => (memberships.get(a.sessionId)?.order ?? Number.MAX_SAFE_INTEGER) - (memberships.get(b.sessionId)?.order ?? Number.MAX_SAFE_INTEGER)
        || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId, 'en'))
      return { sessions: rows, workspaces: workspaces.value.items.map(w => {
        const v = w as Record<string, unknown>
        return { workspaceId: String(v.workspaceId), title: Array.from(String(v.title)).slice(0, 200).join('') }
      }) }
  }
  return {
    identity() {
      if (readRuntimeDshKind() !== 'desktop' || !ctx.baseUrl) return
      return { instanceId: createHash('sha256').update('desktop\n' + ctx.baseUrl).digest('hex'), version: readRuntimeDshVersion() }
    },
    owner,
    directory,
    list: async signal => (await directory(signal)).sessions,
    async workspaceAct(action, workspaceId, title) {
      const payload: Record<string, unknown> = { workspaceId }
      if (action === 'rename') payload.title = title
      const result = await rpc(ctx, 'workspace', action, payload)
      const outcome = { status: 'unknown' as 'unknown' | 'applied' | 'invalid' | 'not_found', workspaceId, title: '' }
      if (!result.ok) {
        if (result.error?.code === 'workspace/not-found') outcome.status = 'not_found'
        else if (['workspace/title-invalid', 'workspace/title-conflict', 'workspace/name-conflict', 'gateway/bad-request'].includes(result.error?.code ?? '')) outcome.status = 'invalid'
      } else if (action === 'delete' && result.value?.deleted === true) outcome.status = 'applied'
      else if (action === 'rename' && object(result.value?.workspace) && result.value.workspace.workspaceId === workspaceId
        && typeof result.value.workspace.title === 'string') { outcome.status = 'applied'; outcome.title = result.value.workspace.title }
      return outcome
    },
    async act(action: DesktopAction, sessionId, title, stopActivity): Promise<DesktopActionOutcome> {
      const group = action === 'rename' || action === 'fork' ? 'sessions' : 'workspace'
      const method = group === 'sessions' ? action : action + 'Session'
      const payload: Record<string, unknown> = { sessionId }
      if (action === 'rename') payload.title = title
      if (action === 'archive' && stopActivity) payload.stopActivity = true
      const result = await rpc(ctx, group, method, payload)
      const outcome: DesktopActionOutcome = { status: 'unknown', sessionId, title: '' }
      if (!result.ok) {
        const code = result.error?.code
        if (code === 'workspace/session-active') outcome.status = 'active'
        else if (code === 'session/fork-unavailable') outcome.status = 'unavailable'
        else if (code === 'session/not-found') outcome.status = 'not_found'
        else if (code === 'gateway/bad-request' || code === 'session/title-invalid') outcome.status = 'invalid'
        else if (action === 'fork' && code === 'session/workspace-attach-failed' && typeof result.error?.details.sessionId === 'string') {
          // The child exists even if attachment failed. Return that identity; never fork again.
          outcome.status = 'applied'; outcome.sessionId = result.error.details.sessionId
        }
        return outcome
      }
      if (action === 'fork') {
        if (typeof result.value?.sessionId !== 'string') return outcome
        outcome.sessionId = result.value.sessionId
      } else if (action === 'rename') {
        if (typeof result.value?.title !== 'string') return outcome
        outcome.title = result.value.title
      } else {
        const ids = action === 'pin' || action === 'unpin' ? result.value?.pinnedSessionIds : result.value?.archivedSessionIds
        if (!strings(ids) || ids.includes(sessionId) !== (action === 'pin' || action === 'archive')) return outcome
      }
      outcome.status = 'applied'; return outcome
    },
  }
}
