import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'

export const SESSION_CREATE_PATH = '/dshos/v1/session-create'
export const MAX_SESSION_CREATE_REQUEST_BYTES = 1_024
export const MAX_SESSION_CREATE_CONTEXT_BYTES = 131_072
export const MAX_SESSION_CREATE_WORKSPACES = 128

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export type SessionCreateWorkspaceResolution =
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly workspaceId: string }

export interface SessionCreateWorkspaceSource {
  resolveForSessionCreate(): Promise<SessionCreateWorkspaceResolution>
  listForSessionCreate?(): Promise<SessionCreateContext>
  resolveSelectedForSessionCreate?(workspaceId: string): Promise<SessionCreateWorkspaceResolution>
}

export interface SessionCreateContext {
  readonly workspaces: readonly { readonly workspaceId: string; readonly title: string }[]
  readonly defaultWorkspaceId: string | null
}

export interface SessionCreateDshRequest {
  readonly rpcId: string
  readonly payload: {
    readonly workspaceId: string
    readonly sessionId: string
    readonly agentPreset?: string
  }
}

export interface SessionCreateSource {
  create(request: SessionCreateDshRequest): Promise<unknown>
  presets?(request: { readonly rpcId: string; readonly payload: Record<string, never> }): Promise<unknown>
}

interface SessionCreateRequest {
  readonly operationId: string
  readonly workspaceId?: string
  readonly agentPreset?: string
}

interface SessionCreatePreset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly available: boolean
}

function validPresetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

// Built-in IDs and Chinese labels match the host's agent-preset display map.
// This supplies labels only: the roster and availability still come from DSH.
const BUILT_IN_PRESET_LABELS = new Map([
  ['standard', { name: '标准模式', description: '适合日常编程、文档处理和资料整理。' }],
  ['ptc', { name: 'PTC 模式', description: '适合批量调用工具、整理和汇总结果。' }],
  ['minimal', { name: '极简模式', description: '使用终端和图片读取工具，适合简洁任务。' }],
  ['cordis', { name: '创造模式', description: '让 DSH 帮助创建插件和自定义功能。' }],
])

async function readPresets(source: SessionCreateSource | undefined): Promise<{
  agentPresets: SessionCreatePreset[]; defaultAgentPreset: string | null
}> {
  if (source?.presets === undefined) throw new Error('Session modes unavailable')
  const rpcId = randomUUID()
  const response = await source.presets({ rpcId, payload: {} })
  if (!isObject(response) || !sameFields(Object.keys(response), ['rpcId', 'result']) || response.rpcId !== rpcId
    || !isObject(response.result) || !sameFields(Object.keys(response.result), ['ok', 'value']) || response.result.ok !== true
    || !isObject(response.result.value) || !sameFields(Object.keys(response.result.value), ['presets'])
    || !Array.isArray(response.result.value.presets) || response.result.value.presets.length > 64) throw new Error('Invalid modes')
  const agentPresets: SessionCreatePreset[] = []
  const seen = new Set<string>()
  let defaultSeen = false, defaultAgentPreset: string | null = null
  for (const row of response.result.value.presets) {
    if (!isObject(row) || !validPresetId(row.id) || seen.has(row.id) || typeof row.isDefault !== 'boolean'
      || (row.name !== undefined && (typeof row.name !== 'string' || row.name.length === 0 || row.name.length > 256))
      || (row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 2000))) throw new Error('Invalid mode')
    seen.add(row.id)
    const available = row.broken === undefined
    const builtin = BUILT_IN_PRESET_LABELS.get(row.id)
    agentPresets.push({ id: row.id, name: typeof row.name === 'string' ? row.name : (builtin?.name ?? row.id),
      description: typeof row.description === 'string' ? row.description : (builtin?.description ?? ''), available })
    if (row.isDefault) {
      if (defaultSeen) throw new Error('Ambiguous default mode')
      defaultSeen = true
      if (available) defaultAgentPreset = row.id
    }
  }
  return { agentPresets, defaultAgentPreset }
}

type DshCreateResult = 'created' | 'attach_failed' | 'rejected' | 'uncertain'

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameFields(actual: string[], expected: readonly string[]): boolean {
  actual.sort()
  const sortedExpected = [...expected].sort()
  return actual.length === expected.length
    && actual.every((value, index) => value === sortedExpected[index])
}

function validOperationId(value: unknown): value is string {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === 16 && decoded.toString('base64url') === value
}

export function sessionIdForOperation(operationId: string): string {
  if (!validOperationId(operationId)) throw new Error('Invalid session create operation id')
  return `dshos-mobile-${operationId}`
}

function parseRequest(body: Uint8Array): SessionCreateRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_CREATE_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (!isObject(value)
      || value.type !== 'session_create_request'
      || !((value.protocolVersion === 1 && sameFields(Object.keys(value), ['type', 'protocolVersion', 'operationId']))
        || ((value.protocolVersion === 2 && sameFields(Object.keys(value), ['type', 'protocolVersion', 'operationId', 'workspaceId'])
          || (value.protocolVersion === 3 && sameFields(Object.keys(value), ['type', 'protocolVersion', 'operationId', 'workspaceId', 'agentPreset'])
            && validPresetId(value.agentPreset)))
          && typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && value.workspaceId.length <= 256))
      || !validOperationId(value.operationId)
      || JSON.stringify(value) !== text) return undefined
    return { operationId: value.operationId, ...(value.protocolVersion !== 1 ? { workspaceId: value.workspaceId as string } : {}),
      ...(value.protocolVersion === 3 ? { agentPreset: value.agentPreset as string } : {}) }
  } catch {
    return undefined
  }
}

function contextRequestVersion(body: Uint8Array): 2 | 3 | undefined {
  const text = Buffer.from(body).toString('utf8')
  for (const version of [2, 3] as const) {
    if (text === `{"type":"session_create_context_request","protocolVersion":${version}}`) return version
  }
  return undefined
}

function validContext(value: SessionCreateContext): boolean {
  return isObject(value) && sameFields(Object.keys(value), ['workspaces', 'defaultWorkspaceId'])
    && Array.isArray(value.workspaces) && value.workspaces.length <= MAX_SESSION_CREATE_WORKSPACES
    && value.workspaces.every(item => isObject(item) && sameFields(Object.keys(item), ['workspaceId', 'title'])
      && typeof item.workspaceId === 'string' && item.workspaceId.length > 0 && item.workspaceId.length <= 256
      && typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 512)
    && new Set(value.workspaces.map(item => item.workspaceId)).size === value.workspaces.length
    && (value.defaultWorkspaceId === null || value.workspaces.some(item => item.workspaceId === value.defaultWorkspaceId))
}

function validWorkspaceResolution(value: unknown): value is SessionCreateWorkspaceResolution {
  if (!isObject(value) || typeof value.status !== 'string') return false
  if (value.status === 'not_configured' || value.status === 'unavailable') {
    return sameFields(Object.keys(value), ['status'])
  }
  return value.status === 'ready'
    && sameFields(Object.keys(value), ['status', 'workspaceId'])
    && typeof value.workspaceId === 'string'
    && value.workspaceId.length > 0
    && value.workspaceId.length <= 256
}

function classifyDshResponse(
  value: unknown,
  rpcId: string,
  sessionId: string,
  workspaceId: string,
  agentPreset?: string,
  confirmWorkspace: boolean = false,
): DshCreateResult {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || typeof value.result.ok !== 'boolean') return 'uncertain'

  if (value.result.ok) {
    if (!sameFields(Object.keys(value.result), ['ok', 'value'])
      || !isObject(value.result.value)
      || !(sameFields(Object.keys(value.result.value), ['sessionId'])
        || sameFields(Object.keys(value.result.value), ['sessionId', 'agentPreset'])
        || sameFields(Object.keys(value.result.value), ['sessionId', 'workspaceId'])
        || sameFields(Object.keys(value.result.value), ['sessionId', 'workspaceId', 'agentPreset']))
      || value.result.value.sessionId !== sessionId
      || (confirmWorkspace && value.result.value.workspaceId !== workspaceId)
      || (value.result.value.workspaceId !== undefined && value.result.value.workspaceId !== workspaceId)
      || (value.result.value.agentPreset !== undefined
        && typeof value.result.value.agentPreset !== 'string')
      || (agentPreset !== undefined && value.result.value.agentPreset !== agentPreset)) return 'uncertain'
    return 'created'
  }

  if (!sameFields(Object.keys(value.result), ['ok', 'error'])
    || !isObject(value.result.error)
    || !sameFields(Object.keys(value.result.error), ['code', 'message', 'details'])
    || typeof value.result.error.code !== 'string'
    || typeof value.result.error.message !== 'string'
    || !isObject(value.result.error.details)) return 'uncertain'

  if (value.result.error.code === 'workspace-attach-failed' || value.result.error.code === 'session/workspace-attach-failed') {
    return sameFields(Object.keys(value.result.error.details), ['sessionId', 'workspaceId'])
      && value.result.error.details.sessionId === sessionId
      && value.result.error.details.workspaceId === workspaceId
      ? 'attach_failed'
      : 'uncertain'
  }
  return ['internal', 'gateway/internal', 'session/create-pending', 'session/create-unconfirmed'].includes(value.result.error.code) ? 'uncertain' : 'rejected'
}

async function createThroughDsh(
  source: SessionCreateSource,
  workspaceId: string,
  sessionId: string,
  agentPreset?: string,
  confirmWorkspace: boolean = false,
): Promise<DshCreateResult> {
  const rpcId = randomUUID()
  return classifyDshResponse(await source.create({
    rpcId,
    payload: { workspaceId, sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) },
  }), rpcId, sessionId, workspaceId, agentPreset, confirmWorkspace)
}

export function createSessionCreateRequestHandler(
  authorizer: SessionListAuthorizer,
  workspaceSource?: SessionCreateWorkspaceSource,
  source?: SessionCreateSource,
  ) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_CREATE_PATH) return emptyResponse(404)
    if (request.method !== 'GET' && request.method !== 'POST') return emptyResponse(405)
    if (request.path !== barePath || !(request.body instanceof Uint8Array)) {
      return emptyResponse(400)
    }
    let parsed: SessionCreateRequest | undefined
    let contextRequest: 2 | 3 | undefined
    if (request.method === 'GET') {
      if (request.contentType !== undefined || request.body.byteLength !== 0) {
        return emptyResponse(400)
      }
    } else {
      if (request.body.byteLength > MAX_SESSION_CREATE_REQUEST_BYTES) return emptyResponse(413)
      if (request.contentType !== 'application/json') return emptyResponse(400)
      contextRequest = contextRequestVersion(request.body)
      if (!contextRequest) {
        parsed = parseRequest(request.body)
        if (parsed === undefined) return emptyResponse(400)
      }
    }
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (workspaceSource === undefined) return emptyResponse(503)

    if (contextRequest) {
      if (workspaceSource.listForSessionCreate === undefined) return emptyResponse(400)
      try {
        const context = await workspaceSource.listForSessionCreate()
        const modes = contextRequest === 3 ? await readPresets(source) : {}
        if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
        if (!validContext(context)) return emptyResponse(503)
        const body = JSON.stringify({ type: 'session_create_context', protocolVersion: contextRequest, ...context, ...modes })
        if (Buffer.byteLength(body) > MAX_SESSION_CREATE_CONTEXT_BYTES) return emptyResponse(503)
        return { status: 200, contentType: 'application/json', body }
      } catch { return emptyResponse(503) }
    }

    let workspace: SessionCreateWorkspaceResolution
    try {
      if (parsed?.workspaceId !== undefined) {
        if (workspaceSource.resolveSelectedForSessionCreate === undefined) return emptyResponse(400)
        workspace = await workspaceSource.resolveSelectedForSessionCreate(parsed.workspaceId)
        if (workspace.status === 'ready' && workspace.workspaceId !== parsed.workspaceId) return emptyResponse(503)
      } else {
        workspace = await workspaceSource.resolveForSessionCreate()
      }
    } catch {
      return emptyResponse(503)
    }
    if (!validWorkspaceResolution(workspace)) return emptyResponse(503)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)

    if (request.method === 'GET') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'session_create_capability',
          protocolVersion: 1,
          status: workspace.status,
        }),
      }
    }

    if (parsed === undefined) return emptyResponse(400)
    if (workspace.status !== 'ready') return emptyResponse(409)
    if (source === undefined) return emptyResponse(503)
    if (parsed.agentPreset !== undefined) {
      try {
        const modes = await readPresets(source)
        if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
        if (!modes.agentPresets.some(item => item.id === parsed.agentPreset && item.available)) return emptyResponse(422)
      } catch { return emptyResponse(503) }
    }
    const sessionId = sessionIdForOperation(parsed.operationId)
    try {
      const result = await createThroughDsh(source, workspace.workspaceId, sessionId, parsed.agentPreset, parsed.workspaceId !== undefined)
      if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
      if (result === 'rejected') return emptyResponse(409)
      if (result !== 'created') return emptyResponse(503)
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'session_created', protocolVersion: parsed.workspaceId === undefined ? 1 : 2, sessionId,
          ...(parsed.workspaceId === undefined ? {} : { operationId: parsed.operationId,
            workspaceId: workspace.workspaceId, agentPreset: parsed.agentPreset ?? null }),
        }),
      }
    } catch {
      return emptyResponse(503)
    }
  }
}
