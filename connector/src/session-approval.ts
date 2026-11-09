import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import {
  MAX_SESSION_ID_CHARS,
  type SessionListAuthorizer,
} from './session-list.js'

export const SESSION_APPROVAL_LIST_PATH = '/dshos/v1/session-approvals'
export const SESSION_APPROVAL_DECISION_PATH = '/dshos/v1/session-approval'
export const MAX_SESSION_APPROVAL_REQUEST_BYTES = 4 * 1_024
export const MAX_SESSION_APPROVAL_RESPONSE_BYTES = 128 * 1_024
export const MAX_SESSION_APPROVAL_ITEMS = 20

const MAX_PENDING_APPROVALS = 100
const MAX_TOOL_CALLS = 100
const MAX_IDENTIFIER_CHARS = 256
const MAX_VISIBLE_TEXT_CHARS = 4_000
const MAX_TOOL_ARGUMENT_BYTES = 64 * 1_024
const RECONNECT_DELAY_MS = 500
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export type SessionApprovalOutcome = 'allowed-once' | 'rejected'
export type SessionApprovalDecisionResult = 'accepted' | 'conflict' | 'unavailable'

export interface SessionApprovalItem {
  readonly approvalId: string
  readonly toolName: string
  readonly reason?: string
  readonly command?: string
}

export interface SessionApprovalSnapshot {
  readonly approvals: readonly SessionApprovalItem[]
  readonly truncated: boolean
}

export interface SessionApprovalSource {
  list(sessionId: string): SessionApprovalSnapshot | undefined
  decide(
    sessionId: string,
    approvalId: string,
    outcome: SessionApprovalOutcome,
  ): Promise<SessionApprovalDecisionResult>
}

interface DshApprovalMuxRequest {
  readonly rpcId: string
  readonly payload: Record<string, never>
}

export interface DshApprovalApiProxy {
  readonly events: {
    mux(request: DshApprovalMuxRequest, signal: AbortSignal): AsyncIterable<unknown>
  }
  respond(response: unknown): Promise<unknown>
}

interface PendingApproval extends SessionApprovalItem {
  readonly sessionId: string
  readonly rpcId: string
  readonly callId?: string
}

interface ActiveMonitor {
  readonly api: DshApprovalApiProxy
  readonly abort: AbortController
  readonly token: object
}

interface ParsedRequest {
  readonly sessionId: string
  readonly approvalId?: string
  readonly outcome?: SessionApprovalOutcome
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

function codePointLength(value: string): number {
  return Array.from(value).length
}

function validIdentifier(value: unknown, maximum = MAX_IDENTIFIER_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && codePointLength(value) <= maximum
}

function boundedVisibleText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const characters = Array.from(value)
  return characters.length <= MAX_VISIBLE_TEXT_CHARS
    ? value
    : `${characters.slice(0, MAX_VISIBLE_TEXT_CHARS - 1).join('')}…`
}

function parseRequest(
  body: Uint8Array,
  type: 'session_approval_list_request' | 'session_approval_decision_request',
): ParsedRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_APPROVAL_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    const expected = type === 'session_approval_list_request'
      ? ['type', 'protocolVersion', 'sessionId']
      : ['type', 'protocolVersion', 'sessionId', 'approvalId', 'outcome']
    if (!isObject(value)
      || !sameFields(Object.keys(value), expected)
      || value.type !== type
      || value.protocolVersion !== 1
      || !validIdentifier(value.sessionId, MAX_SESSION_ID_CHARS)
      || JSON.stringify(value) !== text) return undefined
    if (type === 'session_approval_list_request') return { sessionId: value.sessionId }
    if (!validIdentifier(value.approvalId)
      || (value.outcome !== 'allowed-once' && value.outcome !== 'rejected')) return undefined
    return {
      sessionId: value.sessionId,
      approvalId: value.approvalId,
      outcome: value.outcome,
    }
  } catch {
    return undefined
  }
}

function approvalKey(sessionId: string, approvalId: string): string {
  return JSON.stringify([sessionId, approvalId])
}

function callKey(sessionId: string, callId: string): string {
  return JSON.stringify([sessionId, callId])
}

function exactReceipt(value: unknown): 'accepted' | 'not-pending' | 'invalid' {
  if (!isObject(value) || typeof value.accepted !== 'boolean') return 'invalid'
  if (value.accepted) {
    return sameFields(Object.keys(value), ['accepted']) ? 'accepted' : 'invalid'
  }
  if (!sameFields(Object.keys(value), ['accepted', 'reason'])) return 'invalid'
  return value.reason === 'not-pending' ? 'not-pending' : 'invalid'
}

export function approvalApiProxy(value: unknown): DshApprovalApiProxy | undefined {
  if (!isObject(value)
    || !isObject(value.events)
    || typeof value.events.mux !== 'function'
    || typeof value.respond !== 'function') return undefined
  return value as unknown as DshApprovalApiProxy
}

function reconnectDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Approval monitor detached'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, RECONNECT_DELAY_MS)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort)
      reject(new Error('Approval monitor detached'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class SessionApprovalMonitor implements SessionApprovalSource {
  private readonly pending: Map<string, PendingApproval> = new Map<string, PendingApproval>()
  private readonly commands: Map<string, string> = new Map<string, string>()
  private active: ActiveMonitor | undefined = undefined
  private online = false
  private readonly inFlight = new Map<string, object>()
  private readonly announced = new Set<string>()

  constructor(
    private readonly onRequested: (sessionId: string, approvalId: string) => void = () => undefined,
  ) {}

  attach(api: DshApprovalApiProxy): () => void {
    this.detach()
    const active: ActiveMonitor = { api, abort: new AbortController(), token: {} }
    this.active = active
    void this.consumeUntilDetached(active)
    return () => this.detach(active.token)
  }

  list(sessionId: string): SessionApprovalSnapshot | undefined {
    if (this.active === undefined || !this.online) return undefined
    const approvals = [...this.pending.values()]
      .filter(item => item.sessionId === sessionId)
      .slice(0, MAX_SESSION_APPROVAL_ITEMS)
      .map(item => {
        const projected: {
          approvalId: string
          toolName: string
          reason?: string
          command?: string
        } = { approvalId: item.approvalId, toolName: item.toolName }
        if (item.reason !== undefined) projected.reason = item.reason
        if (item.command !== undefined) projected.command = item.command
        return Object.freeze(projected)
      })
    const total = [...this.pending.values()].filter(item => item.sessionId === sessionId).length
    return { approvals, truncated: total > approvals.length }
  }

  async decide(sessionId: string, approvalId: string,
    outcome: SessionApprovalOutcome): Promise<SessionApprovalDecisionResult> {
    const active = this.active
    if (active === undefined || !this.online) return 'unavailable'
    const key = approvalKey(sessionId, approvalId)
    const approval = this.pending.get(key)
    if (approval === undefined || this.inFlight.has(key)) return 'conflict'
    const decision = {}
    this.inFlight.set(key, decision)
    try {
      const receipt = exactReceipt(await active.api.respond({
        type: 'client-response',
        rpcId: approval.rpcId,
        result: {
          ok: true,
          value: { sessionId, approvalId, outcome },
        },
      }))
      if (this.active?.token !== active.token) return 'unavailable'
      if (receipt === 'accepted') {
        this.pending.delete(key)
        return 'accepted'
      }
      if (receipt === 'not-pending') {
        this.pending.delete(key)
        return 'conflict'
      }
      return 'unavailable'
    } catch {
      return 'unavailable'
    } finally {
      if (this.inFlight.get(key) === decision) this.inFlight.delete(key)
    }
  }

  private async consumeUntilDetached(active: ActiveMonitor): Promise<void> {
    while (this.active?.token === active.token && !active.abort.signal.aborted) {
      try {
        this.online = true
        const stream = active.api.events.mux(
          { rpcId: randomUUID(), payload: {} }, active.abort.signal,
        )
        // A fresh bridge subscription replays its still-pending approvals.
        for await (const envelope of stream) {
          if (this.active?.token !== active.token) return
          this.acceptEnvelope(envelope)
        }
        if (this.active?.token !== active.token) return
        throw new Error('DSH approval stream ended')
      } catch {
        if (this.active?.token !== active.token || active.abort.signal.aborted) return
        this.online = false
        this.pending.clear()
        this.commands.clear()
        try { await reconnectDelay(active.abort.signal) } catch { return }
      }
    }
  }

  private acceptEnvelope(value: unknown): void {
    if (!isObject(value)
      || !sameFields(Object.keys(value), ['rpcId', 'payload'])
      || !validIdentifier(value.rpcId)
      || !isObject(value.payload)
      || typeof value.payload.type !== 'string') throw new Error('invalid DSH approval envelope')
    const payload = value.payload
    if (payload.type === 'approval/requested') {
      const expected = ['type', 'sessionId', 'approvalId', 'toolName']
      if ('callId' in payload) expected.push('callId')
      if ('reason' in payload) expected.push('reason')
      if (!sameFields(Object.keys(payload), expected)
        || !validIdentifier(payload.sessionId, MAX_SESSION_ID_CHARS)
        || !validIdentifier(payload.approvalId)
        || !validIdentifier(payload.toolName)
        || (payload.callId !== undefined && !validIdentifier(payload.callId))
        || (payload.reason !== undefined && typeof payload.reason !== 'string')) {
        throw new Error('invalid DSH approval request')
      }
      const key = approvalKey(payload.sessionId, payload.approvalId)
      const isNew = !this.pending.has(key)
      if (isNew && this.pending.size >= MAX_PENDING_APPROVALS) {
        throw new Error('too many pending DSH approvals')
      }
      const command = payload.callId === undefined
        ? undefined
        : this.commands.get(callKey(payload.sessionId, payload.callId))
      const pending: PendingApproval = {
        sessionId: payload.sessionId,
        approvalId: payload.approvalId,
        rpcId: value.rpcId,
        toolName: payload.toolName,
        ...(payload.callId === undefined ? {} : { callId: payload.callId }),
        ...(boundedVisibleText(payload.reason) === undefined
          ? {}
          : { reason: boundedVisibleText(payload.reason) }),
        ...(command === undefined ? {} : { command }),
      }
      this.pending.set(key, pending)
      if (!this.announced.has(key)) {
        this.announced.add(key)
        while (this.announced.size > MAX_PENDING_APPROVALS) this.announced.delete(this.announced.values().next().value!)
        try {
          this.onRequested(payload.sessionId, payload.approvalId)
        } catch {
        }
      }
      return
    }
    if (payload.type === 'approval/resolved') {
      if (!sameFields(Object.keys(payload), ['type', 'sessionId', 'approvalId', 'outcome'])
        || !validIdentifier(payload.sessionId, MAX_SESSION_ID_CHARS)
        || !validIdentifier(payload.approvalId)
        || (payload.outcome !== 'allowed-once'
          && payload.outcome !== 'rejected'
          && payload.outcome !== 'cancelled'
          && payload.outcome !== 'unavailable')) {
        throw new Error('invalid DSH approval resolution')
      }
      this.pending.delete(approvalKey(payload.sessionId, payload.approvalId))
      return
    }
    if (payload.type === 'session/event') this.acceptToolCall(payload)
  }

  private acceptToolCall(payload: Record<string, unknown>): void {
    if (isObject(payload.event) && payload.event.type === 'assistant/message'
      && isObject(payload.event.data) && isObject(payload.event.data.message)
      && Array.isArray(payload.event.data.message.content)) {
      for (const block of payload.event.data.message.content.slice(0, MAX_TOOL_CALLS)) {
        if (!isObject(block) || block.type !== 'tool-call') continue
        this.acceptToolCall({ sessionId: payload.sessionId, event: { type: 'tool/call',
          data: { callId: block.id, arguments: block.arguments } } })
      }
      return
    }
    if (!validIdentifier(payload.sessionId, MAX_SESSION_ID_CHARS)
      || !isObject(payload.event)
      || payload.event.type !== 'tool/call'
      || !isObject(payload.event.data)
      || !validIdentifier(payload.event.data.callId)
      || typeof payload.event.data.arguments !== 'string'
      || Buffer.byteLength(payload.event.data.arguments) > MAX_TOOL_ARGUMENT_BYTES) return
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.event.data.arguments)
    } catch {
      return
    }
    if (!isObject(parsed)) return
    const command = boundedVisibleText(parsed.command)
    if (command === undefined) return
    const key = callKey(payload.sessionId, payload.event.data.callId)
    this.commands.delete(key)
    this.commands.set(key, command)
    while (this.commands.size > MAX_TOOL_CALLS) {
      const oldest = this.commands.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.commands.delete(oldest)
    }
    for (const [pendingKey, approval] of this.pending) {
      if (approval.sessionId === payload.sessionId
        && approval.callId === payload.event.data.callId) {
        this.pending.set(pendingKey, { ...approval, command })
      }
    }
  }

  private detach(token?: object): void {
    if (token !== undefined && this.active?.token !== token) return
    const active = this.active
    this.active = undefined
    this.online = false
    active?.abort.abort()
    this.pending.clear()
    this.commands.clear()
    this.inFlight.clear()
    this.announced.clear()
  }
}

export function createSessionApprovalListRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionApprovalSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_APPROVAL_LIST_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_APPROVAL_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return emptyResponse(400)
    const parsed = parseRequest(request.body, 'session_approval_list_request')
    if (parsed === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    const snapshot = source?.list(parsed.sessionId)
    if (snapshot === undefined) return emptyResponse(503)
    const body = JSON.stringify({
      type: 'session_approval_list',
      protocolVersion: 1,
      sessionId: parsed.sessionId,
      truncated: snapshot.truncated,
      approvals: snapshot.approvals,
    })
    if (Buffer.byteLength(body) > MAX_SESSION_APPROVAL_RESPONSE_BYTES) return emptyResponse(503)
    return { status: 200, contentType: 'application/json', body }
  }
}

export function createSessionApprovalDecisionRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionApprovalSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_APPROVAL_DECISION_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_APPROVAL_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return emptyResponse(400)
    const parsed = parseRequest(request.body, 'session_approval_decision_request')
    if (parsed?.approvalId === undefined || parsed.outcome === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (source === undefined) return emptyResponse(503)
    const result = await source.decide(parsed.sessionId, parsed.approvalId, parsed.outcome)
    if (result === 'conflict') return emptyResponse(409)
    if (result !== 'accepted') return emptyResponse(503)
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'session_approval_decision_accepted',
        protocolVersion: 1,
        accepted: true,
      }),
    }
  }
}
