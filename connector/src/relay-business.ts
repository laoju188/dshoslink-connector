import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import {
  SESSION_CANCEL_PATH,
  SESSION_CONTROL_REQUEST_MAX_BYTES,
  SESSION_STATE_PATH,
} from './session-control.js'
import {
  MAX_SESSION_QUESTION_REQUEST_BYTES,
  SESSION_QUESTION_LIST_PATH,
  SESSION_QUESTION_RESPONSE_PATH,
} from './session-question.js'
import { isSessionRequestPath } from './session-request-router.js'
import { SESSION_IMAGE_PATH, SESSION_IMAGE_REQUEST_MAX_BYTES } from './session-image-contract.js'
import { SESSION_IMAGE_MESSAGE_PATH, SESSION_IMAGE_MESSAGE_REQUEST_MAX_BYTES } from './session-image-message.js'

export const RELAY_BUSINESS_PROTOCOL_VERSION = 1
export const RELAY_BUSINESS_REQUEST_BODY_MAX_BYTES = 180 * 1024
export const RELAY_BUSINESS_RESPONSE_BODY_MAX_BYTES = 512 * 1024
export const RELAY_BUSINESS_RESPONSE_CHUNK_BYTES = 180 * 1024
export const RELAY_BUSINESS_FILE_CHUNK_BYTES = 176 * 1024
export const RELAY_BUSINESS_MAX_RESPONSE_PARTS = 4
export const RELAY_BUSINESS_AUTHORIZATION = 'DSHOS-Link-Relay-V1'
export const RELAY_BUSINESS_GENERATION = 'relay-business-v1'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const REQUEST_FIELDS = [
  'type', 'protocolVersion', 'requestId', 'method', 'path', 'contentType', 'body',
] as const
const RESPONSE_FIELDS = [
  'type', 'protocolVersion', 'requestId', 'status', 'contentType', 'partIndex', 'partCount', 'body',
] as const

export interface RelayBusinessRequest {
  readonly requestId: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly contentType?: 'application/json' | 'application/octet-stream'
  readonly body: Uint8Array
}

export interface RelayBusinessResponsePart {
  readonly requestId: string
  readonly status: number
  readonly contentType?: 'application/json'
  readonly partIndex: number
  readonly partCount: number
  readonly body: Uint8Array
}

interface RequestWire {
  readonly type: 'relay_business_request'
  readonly protocolVersion: 1
  readonly requestId: string
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly contentType: '' | 'application/json' | 'application/octet-stream'
  readonly body: string
}

interface ResponseWire {
  readonly type: 'relay_business_response'
  readonly protocolVersion: 1
  readonly requestId: string
  readonly status: number
  readonly contentType: '' | 'application/json'
  readonly partIndex: number
  readonly partCount: number
  readonly body: string
}

function failure(): never {
  throw new Error('Relay business protocol failed')
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const fields = Object.keys(value)
  return fields.length === expected.length
    && fields.every((field, index) => field === expected[index])
}

function canonicalBase64Url(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.toString('base64url') === value ? decoded : undefined
}

function parseCanonicalJson(plaintext: Uint8Array): Record<string, unknown> {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 1 || plaintext.byteLength > 262_144) {
    return failure()
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || JSON.stringify(value) !== text) return failure()
    return value as Record<string, unknown>
  } catch {
    return failure()
  }
}

export function isRelayBusinessPath(path: string): boolean {
  return isSessionRequestPath(path)
}

function isRelayBusinessRequestShapeAllowed(
  method: 'GET' | 'POST',
  path: string,
  contentType: '' | 'application/json' | 'application/octet-stream',
  bodyBytes: number,
): boolean {
  const maximum = path === SESSION_STATE_PATH || path === SESSION_CANCEL_PATH
    ? SESSION_CONTROL_REQUEST_MAX_BYTES
    : path === SESSION_QUESTION_LIST_PATH || path === SESSION_QUESTION_RESPONSE_PATH
      ? MAX_SESSION_QUESTION_REQUEST_BYTES
      : path === SESSION_IMAGE_PATH ? SESSION_IMAGE_REQUEST_MAX_BYTES
        : path === SESSION_IMAGE_MESSAGE_PATH ? SESSION_IMAGE_MESSAGE_REQUEST_MAX_BYTES : undefined
  if (maximum === undefined) return true
  return method === 'POST'
    && contentType === 'application/json'
    && bodyBytes <= maximum
}

export function encodeRelayBusinessRequest(request: RelayBusinessRequest): Uint8Array {
  if (!REQUEST_ID_PATTERN.test(request.requestId)
    || (request.method !== 'GET' && request.method !== 'POST')
    || !isRelayBusinessPath(request.path)
    || !(request.body instanceof Uint8Array)
    || request.body.byteLength > RELAY_BUSINESS_REQUEST_BODY_MAX_BYTES
    || (request.contentType !== undefined
      && request.contentType !== 'application/json'
      && request.contentType !== 'application/octet-stream')
    || (request.method === 'GET' && (request.body.byteLength !== 0 || request.contentType !== undefined))
    || !isRelayBusinessRequestShapeAllowed(
      request.method, request.path, request.contentType ?? '', request.body.byteLength,
    )) {
    return failure()
  }
  const wire: RequestWire = {
    type: 'relay_business_request',
    protocolVersion: 1,
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    contentType: request.contentType ?? '',
    body: Buffer.from(request.body).toString('base64url'),
  }
  const encoded = Buffer.from(JSON.stringify(wire), 'utf8')
  if (encoded.byteLength > 262_144) return failure()
  return encoded
}

export function decodeRelayBusinessRequest(plaintext: Uint8Array): RelayBusinessRequest {
  const value = parseCanonicalJson(plaintext)
  if (!exactFields(value, REQUEST_FIELDS)
    || value.type !== 'relay_business_request'
    || value.protocolVersion !== RELAY_BUSINESS_PROTOCOL_VERSION
    || typeof value.requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(value.requestId)
    || (value.method !== 'GET' && value.method !== 'POST')
    || typeof value.path !== 'string'
    || !isRelayBusinessPath(value.path)
    || (value.contentType !== ''
      && value.contentType !== 'application/json'
      && value.contentType !== 'application/octet-stream')) return failure()
  const body = canonicalBase64Url(value.body)
  if (body === undefined || body.byteLength > RELAY_BUSINESS_REQUEST_BODY_MAX_BYTES
    || (value.method === 'GET' && (body.byteLength !== 0 || value.contentType !== ''))
    || !isRelayBusinessRequestShapeAllowed(value.method, value.path, value.contentType, body.byteLength)) {
    return failure()
  }
  return Object.freeze({
    requestId: value.requestId,
    method: value.method,
    path: value.path,
    ...(value.contentType === '' ? {} : { contentType: value.contentType }),
    body,
  })
}

export function relayBusinessHttpRequest(request: RelayBusinessRequest,
  signal?: AbortSignal): PairingV1HttpRequest {
  return {
    method: request.method,
    path: request.path,
    ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    body: request.body,
    authorization: RELAY_BUSINESS_AUTHORIZATION,
    connectionGeneration: RELAY_BUSINESS_GENERATION,
    ...(signal === undefined ? {} : { signal }),
  }
}

export function encodeRelayBusinessResponse(
  requestId: string,
  response: PairingV1HttpResponse,
): readonly Uint8Array[] {
  if (!REQUEST_ID_PATTERN.test(requestId)
    || !Number.isInteger(response.status) || response.status < 100 || response.status > 599
    || (response.contentType !== undefined && response.contentType !== 'application/json')) return failure()
  const body = Buffer.from(response.body, 'utf8')
  if (body.byteLength > RELAY_BUSINESS_RESPONSE_BODY_MAX_BYTES) return failure()
  const partCount = Math.max(1, Math.ceil(body.byteLength / RELAY_BUSINESS_RESPONSE_CHUNK_BYTES))
  if (partCount > RELAY_BUSINESS_MAX_RESPONSE_PARTS) return failure()
  const result: Uint8Array[] = []
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const start = partIndex * RELAY_BUSINESS_RESPONSE_CHUNK_BYTES
    const chunk = body.subarray(start, Math.min(start + RELAY_BUSINESS_RESPONSE_CHUNK_BYTES, body.byteLength))
    const wire: ResponseWire = {
      type: 'relay_business_response',
      protocolVersion: 1,
      requestId,
      status: response.status,
      contentType: response.contentType ?? '',
      partIndex,
      partCount,
      body: chunk.toString('base64url'),
    }
    const encoded = Buffer.from(JSON.stringify(wire), 'utf8')
    if (encoded.byteLength > 262_144) return failure()
    result.push(encoded)
  }
  return result
}

export function decodeRelayBusinessResponsePart(plaintext: Uint8Array): RelayBusinessResponsePart {
  const value = parseCanonicalJson(plaintext)
  if (!exactFields(value, RESPONSE_FIELDS)
    || value.type !== 'relay_business_response'
    || value.protocolVersion !== RELAY_BUSINESS_PROTOCOL_VERSION
    || typeof value.requestId !== 'string'
    || !REQUEST_ID_PATTERN.test(value.requestId)
    || !Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599
    || (value.contentType !== '' && value.contentType !== 'application/json')
    || !Number.isInteger(value.partIndex) || Number(value.partIndex) < 0
    || !Number.isInteger(value.partCount) || Number(value.partCount) < 1
    || Number(value.partCount) > RELAY_BUSINESS_MAX_RESPONSE_PARTS
    || Number(value.partIndex) >= Number(value.partCount)) return failure()
  const body = canonicalBase64Url(value.body)
  if (body === undefined || body.byteLength > RELAY_BUSINESS_RESPONSE_CHUNK_BYTES) return failure()
  return Object.freeze({
    requestId: value.requestId,
    status: Number(value.status),
    ...(value.contentType === '' ? {} : { contentType: value.contentType }),
    partIndex: Number(value.partIndex),
    partCount: Number(value.partCount),
    body,
  })
}
