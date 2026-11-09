import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
import { projectCatalog, type SessionModelRpcRequest } from './session-model.js'
import { projectBalance, type SessionBalance } from './session-balance.js'

export const SESSION_USAGE_PATH = '/dshos/v1/session-usage'
export const MAX_SESSION_USAGE_REQUEST_BYTES = 4 * 1_024
export const SESSION_USAGE_RESPONSE_MAX_BYTES = 4 * 1_024

const MAX_ID_CHARS = 256
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SessionUsageRpcRequest {
  readonly rpcId: string
  readonly payload: {
    readonly sessionId: string
    readonly maxMessages: 1
  }
}

export interface SessionUsageSource {
  history(request: SessionUsageRpcRequest): Promise<unknown>
  models?(request: SessionModelRpcRequest): Promise<unknown>
  balance?(provider: string): Promise<unknown>
  balanceRevision?(provider: string): unknown
}

interface SessionTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

/** Display cents only; keep upstream money and accounting calculations unchanged. */
function displayBalance(balance: SessionBalance): SessionBalance {
  if (balance.status !== 'available') return balance
  const negative = balance.totalBalance.startsWith('-')
  const [whole, fraction = ''] = (negative ? balance.totalBalance.slice(1) : balance.totalBalance).split('.')
  let cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
  if ((fraction[2] ?? '0') >= '5') cents++
  const digits = cents.toString().padStart(3, '0')
  // The unchanged phone contract accepts at most 16 integer digits.
  if (digits.length > 18) return { status: 'query_failed' }
  const totalBalance = (negative && cents !== 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2)
  return { status: 'available', currency: balance.currency, totalBalance }
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

function parseRequest(body: Uint8Array): { sessionId: string; version: 1 | 2 } | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_USAGE_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (!isObject(value)
      || !sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId'])
      || value.type !== 'session_usage_request'
      || (value.protocolVersion !== 1 && value.protocolVersion !== 2)
      || !boundedString(value.sessionId, MAX_ID_CHARS)
      || JSON.stringify(value) !== text) return undefined
    return { sessionId: value.sessionId, version: value.protocolVersion }
  } catch {
    return undefined
  }
}

function tokenCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('invalid token usage')
  }
  return Number(value)
}

function projectUsage(value: unknown, rpcId: string): SessionTokenUsage | null {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || !sameFields(Object.keys(value.result), ['ok', 'value'])
    || value.result.ok !== true
    || !isObject(value.result.value)
    || !sameFields(
      Object.keys(value.result.value),
      ['events', 'hasMore', ...(value.result.value.projections === undefined ? [] : ['projections'])],
    )
    || !Array.isArray(value.result.value.events)
    || typeof value.result.value.hasMore !== 'boolean') {
    throw new Error('invalid session history')
  }
  const projections = value.result.value.projections
  if (projections === undefined) return null
  if (!isObject(projections)
    || !sameFields(Object.keys(projections), ['asOfSeq', 'values'])
    || !Number.isSafeInteger(projections.asOfSeq)
    || Number(projections.asOfSeq) < -1
    || !isObject(projections.values)) {
    throw new Error('invalid session projections')
  }
  const usage = projections.values.tokenUsage
  if (usage === undefined) return null
  if (!isObject(usage)
    || !sameFields(Object.keys(usage), [
      'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    ])) {
    throw new Error('invalid token usage')
  }
  return {
    uncachedInputTokens: tokenCount(usage.uncachedInputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
  }
}

export function createSessionUsageRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionUsageSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_USAGE_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_USAGE_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') {
      return emptyResponse(400)
    }
    const parsed = parseRequest(request.body)
    if (parsed === undefined) return emptyResponse(400)
    const { sessionId, version } = parsed
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (source === undefined) return emptyResponse(503)

    try {
      const rpcId = randomUUID()
      const usage = projectUsage(await source.history({
        rpcId,
        payload: { sessionId, maxMessages: 1 },
      }), rpcId)
      const authorized = () => authorizer.authorize(request.authorization, request.connectionGeneration)
      if (!authorized()) return emptyResponse(401)
      let extra: { provider: string; model: string; balance: SessionBalance } | undefined
      if (version === 2) {
        if (source.models === undefined) return emptyResponse(503)
        const beforeId = randomUUID()
        const before = projectCatalog(await source.models({ rpcId: beforeId, payload: { sessionId } }), beforeId)
        if (!authorized()) return emptyResponse(401)
        let balance: SessionBalance = { status: 'unsupported' }
        const balanceRevision = source.balanceRevision?.(before.current.provider)
        if (before.routable && (before.current.provider === 'deepseek-official'
          || before.current.provider === 'deepseek-account') && source.balance !== undefined) {
          try { balance = projectBalance(await source.balance(before.current.provider)) } catch { balance = { status: 'query_failed' } }
        }
        if (!authorized()) return emptyResponse(401)
        const afterId = randomUUID()
        const after = projectCatalog(await source.models({ rpcId: afterId, payload: { sessionId } }), afterId)
        if (!authorized()) return emptyResponse(401)
        if (before.current.provider !== after.current.provider || before.current.model !== after.current.model
          || before.routable !== after.routable
          || balanceRevision !== source.balanceRevision?.(before.current.provider)) return emptyResponse(409)
        extra = { provider: after.current.provider, model: after.current.model, balance }
      }
      const body = JSON.stringify({
        type: 'session_usage',
        protocolVersion: version,
        sessionId,
        ...(extra === undefined ? {} : { provider: extra.provider, model: extra.model }),
        usage,
        ...(extra === undefined ? {} : { balance: displayBalance(extra.balance) }),
      })
      if (Buffer.byteLength(body) > SESSION_USAGE_RESPONSE_MAX_BYTES) {
        return emptyResponse(503)
      }
      return { status: 200, contentType: 'application/json', body }
    } catch {
      return emptyResponse(503)
    }
  }
}
