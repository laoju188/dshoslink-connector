import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
import { registrationLock, registrationPath } from './dsh-registration-storage.js'

export const DESKTOP_HOST_PATH = '/dshos/v1/desktop-host'
export const DESKTOP_PAIRING_PATH = '/dshos/v1/desktop-pairing-capability'
export const DESKTOP_PAIRING_BODY = '{"type":"desktop_pairing_capability","protocolVersion":1,"kind":"desktop"}'
export function desktopPairingCapability(request: PairingV1HttpRequest, desktop: boolean): PairingV1HttpResponse {
  if (request.path !== DESKTOP_PAIRING_PATH || request.method !== 'GET' || request.contentType !== undefined || request.body.length) return { status: 400, body: '' }
  return desktop ? { status: 200, contentType: 'application/json', body: DESKTOP_PAIRING_BODY } : { status: 426, body: '' }
}
export const DESKTOP_SESSIONS_PATH = '/dshos/v1/desktop-sessions'
export const DESKTOP_SESSION_ACTION_PATH = '/dshos/v1/desktop-session-action'
export const DESKTOP_WORKSPACE_ACTION_PATH = '/dshos/v1/desktop-workspace-action'
export type DesktopAction = 'pin' | 'unpin' | 'rename' | 'fork' | 'archive' | 'unarchive'
export type DesktopWorkspaceAction = 'rename' | 'delete'
export interface DesktopWorkspace { workspaceId: string; title: string }
export interface DesktopDirectory { sessions: DesktopSessionRow[]; workspaces: DesktopWorkspace[] }
export interface DesktopWorkspaceOutcome { status: 'applied' | 'not_found' | 'invalid' | 'unknown'; workspaceId: string; title: string }
export interface DesktopSessionRow {
  sessionId: string; title: string; createdAt: number; updatedAt: number
  live: boolean; persisted: boolean; workspaceId: string; workspaceTitle: string
  pinned: boolean; archived: boolean
}
export interface DesktopSessionsSource {
  identity(): { instanceId: string; version: string } | undefined
  owner(): string | undefined
  list(signal?: AbortSignal): Promise<DesktopSessionRow[]>
  directory?(signal?: AbortSignal): Promise<DesktopDirectory>
  workspaceAct?(action: DesktopWorkspaceAction, workspaceId: string, title: string): Promise<DesktopWorkspaceOutcome>
  act(action: DesktopAction, sessionId: string, title: string, stopActivity: boolean): Promise<DesktopActionOutcome>
}
export interface DesktopActionOutcome {
  status: 'applied' | 'active' | 'unavailable' | 'not_found' | 'invalid' | 'unknown'
  sessionId: string
  title: string
}
interface ActionRequest {
  type: 'desktop_session_action'; protocolVersion: 1; action: DesktopAction
  sessionId: string; operationId: string; title: string; stopActivity: boolean
}
function object(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function id(v: unknown): v is string { return typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v) }
function hash(v: string): string { return createHash('sha256').update(v).digest('hex') }
function reply(status: number, value?: unknown): PairingV1HttpResponse {
  return value === undefined ? { status, body: '' } : { status, contentType: 'application/json', body: JSON.stringify(value) }
}
function body(request: PairingV1HttpRequest): Record<string, unknown> | undefined {
  if (request.contentType !== 'application/json' || request.body.length > 4096) return
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body); const v: unknown = JSON.parse(text)
    return object(v) && JSON.stringify(v) === text ? v : undefined
  } catch { return }
}
function actionRequest(v: Record<string, unknown>): ActionRequest | undefined {
  if (Object.keys(v).join(',') !== 'type,protocolVersion,action,sessionId,operationId,title,stopActivity'
    || v.type !== 'desktop_session_action' || v.protocolVersion !== 1
    || !['pin', 'unpin', 'rename', 'fork', 'archive', 'unarchive'].includes(String(v.action))
    || !id(v.sessionId) || typeof v.operationId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(v.operationId)
    || typeof v.title !== 'string' || Array.from(v.title).length > 200 || /[\u0000-\u001f]/.test(v.title)
    || (v.action === 'rename' ? v.title.trim().length === 0 : v.title !== '')
    || typeof v.stopActivity !== 'boolean' || (v.action !== 'archive' && v.stopActivity)) return
  return v as unknown as ActionRequest
}
function validRow(v: DesktopSessionRow): boolean {
  return id(v.sessionId) && typeof v.title === 'string' && v.title.length <= 400
    && Number.isSafeInteger(v.createdAt) && v.createdAt >= 0 && Number.isSafeInteger(v.updatedAt) && v.updatedAt >= 0
    && typeof v.live === 'boolean' && typeof v.persisted === 'boolean' && (v.live || v.persisted)
    && typeof v.workspaceId === 'string' && v.workspaceId.length <= 256 && typeof v.workspaceTitle === 'string'
    && v.workspaceTitle.length <= 400 && typeof v.pinned === 'boolean' && typeof v.archived === 'boolean'
}

// The host fork API assigns a random child ID. Persist intent before invoking it;
// an interrupted intent never permits a new fork, even with a different request ID.
export class DesktopForkJournal {
  constructor(private readonly root: string) {}
  async execute(owner: string, request: ActionRequest, authorized: () => boolean,
    invoke: () => Promise<DesktopActionOutcome>): Promise<DesktopActionOutcome> {
    const directory = join(this.root, hash(owner), hash(request.sessionId))
    const lease = await registrationLock(directory)
    const unknown: DesktopActionOutcome = { status: 'unknown', sessionId: request.sessionId, title: '' }
    try {
      lease.assertHeld()
      const file = join(directory, request.operationId + '.json')
      const files = (await readdir(directory)).filter(f => /^[A-Za-z0-9_-]{22}\.json$/.test(f))
      for (const name of files) {
        await registrationPath(join(directory, name))
        const data = await readFile(join(directory, name), 'utf8')
        if (data.length > 4096) throw Error('fork journal invalid')
        const saved: unknown = JSON.parse(data)
        if (!object(saved) || saved.format !== 1 || !object(saved.request) || !object(saved.outcome)
          || !['applied', 'unknown', 'unavailable', 'not_found', 'invalid'].includes(String(saved.outcome.status))
          || !id(saved.outcome.sessionId) || typeof saved.outcome.title !== 'string') throw Error('fork journal invalid')
        if (name === request.operationId + '.json') {
          if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw Error('fork operation conflict')
          return saved.outcome as unknown as DesktopActionOutcome
        }
        if (saved.outcome.status === 'unknown') return unknown
      }
      if (files.length >= 4096 || !authorized()) throw Error('fork unavailable')
      const persist = async (outcome: DesktopActionOutcome): Promise<void> => {
        lease.assertHeld(); await registrationPath(directory)
        const tmp = file + '.' + randomUUID() + '.tmp'
        const h = await open(tmp, 'wx', 0o600)
        try { await h.writeFile(JSON.stringify({ format: 1, request, outcome })); await h.sync() } finally { await h.close() }
        lease.assertHeld(); await rename(tmp, file)
        const committed = await open(file, 'r+'); try { await committed.sync() } finally { await committed.close() }
        lease.assertHeld()
      }
      await persist(unknown)
      if (!authorized()) { const rejected = { ...unknown, status: 'unavailable' as const }; await persist(rejected); return rejected }
      let result: DesktopActionOutcome
      try { result = await invoke() } catch { return unknown }
      await persist(result)
      return result
    } finally { await lease.release() }
  }
}

export function createDesktopSessionsHandler(authorizer: SessionListAuthorizer,
  source?: DesktopSessionsSource, journal?: DesktopForkJournal) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const path = request.path.split(/[?#]/, 1)[0]
    if (![DESKTOP_HOST_PATH, DESKTOP_SESSIONS_PATH, DESKTOP_SESSION_ACTION_PATH, DESKTOP_WORKSPACE_ACTION_PATH].includes(path!)) return reply(404)
    if (path !== request.path || !(request.body instanceof Uint8Array)) return reply(400)
    const authorized = () => !request.signal?.aborted && authorizer.authorize(request.authorization, request.connectionGeneration)
    if (!authorized()) return reply(401)
    const identity = source?.identity()
    if (!identity || !/^[a-f0-9]{64}$/.test(identity.instanceId)) return reply(426)
    if (path === DESKTOP_HOST_PATH) {
      if (request.method !== 'POST') return reply(405)
      const v = body(request)
      if (!v || Object.keys(v).join(',') !== 'type,protocolVersion' || v.type !== 'desktop_host_request' || v.protocolVersion !== 1) return reply(400)
      return reply(200, { type: 'desktop_host', protocolVersion: 1, kind: 'desktop', ...identity })
    }
    if (request.method !== 'POST') return reply(405)
    const v = body(request); if (!v) return reply(400)
    try {
      if (path === DESKTOP_WORKSPACE_ACTION_PATH) {
        if (Object.keys(v).join(',') !== 'type,protocolVersion,action,workspaceId,operationId,title'
          || v.type !== 'desktop_workspace_action' || v.protocolVersion !== 1 || !['rename', 'delete'].includes(String(v.action))
          || !id(v.workspaceId) || typeof v.operationId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(v.operationId)
          || typeof v.title !== 'string' || Array.from(v.title).length > 200 || /[\u0000-\u001f]/.test(v.title)
          || (v.action === 'rename' ? v.title.trim().length === 0 : v.title !== '')) return reply(400)
        const owner = source!.owner(); if (!owner) return reply(401)
        if (!source!.workspaceAct) return reply(426)
        const result = await source!.workspaceAct(v.action as DesktopWorkspaceAction, v.workspaceId, v.title)
        if (!authorized() || source!.owner() !== owner) return reply(401)
        return reply(200, { type: 'desktop_workspace_result', protocolVersion: 1, operationId: v.operationId, action: v.action, ...result })
      }
      if (path === DESKTOP_SESSIONS_PATH) {
        if (Object.keys(v).join(',') !== 'type,protocolVersion,archived,offset,limit,revision'
          || v.type !== 'desktop_sessions_request' || ![1, 2].includes(Number(v.protocolVersion)) || typeof v.protocolVersion !== 'number' || typeof v.archived !== 'boolean'
          || !Number.isSafeInteger(v.offset) || Number(v.offset) < 0 || !Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 100
          || !(v.revision === null || (typeof v.revision === 'string' && /^[a-f0-9]{64}$/.test(v.revision)))
          || (Number(v.offset) > 0 && v.revision === null)) return reply(400)
        if (v.protocolVersion === 2 && !source!.directory) return reply(426)
        const directory = v.protocolVersion === 2 ? await source!.directory!(request.signal) : undefined
        const rows = directory?.sessions ?? await source!.list(request.signal)
        if (!authorized()) return reply(401)
        if (!rows.every(validRow) || new Set(rows.map(r => r.sessionId)).size !== rows.length) return reply(503)
        const selected = rows.filter(r => r.archived === v.archived)
        let workspaces: { workspaceId: string; title: string; sessionCount: number }[] | undefined
        if (directory) {
          if (directory.workspaces.length > 128 || new Set(directory.workspaces.map(w => w.workspaceId)).size !== directory.workspaces.length
            || directory.workspaces.some(w => !id(w.workspaceId) || typeof w.title !== 'string' || !w.title.length || w.title.length > 400)
            || rows.some(r => r.workspaceId !== '' && !directory.workspaces.some(w => w.workspaceId === r.workspaceId && w.title === r.workspaceTitle))) return reply(503)
          workspaces = [...directory.workspaces, { workspaceId: '', title: '未分组' }].map(w => ({ ...w,
            sessionCount: selected.filter(r => r.workspaceId === w.workspaceId).length }))
          if (v.archived) workspaces = workspaces.filter(w => w.sessionCount > 0)
        }
        const revision = hash(JSON.stringify(workspaces ? [identity.instanceId, v.archived, selected, workspaces] : [identity.instanceId, v.archived, selected]))
        if ((v.revision !== null && v.revision !== revision) || (Number(v.offset) >= selected.length && !(v.offset === 0 && !selected.length))) return reply(409)
        const sessions = selected.slice(Number(v.offset), Number(v.offset) + Number(v.limit))
        const result = { type: 'desktop_sessions', protocolVersion: v.protocolVersion, instanceId: identity.instanceId,
          archived: v.archived, revision, total: selected.length, offset: v.offset,
          nextOffset: Number(v.offset) + sessions.length < selected.length ? Number(v.offset) + sessions.length : null, sessions,
          ...(workspaces ? { workspaces } : {}) }
        return Buffer.byteLength(JSON.stringify(result)) <= 131072 ? reply(200, result) : reply(503)
      }
      const action = actionRequest(v); if (!action) return reply(400)
      const owner = source!.owner(); if (!owner) return reply(401)
      const current = () => authorized() && source!.owner() === owner
      const invoke = () => source!.act(action.action, action.sessionId, action.title, action.stopActivity)
      if (!current()) return reply(401)
      const result = action.action === 'fork' ? await journal?.execute(owner, action, current, invoke) : await invoke()
      if (!current()) return reply(401)
      if (!result) return reply(503)
      return reply(200, { type: 'desktop_session_result', protocolVersion: 1, operationId: action.operationId, action: action.action, ...result })
    } catch { return reply(authorized() ? 503 : 401) }
  }
}
