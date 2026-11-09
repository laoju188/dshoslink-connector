import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'

export const SESSION_MODELS_PATH = '/dshos/v1/session-models'
export const SESSION_MODEL_SELECT_PATH = '/dshos/v1/session-model-select'
export const MAX_SESSION_MODEL_REQUEST_BYTES = 4 * 1_024
export const SESSION_MODELS_RESPONSE_MAX_BYTES = 256 * 1_024
export const SESSION_MODEL_SELECT_RESPONSE_MAX_BYTES = 4 * 1_024

const MAX_ID_CHARS = 256
const MAX_NAME_CHARS = 256
const MAX_DESCRIPTION_CHARS = 2_000
const MAX_PROVIDER_GROUPS = 32
const MAX_MODELS_PER_GROUP = 128
const MAX_PROVIDER_SCAN = 256
const MAX_MODEL_ID_SCAN = 4096
const MAX_REASONING_EFFORTS = 16
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SessionModelRpcRequest {
  readonly rpcId: string
  readonly payload: { readonly sessionId: string }
}

export interface SessionModelSelectRpcRequest {
  readonly rpcId: string
  readonly payload: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }
}

export interface SessionModelSource {
  models(request: SessionModelRpcRequest): Promise<unknown>
  newSessionModels?(request: { readonly rpcId: string; readonly payload: Record<string, never> }): Promise<unknown>
  selectModel(request: SessionModelSelectRpcRequest): Promise<unknown>
}

interface SessionModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface SessionModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

interface SessionModelReasoning {
  readonly efforts: readonly SessionModelReasoningEffort[]
  readonly defaultEffort?: string
}

interface SessionModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: SessionModelReasoning
}

interface SessionModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly SessionModel[]
}

interface SessionModelCatalog {
  readonly current: SessionModelSelection
  readonly routable: boolean
  readonly partial: boolean
  readonly groups: readonly SessionModelGroup[]
}

type ParsedRequest = {
  readonly kind: 'new-session-models'
} | {
  readonly kind: 'models'
  readonly sessionId: string
} | {
  readonly kind: 'select'
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

type SelectOutcome = {
  readonly kind: 'selected'
  readonly selected: SessionModelSelection
} | {
  readonly kind: 'rejected' | 'invalid'
}

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

function boundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Array.from(value).length <= maxChars
}

function optionalFields(value: Record<string, unknown>, base: readonly string[], optional: string): boolean {
  const expected = value[optional] === undefined ? base : [...base, optional]
  return sameFields(Object.keys(value), expected)
}

function parseRequest(path: string, body: Uint8Array): ParsedRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_MODEL_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (path === SESSION_MODELS_PATH && isObject(value)
      && value.type === 'new_session_models_request' && value.protocolVersion === 2
      && sameFields(Object.keys(value), ['type', 'protocolVersion'])
      && JSON.stringify(value) === text) return { kind: 'new-session-models' }
    if (!isObject(value)
      || value.protocolVersion !== 1
      || !boundedString(value.sessionId, MAX_ID_CHARS)
      || JSON.stringify(value) !== text) return undefined
    if (path === SESSION_MODELS_PATH) {
      if (!sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId'])
        || value.type !== 'session_models_request') return undefined
      return { kind: 'models', sessionId: value.sessionId }
    }
    if (path === SESSION_MODEL_SELECT_PATH) {
      if (!optionalFields(
        value,
        ['type', 'protocolVersion', 'sessionId', 'provider', 'model'],
        'reasoningEffort',
      )
        || value.type !== 'session_model_select_request'
        || !boundedString(value.provider, MAX_ID_CHARS)
        || !boundedString(value.model, MAX_ID_CHARS)
        || (value.reasoningEffort !== undefined
          && !boundedString(value.reasoningEffort, MAX_ID_CHARS))) return undefined
      return {
        kind: 'select',
        sessionId: value.sessionId,
        provider: value.provider,
        model: value.model,
        ...(value.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: value.reasoningEffort }),
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function projectSelection(value: unknown): SessionModelSelection {
  if (!isObject(value)
    || !optionalFields(value, ['provider', 'model'], 'reasoningEffort')
    || !boundedString(value.provider, MAX_ID_CHARS)
    || !boundedString(value.model, MAX_ID_CHARS)
    || (value.reasoningEffort !== undefined
      && !boundedString(value.reasoningEffort, MAX_ID_CHARS))) {
    throw new Error('invalid model selection')
  }
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort }),
  }
}

function projectReasoningEffort(value: unknown): SessionModelReasoningEffort {
  if (!isObject(value)
    || !optionalFields(value, ['id', 'name'], 'description')
    || !boundedString(value.id, MAX_ID_CHARS)
    || !boundedString(value.name, MAX_NAME_CHARS)
    || (value.description !== undefined
      && !boundedString(value.description, MAX_DESCRIPTION_CHARS))) {
    throw new Error('invalid reasoning effort')
  }
  return {
    id: value.id,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
  }
}

function projectReasoning(value: unknown): SessionModelReasoning {
  if (!isObject(value)
    || !optionalFields(value, ['efforts'], 'defaultEffort')
    || !Array.isArray(value.efforts)
    || value.efforts.length === 0
    || value.efforts.length > MAX_REASONING_EFFORTS
    || (value.defaultEffort !== undefined
      && !boundedString(value.defaultEffort, MAX_ID_CHARS))) {
    throw new Error('invalid reasoning')
  }
  const ids = new Set<string>()
  const efforts = value.efforts.map((item: unknown) => {
    const effort = projectReasoningEffort(item)
    if (ids.has(effort.id)) throw new Error('duplicate reasoning effort')
    ids.add(effort.id)
    return effort
  })
  if (value.defaultEffort !== undefined && !ids.has(value.defaultEffort)) {
    throw new Error('invalid default reasoning effort')
  }
  return {
    efforts,
    ...(value.defaultEffort === undefined ? {} : { defaultEffort: value.defaultEffort }),
  }
}

function projectModel(value: unknown): SessionModel {
  if (!isObject(value)
    || !sameFields(
      Object.keys(value),
      ['id', 'name', ...(value.description === undefined ? [] : ['description']),
        ...(value.reasoning === undefined ? [] : ['reasoning'])],
    )
    || !boundedString(value.id, MAX_ID_CHARS)
    || !boundedString(value.name, MAX_NAME_CHARS)
    || (value.description !== undefined
      && !boundedString(value.description, MAX_DESCRIPTION_CHARS))) {
    throw new Error('invalid model')
  }
  return {
    id: value.id,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.reasoning === undefined ? {} : { reasoning: projectReasoning(value.reasoning) }),
  }
}

function projectGroup(value: unknown, selectedModel?: string): SessionModelGroup {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['id', 'name', 'models'])
    || !boundedString(value.id, MAX_ID_CHARS)
    || !boundedString(value.name, MAX_NAME_CHARS)
    || !Array.isArray(value.models)
    || value.models.length > MAX_MODEL_ID_SCAN) {
    throw new Error('invalid model group')
  }
  const ids = new Set<string>()
  // Check all bounded IDs before truncation: an unseen duplicate must not make
  // a displayed ID select a different entry in the desktop provider.
  for (const item of value.models) {
    if (!isObject(item) || !boundedString(item.id,MAX_ID_CHARS) || ids.has(item.id)) throw new Error('ambiguous model')
    ids.add(item.id)
  }
  let items: unknown[] = value.models
  if (items.length > MAX_MODELS_PER_GROUP && selectedModel !== undefined) {
    const selected = items.findIndex(item => isObject(item) && item.id === selectedModel)
    if (selected >= MAX_MODELS_PER_GROUP) items = [items[selected],...items.slice(0,MAX_MODELS_PER_GROUP-1)]
  }
  const models = items.slice(0,MAX_MODELS_PER_GROUP).map((item: unknown) => {
    const model = projectModel(item)
    // Official 2026-10-17 release keeps the deepseek-flash API id. Only expand the
    // known abbreviated default label; preserve custom, explicit and future names.
    if ((value.id === 'deepseek-official' || value.id === 'deepseek-account')
      && model.id === 'deepseek-flash' && model.name === 'DeepSeek-V4.1-Flash') {
      return { ...model, name: 'V4.1-Flash-1017' }
    }
    return model
  })
  return { id: value.id, name: value.name, models }
}

export function projectCatalog(value: unknown, rpcId: string): SessionModelCatalog {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || !sameFields(Object.keys(value.result), ['ok', 'value'])
    || value.result.ok !== true
    || !isObject(value.result.value)
    || !sameFields(Object.keys(value.result.value), ['current', 'routable', 'groups', 'failures'])
    || typeof value.result.value.routable !== 'boolean'
    || !Array.isArray(value.result.value.groups)
    || value.result.value.groups.length > MAX_PROVIDER_SCAN
    || !Array.isArray(value.result.value.failures)) {
    throw new Error('invalid model catalog')
  }
  const current = projectSelection(value.result.value.current)
  let partial = value.result.value.failures.length > 0
  const providerIds = new Set<string>()
  for (const item of value.result.value.groups) {
    if (isObject(item) && boundedString(item.id,MAX_ID_CHARS)) {
      if (providerIds.has(item.id)) throw new Error('duplicate provider')
      providerIds.add(item.id)
    }
  }
  let sourceGroups: unknown[] = value.result.value.groups
  if (sourceGroups.length > MAX_PROVIDER_GROUPS) {
    partial = true
    const selected = sourceGroups.findIndex(item => isObject(item) && item.id === current.provider)
    if (selected > 0) sourceGroups = [sourceGroups[selected],...sourceGroups.slice(0,selected),...sourceGroups.slice(selected+1)]
  }
  let groups: SessionModelGroup[] = []
  for (const item of sourceGroups) {
    if (groups.length >= MAX_PROVIDER_GROUPS) { partial = true; break }
    try {
      const group = projectGroup(item,isObject(item) && item.id === current.provider ? current.model : undefined)
      if (isObject(item) && Array.isArray(item.models) && item.models.length > group.models.length) partial = true
      groups.push(group)
    } catch { partial = true /* A faulty provider does not hide other usable providers. */ }
  }
  for (const failure of value.result.value.failures) {
    if (!isObject(failure)
      || !sameFields(Object.keys(failure), ['id', 'name', 'message'])
      || !boundedString(failure.id, MAX_ID_CHARS)
      || !boundedString(failure.name, MAX_NAME_CHARS)
      || !boundedString(failure.message, MAX_DESCRIPTION_CHARS)) {
      throw new Error('invalid model catalog failure')
    }
  }
  // Keep the phone's existing count and byte limits. Partial coverage is already
  // part of its protocol; never turn a large catalog into an oversized response.
  const budget = SESSION_MODELS_RESPONSE_MAX_BYTES - 8192
  if (groups.length > MAX_PROVIDER_GROUPS || Buffer.byteLength(JSON.stringify(groups)) > budget) {
    partial = true
    const selected = groups.findIndex(group => group.id === current.provider)
    if (selected > 0) groups = [groups[selected]!,...groups.slice(0,selected),...groups.slice(selected+1)]
    groups = groups.slice(0,MAX_PROVIDER_GROUPS)
    let remaining = budget
    const fitted: SessionModelGroup[] = []
    for (const group of groups) {
      const overhead = Buffer.byteLength(JSON.stringify({id:group.id,name:group.name,models:[]}))+2
      if (overhead >= remaining) break
      remaining -= overhead
      let candidates = group.models
      if (group.id === current.provider) {
        const selected = candidates.findIndex(model => model.id === current.model)
        if (selected > 0) candidates = [candidates[selected]!,...candidates.slice(0,selected),...candidates.slice(selected+1)]
      }
      const models: SessionModel[] = []
      for (const model of candidates) {
        const bytes = Buffer.byteLength(JSON.stringify(model))+1
        if (bytes > remaining) break
        models.push(model); remaining -= bytes
      }
      fitted.push({id:group.id,name:group.name,models})
    }
    groups = fitted
  }
  return {
    current,
    routable: value.result.value.routable,
    partial,
    groups,
  }
}

function modelAllowed(catalog: SessionModelCatalog, request: Extract<ParsedRequest, { kind: 'select' }>): boolean {
  const group = catalog.groups.find(item => item.id === request.provider)
  const model = group?.models.find(item => item.id === request.model)
  if (model === undefined) return false
  if (request.reasoningEffort === undefined) return true
  return model.reasoning?.efforts.some(item => item.id === request.reasoningEffort) === true
}

function selectOutcome(value: unknown, rpcId: string): SelectOutcome {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || typeof value.result.ok !== 'boolean') return { kind: 'invalid' }
  if (!value.result.ok) {
    if (!sameFields(Object.keys(value.result), ['ok', 'error'])
      || !isObject(value.result.error)
      || !sameFields(Object.keys(value.result.error), ['code', 'message', 'details'])
      || typeof value.result.error.code !== 'string'
      || typeof value.result.error.message !== 'string'
      || !isObject(value.result.error.details)) return { kind: 'invalid' }
    return { kind: 'rejected' }
  }
  try {
    if (!sameFields(Object.keys(value.result), ['ok', 'value'])
      || !isObject(value.result.value)
      || !sameFields(Object.keys(value.result.value), ['selected'])) return { kind: 'invalid' }
    return { kind: 'selected', selected: projectSelection(value.result.value.selected) }
  } catch {
    return { kind: 'invalid' }
  }
}

function selectedMatches(
  selected: SessionModelSelection,
  request: Extract<ParsedRequest, { kind: 'select' }>,
): boolean {
  return selected.provider === request.provider
    && selected.model === request.model
    && (request.reasoningEffort === undefined
      || selected.reasoningEffort === request.reasoningEffort)
}

export function createSessionModelRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionModelSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_MODELS_PATH && barePath !== SESSION_MODEL_SELECT_PATH) {
      return emptyResponse(404)
    }
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_MODEL_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') {
      return emptyResponse(400)
    }
    const parsed = parseRequest(barePath, request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (request.signal?.aborted) return emptyResponse(503)
    if (source === undefined) return emptyResponse(503)

    try {
      const modelsRpcId = randomUUID()
      if (parsed.kind === 'new-session-models') {
        if (source.newSessionModels === undefined) return emptyResponse(503)
        const catalog = projectCatalog(await source.newSessionModels({ rpcId: modelsRpcId, payload: {} }), modelsRpcId)
        if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
        if (request.signal?.aborted) return emptyResponse(503)
        const body = JSON.stringify({ type: 'new_session_models', protocolVersion: 2,
          current: catalog.current, routable: catalog.routable, partial: catalog.partial, groups: catalog.groups })
        if (Buffer.byteLength(body) > SESSION_MODELS_RESPONSE_MAX_BYTES) return emptyResponse(503)
        return { status: 200, contentType: 'application/json', body }
      }
      const catalog = projectCatalog(await source.models({
        rpcId: modelsRpcId,
        payload: { sessionId: parsed.sessionId },
      }), modelsRpcId)
      // Catalog lookup can outlive a logout, unpair, or a new authenticated connection.
      // Recheck before returning private data or dispatching the model change.
      if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
      if (request.signal?.aborted) return emptyResponse(503)
      if (parsed.kind === 'models') {
        const body = JSON.stringify({
          type: 'session_models',
          protocolVersion: 1,
          sessionId: parsed.sessionId,
          current: catalog.current,
          routable: catalog.routable,
          partial: catalog.partial,
          groups: catalog.groups,
        })
        if (Buffer.byteLength(body) > SESSION_MODELS_RESPONSE_MAX_BYTES) {
          return emptyResponse(503)
        }
        return { status: 200, contentType: 'application/json', body }
      }
      if (!modelAllowed(catalog, parsed)) return emptyResponse(409)

      const rpcId = randomUUID()
      const outcome = selectOutcome(await source.selectModel({
        rpcId,
        payload: {
          sessionId: parsed.sessionId,
          provider: parsed.provider,
          model: parsed.model,
          ...(parsed.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: parsed.reasoningEffort }),
        },
      }), rpcId)
      if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
      if (request.signal?.aborted) return emptyResponse(503)
      if (outcome.kind === 'rejected') return emptyResponse(409)
      if (outcome.kind !== 'selected' || !selectedMatches(outcome.selected, parsed)) {
        return emptyResponse(503)
      }
      const body = JSON.stringify({
        type: 'session_model_selected',
        protocolVersion: 1,
        sessionId: parsed.sessionId,
        selected: outcome.selected,
      })
      if (Buffer.byteLength(body) > SESSION_MODEL_SELECT_RESPONSE_MAX_BYTES) {
        return emptyResponse(503)
      }
      return { status: 200, contentType: 'application/json', body }
    } catch {
      return emptyResponse(503)
    }
  }
}
