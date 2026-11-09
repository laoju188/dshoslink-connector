import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import {
  MAX_SESSION_ID_CHARS,
  type SessionListAuthorizer,
} from './session-list.js'

export const SESSION_MESSAGE_PATH = '/dshos/v1/session-message'
export const MAX_SESSION_MESSAGE_REQUEST_BYTES = 16 * 1_024
export const MAX_SESSION_PROMPT_CHARS = 2_000

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SessionMessagePromptRequest {
  readonly rpcId: string
  readonly payload: {
    readonly sessionId: string
    readonly mode: 'queue' | 'steer'
    readonly content: readonly (
      | { readonly type: 'text'; readonly text: string }
      | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly name: string }
    )[]
  }
}

export interface SessionMessageSource {
  prompt(request: SessionMessagePromptRequest): Promise<unknown>
}

interface SessionMessageRequest {
  readonly protocolVersion: 2 | 3
  readonly sessionId: string
  readonly operationId: string
  readonly mode: 'queue' | 'steer'
  readonly text: string
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

function validOperationId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) return false
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.byteLength === 16 && decoded.toString('base64url') === value
  } catch {
    return false
  }
}

function parseRequest(body: Uint8Array): SessionMessageRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_MESSAGE_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (!isObject(value)
      || value.type !== 'session_message_request'
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
      || value.sessionId.length > MAX_SESSION_ID_CHARS
      || !validOperationId(value.operationId)
      || typeof value.text !== 'string'
      || value.text.trim().length === 0
      || value.text.startsWith('/')
      || Array.from(value.text).length > MAX_SESSION_PROMPT_CHARS) return undefined
    if (value.protocolVersion === 2
      && sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId', 'operationId', 'text'])
      && JSON.stringify({
        type: 'session_message_request',
        protocolVersion: 2,
        sessionId: value.sessionId,
        operationId: value.operationId,
        text: value.text,
      }) === text) {
      return {
        protocolVersion: 2,
        sessionId: value.sessionId,
        operationId: value.operationId,
        mode: 'queue',
        text: value.text,
      }
    }
    if (value.protocolVersion === 3
      && sameFields(Object.keys(value), [
        'type', 'protocolVersion', 'sessionId', 'operationId', 'mode', 'text',
      ])
      && (value.mode === 'queue' || value.mode === 'steer')
      && JSON.stringify({
        type: 'session_message_request',
        protocolVersion: 3,
        sessionId: value.sessionId,
        operationId: value.operationId,
        mode: value.mode,
        text: value.text,
      }) === text) {
      return {
        protocolVersion: 3,
        sessionId: value.sessionId,
        operationId: value.operationId,
        mode: value.mode,
        text: value.text,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function responseKind(value: unknown, rpcId: string): 'accepted' | 'rejected' | 'invalid' {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['rpcId', 'result'])
    || value.rpcId !== rpcId
    || !isObject(value.result)
    || typeof value.result.ok !== 'boolean') return 'invalid'
  if (!value.result.ok) {
    if (!sameFields(Object.keys(value.result), ['ok', 'error'])
      || !isObject(value.result.error)
      || !sameFields(Object.keys(value.result.error), ['code', 'message', 'details'])
      || typeof value.result.error.code !== 'string'
      || typeof value.result.error.message !== 'string'
      || !isObject(value.result.error.details)) return 'invalid'
    return 'rejected'
  }
  if (!sameFields(Object.keys(value.result), ['ok', 'value'])
    || !isObject(value.result.value)
    || !sameFields(Object.keys(value.result.value), ['accepted'])
    || value.result.value.accepted !== true) return 'invalid'
  return 'accepted'
}

export function createSessionMessageRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionMessageSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_MESSAGE_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_MESSAGE_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return emptyResponse(400)
    const parsed = parseRequest(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (source === undefined) return emptyResponse(503)

    const rpcId = parsed.operationId
    try {
      const result = responseKind(await source.prompt({
        rpcId,
        payload: {
          sessionId: parsed.sessionId,
          mode: parsed.mode,
          content: [{ type: 'text', text: parsed.text }],
        },
      }), rpcId)
      if (result === 'rejected') return emptyResponse(409)
      if (result !== 'accepted') return emptyResponse(503)
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'session_message_accepted',
          protocolVersion: parsed.protocolVersion,
          accepted: true,
          operationId: parsed.operationId,
        }),
      }
    } catch {
      return emptyResponse(503)
    }
  }
}
