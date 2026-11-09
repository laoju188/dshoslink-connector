import type { CompletionJournal, CompletionProof } from './completion-notifications.js'
import { createHash, randomBytes } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'

export const CRITICAL_NOTIFICATION_PATH = '/dshos/v1/critical-notifications'
export const CRITICAL_NOTIFICATION_WAIT_MS = 15_000

const MAX_REQUEST_BYTES = 4 * 1_024
const MAX_RESPONSE_BYTES = 32 * 1_024
const MAX_EVENTS = 100
const MAX_EVENTS_PER_RESPONSE = 20
const MAX_WAITERS = 64
const MAX_SEMANTIC_KEYS = 4_096
const MAX_SESSION_ID_CHARS = 256
const MAX_SEMANTIC_ID_CHARS = 256
const EVENT_TTL_MS = 24 * 60 * 60 * 1_000
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export const CRITICAL_NOTIFICATION_TYPES = [
  'APPROVAL_PENDING',
  'QUESTION_PENDING',
  'TASK_COMPLETED',
  'TASK_FAILED',
] as const

export type CriticalNotificationType = typeof CRITICAL_NOTIFICATION_TYPES[number]

export interface CriticalNotificationEvent {
  readonly eventId: string
  readonly eventType: CriticalNotificationType
  readonly sessionId: string
  readonly completionAtMs?: number
}

interface StoredCriticalNotificationEvent extends CriticalNotificationEvent {
  readonly createdAtEpochMs: number
}

export interface CriticalNotificationSource {
  completions?(ids: readonly string[], readIds?: readonly string[]): Promise<readonly CompletionProof[]>
  cursor(): string | null
  wait(
    afterEventId: string | null,
    signal?: AbortSignal,
    waitMs?: number,
  ): Promise<{
    readonly latestEventId: string | null
    readonly reset: boolean
    readonly events: readonly CriticalNotificationEvent[]
  }>
  resolve(eventId: string): CriticalNotificationEvent | undefined
}

export type CriticalNotificationListener = (event: CriticalNotificationEvent) => void

export interface CriticalNotificationEventSource {
  subscribe(listener: CriticalNotificationListener): () => void
  pending?(): Promise<readonly CriticalNotificationEvent[]>
  accepted?(eventId: string): Promise<void>
}

interface Waiter {
  readonly afterEventId: string | null
  readonly resolve: (value: CriticalNotificationWaitResult) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

interface CriticalNotificationWaitResult {
  readonly latestEventId: string | null
  readonly reset: boolean
  readonly events: readonly CriticalNotificationEvent[]
}

type ParsedRequest =
  | { readonly type: 'completions'; readonly ids: string[]; readonly readIds: string[] }
  | { readonly type: 'cursor' }
  | { readonly type: 'wait'; readonly afterEventId: string | null }
  | { readonly type: 'resolve'; readonly eventId: string }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameFields(actual: string[], expected: readonly string[]): boolean {
  actual.sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((value, index) => value === sortedExpected[index])
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

function validSessionId(value: string): boolean {
  return value.length > 0 && codePointLength(value) <= MAX_SESSION_ID_CHARS
}

function semanticKey(eventType: CriticalNotificationType, sessionId: string,
  sourceId: string | number): string {
  const source = eventType === 'APPROVAL_PENDING'
    ? 'approval'
    : eventType === 'QUESTION_PENDING'
      ? 'question'
      : 'turn-end'
  const validSourceId = source === 'turn-end'
    ? typeof sourceId === 'number' && Number.isSafeInteger(sourceId) && sourceId >= 0
    : typeof sourceId === 'string'
      && sourceId.length > 0
      && codePointLength(sourceId) <= MAX_SEMANTIC_ID_CHARS
  if (!validSourceId) {
    throw new Error('Critical notification semantic identity is invalid')
  }
  const hash = createHash('sha256')
  for (const value of [
    'DSHOS Link Critical Notification V1',
    source,
    sessionId,
    typeof sourceId === 'string' ? 'string' : 'number',
    String(sourceId),
  ]) {
    const bytes = Buffer.from(value, 'utf16le')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.byteLength)
    hash.update(length)
    hash.update(bytes)
  }
  return hash.digest('base64url')
}

export function isCriticalNotificationType(value: unknown): value is CriticalNotificationType {
  return typeof value === 'string'
    && (CRITICAL_NOTIFICATION_TYPES as readonly string[]).includes(value)
}

function validEventId(value: unknown): value is string {
  if (typeof value !== 'string' || !EVENT_ID_PATTERN.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === 16 && decoded.toString('base64url') === value
}

function parseRequest(body: Uint8Array): ParsedRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (isObject(value) && value.protocolVersion === 2 && value.type === 'completion_resolve_request'
      && JSON.stringify(value) === text && sameFields(Object.keys(value), ['type', 'protocolVersion', 'eventIds', 'readEventIds'])
      && Array.isArray(value.eventIds) && value.eventIds.length <= 100
      && value.eventIds.every(validEventId) && new Set(value.eventIds).size === value.eventIds.length
      && Array.isArray(value.readEventIds) && value.readEventIds.length <= 100 && value.readEventIds.every(validEventId)
      && new Set(value.readEventIds).size === value.readEventIds.length)
      return { type: 'completions', ids: value.eventIds, readIds: value.readEventIds }
    if (!isObject(value) || value.protocolVersion !== 1 || JSON.stringify(value) !== text) {
      return undefined
    }
    if (value.type === 'critical_notification_cursor_request') {
      return sameFields(Object.keys(value), ['type', 'protocolVersion'])
        ? { type: 'cursor' }
        : undefined
    }
    if (value.type === 'critical_notification_wait_request') {
      if (!sameFields(Object.keys(value), ['type', 'protocolVersion', 'afterEventId'])
        || (value.afterEventId !== null && !validEventId(value.afterEventId))) return undefined
      return { type: 'wait', afterEventId: value.afterEventId }
    }
    if (value.type === 'critical_notification_resolve_request') {
      if (!sameFields(Object.keys(value), ['type', 'protocolVersion', 'eventId'])
        || !validEventId(value.eventId)) return undefined
      return { type: 'resolve', eventId: value.eventId }
    }
    return undefined
  } catch {
    return undefined
  }
}

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

function abortError(): Error {
  return new Error('Critical notification wait aborted')
}

function publicEvent(event: StoredCriticalNotificationEvent): CriticalNotificationEvent {
  return Object.freeze({
    eventId: event.eventId,
    eventType: event.eventType,
    sessionId: event.sessionId,
  })
}

export class CriticalNotificationHub implements CriticalNotificationSource {
  private readonly events: StoredCriticalNotificationEvent[] = []
  private readonly semanticKeys: Map<string, number> = new Map()
  private readonly waiters: Set<Waiter> = new Set()
  private readonly listeners: Set<CriticalNotificationListener> = new Set()

  private completionTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Uint8Array = randomBytes,
    private readonly journal?: CompletionJournal,
    private readonly owner: () => string = () => "null",
  ) {}

  async completions(ids: readonly string[], readIds: readonly string[] = []): Promise<readonly CompletionProof[]> {
    const owner = this.owner(); await this.completionTail
    if (owner !== this.owner()) throw Error("completion_owner_changed")
    await this.journal?.markRead(owner, readIds)
    const result = await this.journal?.read(owner, ids) ?? []
    if (owner !== this.owner()) throw Error("completion_owner_changed")
    return result
  }
  async pending(): Promise<readonly CriticalNotificationEvent[]> {
    const owner = this.owner()
    if (!this.journal || owner === "null") return []
    const proofs = await this.journal.read(owner, undefined, true)
    if (owner !== this.owner()) return []
    return proofs.filter(p => this.now() - p.completionAtMs < EVENT_TTL_MS).map(p => ({
      eventId: p.eventId, eventType: "TASK_COMPLETED" as const, sessionId: p.sessionId, completionAtMs: p.completionAtMs,
    }))
  }
  async accepted(id: string): Promise<void> { await this.journal?.accepted(this.owner(), id) }
  emitCompletion(proof: CompletionProof): Promise<void> {
    const owner = this.owner()
    const run = this.completionTail.then(async () => {
      if (!this.journal || owner === "null" || owner !== this.owner()) return
      await this.journal.save(owner, proof)
      if (owner !== this.owner() || this.events.some(e => e.eventId === proof.eventId)) return
      const event: StoredCriticalNotificationEvent = { ...proof, eventType: "TASK_COMPLETED", createdAtEpochMs: proof.completionAtMs }
      this.events.push(event); while (this.events.length > MAX_EVENTS) this.events.shift()
      for (const listener of this.listeners) { try { listener({ ...publicEvent(event), completionAtMs: proof.completionAtMs }) } catch {} }
      this.resolveWaiters()
    })
    this.completionTail = run.catch(() => undefined)
    return run
  }

  emit(eventType: CriticalNotificationType, sessionId: string): CriticalNotificationEvent {
    return this.record(eventType, sessionId)!
  }

  emitOnce(eventType: CriticalNotificationType, sessionId: string,
    sourceId: string | number): CriticalNotificationEvent | undefined {
    if (!isCriticalNotificationType(eventType) || !validSessionId(sessionId)) {
      throw new Error('Critical notification event is invalid')
    }
    return this.record(eventType, sessionId, semanticKey(eventType, sessionId, sourceId))
  }

  private record(eventType: CriticalNotificationType, sessionId: string,
    semanticKey?: string): CriticalNotificationEvent | undefined {
    if (!isCriticalNotificationType(eventType) || !validSessionId(sessionId)) {
      throw new Error('Critical notification event is invalid')
    }
    const createdAtEpochMs = this.now()
    if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0) {
      throw new Error('Critical notification clock is invalid')
    }
    this.prune(createdAtEpochMs)
    if (semanticKey !== undefined) {
      if (this.semanticKeys.has(semanticKey)) return undefined
      if (this.semanticKeys.size >= MAX_SEMANTIC_KEYS) return undefined
    }
    const random = this.random(16)
    if (!(random instanceof Uint8Array) || random.byteLength !== 16) {
      throw new Error('Critical notification event ID generation failed')
    }
    const event: StoredCriticalNotificationEvent = Object.freeze({
      eventId: Buffer.from(random).toString('base64url'),
      eventType,
      sessionId,
      createdAtEpochMs,
    })
    this.events.push(event)
    if (semanticKey !== undefined) this.semanticKeys.set(semanticKey, createdAtEpochMs)
    while (this.events.length > MAX_EVENTS) this.events.shift()
    const projected = publicEvent(event)
    for (const listener of this.listeners) {
      try {
        listener(projected)
      } catch {
      }
    }
    this.resolveWaiters()
    return projected
  }

  subscribe(listener: CriticalNotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cursor(): string | null {
    this.prune(this.readNow())
    return this.events.at(-1)?.eventId ?? null
  }

  resolve(eventId: string): CriticalNotificationEvent | undefined {
    if (!validEventId(eventId)) return undefined
    this.prune(this.readNow())
    const event = this.events.find(item => item.eventId === eventId)
    return event === undefined ? undefined : publicEvent(event)
  }

  wait(afterEventId: string | null, signal?: AbortSignal,
    waitMs = CRITICAL_NOTIFICATION_WAIT_MS): Promise<CriticalNotificationWaitResult> {
    if ((afterEventId !== null && !validEventId(afterEventId))
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > CRITICAL_NOTIFICATION_WAIT_MS) {
      return Promise.reject(new Error('Critical notification wait is invalid'))
    }
    const immediate = this.snapshot(afterEventId)
    if (immediate.reset || immediate.events.length > 0 || waitMs === 0) {
      return Promise.resolve(immediate)
    }
    if (this.waiters.size >= MAX_WAITERS) {
      return Promise.reject(new Error('Too many critical notification waiters'))
    }
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      let waiter: Waiter
      const finish = (value: CriticalNotificationWaitResult): void => {
        if (!this.waiters.delete(waiter)) return
        clearTimeout(waiter.timer)
        if (waiter.signal !== undefined && waiter.abort !== undefined) {
          waiter.signal.removeEventListener('abort', waiter.abort)
        }
        resolve(value)
      }
      const onAbort = (): void => {
        if (!this.waiters.delete(waiter)) return
        clearTimeout(waiter.timer)
        signal?.removeEventListener('abort', onAbort)
        reject(abortError())
      }
      waiter = {
        afterEventId,
        resolve: finish,
        reject,
        timer: setTimeout(() => finish(this.snapshot(afterEventId)), waitMs),
        ...(signal === undefined ? {} : { signal, abort: onAbort }),
      }
      waiter.timer.unref()
      this.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  clear(): void {
    this.events.length = 0
    this.semanticKeys.clear()
    this.resolveWaiters()
  }

  private readNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Critical notification clock is invalid')
    }
    return value
  }

  private prune(nowEpochMs: number): void {
    while (this.events[0] !== undefined
      && this.events[0].createdAtEpochMs + EVENT_TTL_MS <= nowEpochMs) {
      this.events.shift()
    }
    for (const [key, createdAtEpochMs] of this.semanticKeys) {
      if (createdAtEpochMs + EVENT_TTL_MS <= nowEpochMs) this.semanticKeys.delete(key)
    }
  }

  private snapshot(afterEventId: string | null): CriticalNotificationWaitResult {
    this.prune(this.readNow())
    const latestEventId = this.events.at(-1)?.eventId ?? null
    const index = afterEventId === null
      ? -1 : this.events.findIndex(event => event.eventId === afterEventId)
    if (afterEventId !== null && index < 0) {
      return Object.freeze({ latestEventId, reset: true, events: Object.freeze([]) })
    }
    const events = this.events.slice(index + 1, index + 1 + MAX_EVENTS_PER_RESPONSE).map(publicEvent)
    return Object.freeze({
      latestEventId: events.at(-1)?.eventId ?? latestEventId,
      reset: false,
      events: Object.freeze(events),
    })
  }

  private resolveWaiters(): void {
    for (const waiter of [...this.waiters]) {
      const snapshot = this.snapshot(waiter.afterEventId)
      if (snapshot.reset || snapshot.events.length > 0) waiter.resolve(snapshot)
    }
  }
}

export function createCriticalNotificationRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: CriticalNotificationSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== CRITICAL_NOTIFICATION_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') {
      return emptyResponse(400)
    }
    const parsed = parseRequest(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (request.signal?.aborted) return emptyResponse(503)
    if (source === undefined) return emptyResponse(503)
    if (parsed.type === 'completions') {
      if (!source.completions) return emptyResponse(503)
      try {
        const events = await source.completions(parsed.ids, parsed.readIds)
        if (!authorizer.authorize(request.authorization, request.connectionGeneration) || request.signal?.aborted) return emptyResponse(401)
        const body = JSON.stringify({ type: 'completion_events', protocolVersion: 2, events })
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return emptyResponse(503)
        return { status: 200, contentType: 'application/json', body }
      } catch { return emptyResponse(503) }
    }
    if (parsed.type === 'cursor') {
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'critical_notification_cursor',
          protocolVersion: 1,
          latestEventId: source.cursor(),
        }),
      }
    }
    if (parsed.type === 'resolve') {
      const event = source.resolve(parsed.eventId)
      if (event === undefined) return emptyResponse(404)
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'critical_notification_event',
          protocolVersion: 1,
          event,
        }),
      }
    }
    let snapshot: CriticalNotificationWaitResult
    try {
      snapshot = await source.wait(parsed.afterEventId, request.signal)
    } catch {
      return emptyResponse(503)
    }
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
    if (request.signal?.aborted) return emptyResponse(503)
    const body = JSON.stringify({
      type: 'critical_notification_events',
      protocolVersion: 1,
      latestEventId: snapshot.latestEventId,
      reset: snapshot.reset,
      events: snapshot.events,
    })
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return emptyResponse(503)
    return { status: 200, contentType: 'application/json', body }
  }
}
