import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import {
  MAX_SESSION_ID_CHARS,
  type SessionListAuthorizer,
} from './session-list.js'

export const SESSION_STATE_PATH = '/dshos/v1/session-state'
export const SESSION_CANCEL_PATH = '/dshos/v1/session-cancel'
export const SESSION_CONTROL_REQUEST_MAX_BYTES = 4 * 1_024
export const SESSION_CONTROL_RESPONSE_MAX_BYTES = 1_024

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SessionStateRpcRequest {
  readonly rpcId: string
  readonly payload: Record<string, never>
}

export interface SessionCancelRpcRequest {
  readonly rpcId: string
  readonly payload: { readonly sessionId: string }
}

export interface SessionControlSource {
  list(request: SessionStateRpcRequest): Promise<unknown>
  cancel(request: SessionCancelRpcRequest): Promise<unknown>
}

interface SessionControlRequest {
  readonly kind: 'state' | 'cancel'
  readonly sessionId: string
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
  return actual.length === sortedExpected.length
    && actual.every((value, index) => value === sortedExpected[index])
}

function parseRequest(body: Uint8Array, kind: 'state' | 'cancel'): SessionControlRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > SESSION_CONTROL_REQUEST_MAX_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    const expectedType = kind === 'state' ? 'session_state_request' : 'session_cancel_request'
    if (!isObject(value)
      || !sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId'])
      || value.type !== expectedType
      || value.protocolVersion !== 1
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
      || value.sessionId.length > MAX_SESSION_ID_CHARS) return undefined
    if (JSON.stringify({
      type: expectedType,
      protocolVersion: 1,
      sessionId: value.sessionId,
    }) !== text) return undefined
    return { kind, sessionId: value.sessionId }
  } catch {
    return undefined
  }
}

function rejectedResult(value: Record<string, unknown>): boolean {
  return sameFields(Object.keys(value), ['ok', 'error'])
    && value.ok === false
    && isObject(value.error)
    && sameFields(Object.keys(value.error), ['code', 'message', 'details'])
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
    && isObject(value.error.details)
}

function sessionRunning(value: unknown, rpcId: string, sessionId: string): boolean | 'rejected' | undefined {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || typeof value.result.ok !== 'boolean') return undefined
  if (!value.result.ok) return rejectedResult(value.result) ? 'rejected' : undefined
  if (!sameFields(Object.keys(value.result), ['ok', 'value'])
    || !isObject(value.result.value)
    || !sameFields(Object.keys(value.result.value), ['items'])
    || !Array.isArray(value.result.value.items)) return undefined
  let running: boolean | undefined
  for (const item of value.result.value.items) {
    if (!isObject(item) || typeof item.sessionId !== 'string' || typeof item.running !== 'boolean') {
      return undefined
    }
    if (item.sessionId !== sessionId) continue
    if (running !== undefined) return undefined
    running = item.running
  }
  return running ?? 'rejected'
}

function cancelAccepted(value: unknown, rpcId: string): 'accepted' | 'rejected' | undefined {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || typeof value.result.ok !== 'boolean') return undefined
  if (!value.result.ok) return rejectedResult(value.result) ? 'rejected' : undefined
  if (!sameFields(Object.keys(value.result), ['ok', 'value'])
    || !isObject(value.result.value)
    || !sameFields(Object.keys(value.result.value), ['accepted'])
    || value.result.value.accepted !== true) return undefined
  return 'accepted'
}

export function createSessionControlRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionControlSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    const kind = barePath === SESSION_STATE_PATH ? 'state'
      : barePath === SESSION_CANCEL_PATH ? 'cancel' : undefined
    if (kind === undefined) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > SESSION_CONTROL_REQUEST_MAX_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') {
      return emptyResponse(400)
    }
    const parsed = parseRequest(request.body, kind)
    if (parsed === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (request.signal?.aborted) return emptyResponse(503)
    if (source === undefined) return emptyResponse(503)

    const rpcId = randomUUID()
    try {
      if (parsed.kind === 'state') {
        const reply = await source.list({ rpcId, payload: {} })
        if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
        if (request.signal?.aborted) return emptyResponse(503)
        const running = sessionRunning(reply, rpcId, parsed.sessionId)
        if (running === 'rejected') return emptyResponse(409)
        if (running === undefined) return emptyResponse(503)
        return {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            type: 'session_state',
            protocolVersion: 1,
            sessionId: parsed.sessionId,
            running,
          }),
        }
      }
      const result = cancelAccepted(await source.cancel({
        rpcId,
        payload: { sessionId: parsed.sessionId },
      }), rpcId)
      if (result === 'rejected') return emptyResponse(409)
      if (result !== 'accepted') return emptyResponse(503)
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'session_cancel_accepted',
          protocolVersion: 1,
          accepted: true,
        }),
      }
    } catch {
      return emptyResponse(503)
    }
  }
}
