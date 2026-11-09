import { completionProof, type CompletionProof } from './completion-notifications.js'
import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import {
  MAX_SESSION_ID_CHARS,
  type SessionListAuthorizer,
} from './session-list.js'

export const SESSION_STREAM_PATH = '/dshos/v1/session-stream'
export const SESSION_STREAM_WAIT_MS = 15_000
export const SESSION_STREAM_RESPONSE_MAX_BYTES = 64 * 1_024
export const MAX_SESSION_STREAM_PARTIAL_CHARS = 4_000

const MAX_SESSION_STREAM_REQUEST_BYTES = 4 * 1_024
const MAX_TRACKED_SESSIONS = 32
const MAX_STREAM_WAITERS = 64
const MAX_STREAM_WAITERS_PER_SESSION = 2
const RECONNECT_DELAY_MS = 500
const MAX_IDENTIFIER_CHARS = 256
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export type SessionStreamState = 'idle' | 'streaming' | 'calibrate' | 'resync'
type StreamProtocol = 1 | 2 | 3

export interface SessionStreamPartial {
  readonly turn: number
  readonly step: number
  readonly throughSeq: number
  readonly text: string
  readonly truncated: boolean
  readonly offset?: number
}

export interface SessionStreamSnapshot {
  readonly throughSeq: number | null
  readonly state: SessionStreamState
  readonly partial: SessionStreamPartial | null
}

export interface SessionStreamSource {
  wait(
    sessionId: string,
    afterSeq: number | null,
    partialSeq: number | null,
    signal?: AbortSignal,
    waitMs?: number,
    protocolVersion?: StreamProtocol,
    isCurrent?: () => boolean,
  ): Promise<SessionStreamSnapshot | undefined>
}

export type SessionTurnEndKind =
  | 'completed'
  | 'blocked'
  | 'max-tokens'
  | 'interrupted'
  | 'aborted'
  | 'error'

interface DshSessionStreamMuxRequest {
  readonly rpcId: string
  readonly payload: Record<string, never>
}

export interface DshSessionStreamApiProxy {
  readonly events: {
    mux(request: DshSessionStreamMuxRequest, signal: AbortSignal): AsyncIterable<unknown>
  }
}

interface ActiveMonitor {
  readonly api: DshSessionStreamApiProxy
  readonly abort: AbortController
  readonly token: object
}

interface MutablePartial {
  readonly turn: number
  readonly step: number
  lastTextBlockIndex: number | null
  throughSeq: number
  text: string
  truncated: boolean
  complete: boolean
  tail: string
  total: number
}

interface SessionState {
  lastReply?: { turn: number; seq: number }
  readonly sessionId: string
  floorSeq: number
  latestSeq: number
  calibrationSeq: number | null
  resyncSeq: number | null
  partial: MutablePartial | undefined
  nativePartialPending?: boolean
  nativePartialPendingV2?: boolean
  nativeAttempt?: { id: string; revision: number; index: number; turn: number; step: number }
}

interface StreamRequest {
  readonly protocolVersion: StreamProtocol
  readonly sessionId: string
  readonly afterSeq: number | null
  readonly partialSeq: number | null
}

interface Waiter {
  readonly protocolVersion: StreamProtocol
  readonly sessionId: string
  readonly afterSeq: number | null
  readonly partialSeq: number | null
  readonly resolve: (value: SessionStreamSnapshot | undefined) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly signal?: AbortSignal
  readonly abort?: () => void
  readonly isCurrent?: () => boolean
  readonly cancel: () => void
}

function currentWait(check?: () => boolean): boolean {
  try { return check?.() ?? true } catch { return false }
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

function validIdentifier(value: unknown, maximum = MAX_IDENTIFIER_CHARS): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
}

function validSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validTurnEndCancelCause(value: unknown): boolean {
  if (!isObject(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'user' || value.kind === 'parent'
    || value.kind === 'disposed' || value.kind === 'legacy') {
    return sameFields(Object.keys(value), ['kind'])
  }
  return value.kind === 'hook'
    && sameFields(Object.keys(value), ['kind', 'reason'])
    && typeof value.reason === 'string'
}

function validLlmFailure(value: unknown): boolean {
  if (!isObject(value)
    || typeof value.message !== 'string'
    || typeof value.code !== 'string') return false
  const allowed = new Set([
    'message', 'code', 'status', 'providerRetryAfterMs', 'requestId',
  ])
  if (Object.keys(value).some(key => !allowed.has(key))) return false
  if (value.status !== undefined
    && (!Number.isSafeInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599)) {
    return false
  }
  if (value.providerRetryAfterMs !== undefined
    && (!Number.isSafeInteger(value.providerRetryAfterMs)
      || Number(value.providerRetryAfterMs) < 0)) return false
  return value.requestId === undefined || typeof value.requestId === 'string'
}

function validTurnEndReason(value: unknown): boolean {
  if (!isObject(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'completed' || value.kind === 'blocked'
    || value.kind === 'max-tokens' || value.kind === 'interrupted') {
    return sameFields(Object.keys(value), ['kind'])
  }
  if (value.kind === 'aborted') {
    return sameFields(Object.keys(value), ['kind', 'reason'])
      && validTurnEndCancelCause(value.reason)
  }
  return value.kind === 'error'
    && sameFields(Object.keys(value), ['kind', 'error'])
    && validLlmFailure(value.error)
}

function parseRequest(body: Uint8Array): StreamRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_STREAM_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (!isObject(value)
      || !sameFields(Object.keys(value), [
        'type', 'protocolVersion', 'sessionId', 'afterSeq', 'partialSeq',
      ])
      || value.type !== 'session_stream_request'
      || (value.protocolVersion !== 1 && value.protocolVersion !== 2 && value.protocolVersion !== 3)
      || !validIdentifier(value.sessionId, MAX_SESSION_ID_CHARS)
      || (value.protocolVersion === 3 && value.partialSeq !== null)
      || (value.afterSeq !== null && !validSeq(value.afterSeq))
      || (value.partialSeq !== null && !validSeq(value.partialSeq))
      || (value.afterSeq === null && value.partialSeq !== null)
      || (value.afterSeq !== null && value.partialSeq !== null
        && Number(value.partialSeq) > Number(value.afterSeq))
      || JSON.stringify(value) !== text) return undefined
    return {
      protocolVersion: value.protocolVersion,
      sessionId: value.sessionId,
      afterSeq: value.afterSeq as number | null,
      partialSeq: value.partialSeq as number | null,
    }
  } catch {
    return undefined
  }
}

function abortError(): Error {
  return new Error('Session stream wait aborted')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function boundedAppend(current: string, addition: string): {
  readonly text: string
  readonly truncated: boolean
} {
  const characters = Array.from(current)
  for (const character of addition) {
    if (characters.length === MAX_SESSION_STREAM_PARTIAL_CHARS) {
      return {
        text: `${characters.slice(0, MAX_SESSION_STREAM_PARTIAL_CHARS - 1).join('')}…`,
        truncated: true,
      }
    }
    characters.push(character)
  }
  return { text: characters.join(''), truncated: false }
}

function immutablePartial(partial: MutablePartial | undefined, protocolVersion: 1 | 2): SessionStreamPartial | null {
  if (partial === undefined || !partial.complete || partial.text === '') return null
  return Object.freeze({
    turn: partial.turn,
    step: partial.step,
    throughSeq: partial.throughSeq,
    text: protocolVersion === 2 ? partial.tail : partial.text,
    truncated: protocolVersion === 2 ? partial.total > partial.tail.length : partial.truncated,
    ...(protocolVersion === 2 ? { offset: partial.total - partial.tail.length } : {}),
  })
}

export function sessionStreamApiProxy(value: unknown): DshSessionStreamApiProxy | undefined {
  if (!isObject(value)
    || !isObject(value.events)
    || typeof value.events.mux !== 'function') return undefined
  return value as unknown as DshSessionStreamApiProxy
}

export class SessionStreamMonitor implements SessionStreamSource {
  private readonly sessions: Map<string, SessionState> = new Map<string, SessionState>()
  private readonly waiters: Set<Waiter> = new Set<Waiter>()
  private active: ActiveMonitor | undefined = undefined
  private online = false

  constructor(
    private readonly onTurnEnded: (
      sessionId: string,
      seq: number,
      kind: SessionTurnEndKind,
      proof?: CompletionProof,
    ) => void = () => undefined,
  ) {}

  attach(api: DshSessionStreamApiProxy): () => void {
    this.detach()
    const active: ActiveMonitor = { api, abort: new AbortController(), token: {} }
    this.active = active
    this.online = true
    void this.consumeUntilDetached(active)
    return () => this.detach(active.token)
  }

  nudge(sessionId: string): void {
    if (!validIdentifier(sessionId, MAX_SESSION_ID_CHARS) || !this.online) return
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId !== sessionId) continue
      const value = this.snapshot(sessionId, waiter.afterSeq, waiter.partialSeq, true, false, waiter.protocolVersion)
      if (value !== undefined) waiter.resolve(value)
    }
  }

  wait(sessionId: string, afterSeq: number | null, partialSeq: number | null,
    signal?: AbortSignal, waitMs: number = SESSION_STREAM_WAIT_MS, protocolVersion: StreamProtocol = 1,
    isCurrent?: () => boolean): Promise<SessionStreamSnapshot | undefined> {
    if (!validIdentifier(sessionId, MAX_SESSION_ID_CHARS)
      || (afterSeq !== null && !validSeq(afterSeq))
      || (partialSeq !== null && !validSeq(partialSeq))
      || (afterSeq === null && partialSeq !== null)
      || (afterSeq !== null && partialSeq !== null && partialSeq > afterSeq)
      || (protocolVersion !== 1 && protocolVersion !== 2 && protocolVersion !== 3)
      || (protocolVersion === 3 && partialSeq !== null)
      || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > SESSION_STREAM_WAIT_MS) {
      return Promise.reject(new Error('Invalid session stream wait'))
    }
    if (signal?.aborted || !currentWait(isCurrent)) return Promise.reject(abortError())
    // A client may replace its authenticated connection before its old HTTP
    // socket closes. Those obsolete polls must not consume the new owner's slots.
    for (const waiter of [...this.waiters]) {
      if (!currentWait(waiter.isCurrent)) waiter.cancel()
    }
    if (this.active === undefined || !this.online) return Promise.resolve(undefined)
    const immediate = this.snapshot(sessionId, afterSeq, partialSeq, false, false, protocolVersion)
    if (immediate !== undefined) return Promise.resolve(immediate)
    if (this.waiters.size >= MAX_STREAM_WAITERS
      || [...this.waiters].filter(waiter => waiter.sessionId === sessionId).length
        >= MAX_STREAM_WAITERS_PER_SESSION) {
      return Promise.reject(new Error('Session stream wait capacity reached'))
    }

    return new Promise((resolve, reject) => {
      let waiter: Waiter
      const finish = (value: SessionStreamSnapshot | undefined): void => {
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
        protocolVersion,
        sessionId,
        afterSeq,
        partialSeq,
        resolve: finish,
        reject,
        cancel: onAbort,
        ...(isCurrent === undefined ? {} : { isCurrent }),
        timer: setTimeout(() => {
          finish(this.snapshot(sessionId, afterSeq, partialSeq, true, false, protocolVersion))
        }, waitMs),
        ...(signal === undefined ? {} : { signal, abort: onAbort }),
      }
      waiter.timer.unref()
      this.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  private async consumeUntilDetached(active: ActiveMonitor): Promise<void> {
    while (this.active?.token === active.token && !active.abort.signal.aborted) {
      try {
        this.online = true
        const stream = active.api.events.mux(
          { rpcId: randomUUID(), payload: {} }, active.abort.signal,
        )
        for await (const envelope of stream) {
          if (this.active?.token !== active.token) return
          this.acceptEnvelope(envelope)
        }
        if (this.active?.token !== active.token) return
        throw new Error('DSH session stream ended')
      } catch {
        if (this.active?.token !== active.token || active.abort.signal.aborted) return
        this.online = false
        this.sessions.clear()
        this.resolveAll(undefined)
        try {
          await delay(RECONNECT_DELAY_MS, active.abort.signal)
        } catch {
          return
        }
      }
    }
  }

  private acceptEnvelope(value: unknown): void {
    if (!isObject(value)
      || !sameFields(Object.keys(value), ['rpcId', 'payload'])
      || !validIdentifier(value.rpcId)
      || !isObject(value.payload)
      || typeof value.payload.type !== 'string') {
      throw new Error('Invalid DSH session stream envelope')
    }
    const payload = value.payload
    if (payload.type === 'session/assistant-stream') {
      this.acceptNativeFrame(payload.sessionId, payload.frame)
      return
    }
    if (payload.type === 'stream-error') throw new Error('DSH session stream failed')
    if (payload.type !== 'session/event') return
    if (!validIdentifier(payload.sessionId, MAX_SESSION_ID_CHARS)
      || !isObject(payload.event)
      || typeof payload.event.type !== 'string'
      || !validSeq(payload.event.seq)
      || !Number.isSafeInteger(payload.event.time)
      || Number(payload.event.time) < 0
      || !isObject(payload.event.data)) {
      throw new Error('Invalid DSH session event')
    }
    this.acceptEvent(payload.sessionId, payload.event)
  }

  private acceptEvent(sessionId: string, event: Record<string, unknown>): void {
    const seq = Number(event.seq)
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      while (this.sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.sessions.delete(oldest)
        this.notify(oldest)
      }
      state = {
        sessionId,
        floorSeq: seq - 1,
        latestSeq: seq - 1,
        calibrationSeq: null,
        resyncSeq: null,
        partial: undefined,
      }
      this.sessions.set(sessionId, state)
    } else {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, state)
    }

    if (seq <= state.latestSeq) return
    if (seq !== state.latestSeq + 1) {
      state.latestSeq = seq
      state.resyncSeq = seq
      state.partial = undefined
      this.notify(sessionId)
      return
    }
    state.latestSeq = seq
    this.projectEvent(state, event)
    this.notify(sessionId)
  }

  /** DSH 0.1.5 presentation chunks do not advance the durable transcript cursor. */
  private acceptNativeFrame(sessionId: unknown, frame: unknown): void {
    if (!validIdentifier(sessionId, MAX_SESSION_ID_CHARS) || !isObject(frame)
      || !validIdentifier(frame.attemptId) || !validSeq(frame.revision)) return
    const state = this.sessions.get(sessionId)
    if (state === undefined || state.latestSeq < 0) return
    if (frame.type === 'start') {
      if (!validSeq(frame.turn) || !validSeq(frame.step)) return
      state.nativeAttempt = { id: frame.attemptId, revision: frame.revision, index: 0, turn: frame.turn, step: frame.step }
      state.partial = { turn: frame.turn, step: frame.step, throughSeq: state.latestSeq,
        text: '', tail: '', total: 0, truncated: false, complete: true, lastTextBlockIndex: null }
      state.nativePartialPending = false
      state.nativePartialPendingV2 = false
      return
    }
    const attempt = state.nativeAttempt
    if (attempt === undefined || attempt.id !== frame.attemptId) return
    if (!validSeq(frame.index) || frame.index !== attempt.index || frame.revision !== attempt.revision + 1) {
      state.partial = undefined
      state.nativeAttempt = undefined
      state.resyncSeq = state.latestSeq
      this.notify(sessionId, true)
      return
    }
    attempt.revision = frame.revision
    if (frame.type === 'chunk') {
      attempt.index++
      const previousTotal = state.partial?.total
      const previousText = state.partial?.text
      const previousTruncated = state.partial?.truncated
      this.projectAssistantChunk(state, state.latestSeq, { turn: attempt.turn, step: attempt.step, chunk: frame.chunk })
      if (state.partial?.text !== previousText || state.partial?.truncated !== previousTruncated) {
        state.nativePartialPending = true
      }
      if (state.partial?.total !== previousTotal) state.nativePartialPendingV2 = true
      this.notify(sessionId, true)
    } else if (frame.type === 'end') {
      state.nativeAttempt = undefined
      state.partial = undefined
      this.notify(sessionId, true)
    }
  }

  private projectEvent(state: SessionState, event: Record<string, unknown>): void {
    const type = event.type
    const seq = Number(event.seq)
    const data = event.data as Record<string, unknown>
    if (type === 'model/selection') {
      // Re-read the authoritative catalog/usage through the existing protocol.
      // Never publish provider credentials or discard an in-progress text tail.
      state.calibrationSeq = seq
      return
    }
    if (type === 'turn/start') {
      state.lastReply = undefined
      if (!validSeq(data.turn) || !sameFields(Object.keys(data), ['turn'])) {
        state.resyncSeq = seq
      } else {
        state.calibrationSeq = seq
      }
      state.partial = undefined
      return
    }
    if (type === 'step/start') {
      if (!validSeq(data.turn) || !validSeq(data.step)) {
        state.resyncSeq = seq
        state.partial = undefined
        return
      }
      if (state.partial !== undefined && state.partial.text !== '') {
        state.resyncSeq = seq
      }
      state.partial = {
        turn: data.turn,
        step: data.step,
        throughSeq: seq,
        text: '', tail: '', total: 0,
        truncated: false,
        complete: true,
        lastTextBlockIndex: null,
      }
      return
    }
    if (type === 'assistant/chunk') {
      this.projectAssistantChunk(state, seq, data)
      return
    }
    if (type === 'assistant/message') {
      if (validSeq(data.turn) && isObject(data.message) && Array.isArray(data.message.content)
        && data.message.content.some((block: unknown) => isObject(block)
          && (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
            || block.type === 'image'))) state.lastReply = { turn: data.turn, seq }
      else state.lastReply = undefined
      if (!validSeq(data.turn) || !validSeq(data.step) || !isObject(data.message)) {
        state.resyncSeq = seq
      } else {
        state.calibrationSeq = seq
      }
      state.partial = undefined
      return
    }
    if (type === 'user/message') {
      if (!isObject(data.source) || typeof data.source.kind !== 'string') {
        state.resyncSeq = seq
        state.partial = undefined
      } else if (data.source.kind === 'user') {
        state.calibrationSeq = seq
        // DSH appends the step's user messages after step/start, before its text.
        if (state.partial === undefined || !state.partial.complete || state.partial.text !== '') {
          state.partial = undefined
        }
      }
      return
    }
    if (type === 'turn/end') {
      if (!validSeq(data.turn)
        || !sameFields(Object.keys(data), ['turn', 'reason'])
        || !validTurnEndReason(data.reason)) state.resyncSeq = seq
      else {
        state.calibrationSeq = seq
        try {
          this.onTurnEnded(
            state.sessionId,
            seq,
            (data.reason as { readonly kind: SessionTurnEndKind }).kind,
            state.lastReply?.turn === data.turn ? completionProof(state.sessionId, seq, data.turn as number,
              event.time as number, state.lastReply.seq) : undefined,
          )
        } catch {
        }
      }
      state.partial = undefined
    }
  }

  private projectAssistantChunk(state: SessionState, seq: number,
    data: Record<string, unknown>): void {
    if (!validSeq(data.turn) || !validSeq(data.step) || !isObject(data.chunk)
      || typeof data.chunk.type !== 'string') {
      state.resyncSeq = seq
      state.partial = undefined
      return
    }
    let partial = state.partial
    if (partial === undefined || partial.turn !== data.turn || partial.step !== data.step) {
      partial = {
        turn: data.turn,
        step: data.step,
        throughSeq: seq,
        text: '', tail: '', total: 0,
        truncated: false,
        complete: false,
        lastTextBlockIndex: null,
      }
      state.partial = partial
    }
    if (data.chunk.type !== 'text-delta') return
    if (!validSeq(data.chunk.index) || typeof data.chunk.text !== 'string') {
      state.resyncSeq = seq
      state.partial = undefined
      return
    }
    if (data.chunk.text === '') return
    const blockIndex = data.chunk.index
    if (partial.lastTextBlockIndex !== null && blockIndex < partial.lastTextBlockIndex) {
      state.resyncSeq = seq
      state.partial = undefined
      return
    }
    const separator = partial.lastTextBlockIndex === null
      || partial.lastTextBlockIndex === blockIndex ? '' : '\n'
    partial.lastTextBlockIndex = blockIndex
    partial.throughSeq = seq
    // Keep the V1 prefix for released clients and a bounded V2 moving window. The
    // durable full-history endpoint supplies every character after settlement.
    const addition = separator + data.chunk.text
    if (!Number.isSafeInteger(partial.total + addition.length)) {
      state.resyncSeq = seq; state.partial = undefined; return
    }
    partial.total += addition.length
    // At most 8000 UTF-16 units are materialized before code-point slicing.
    let tail = (partial.tail + addition.slice(-MAX_SESSION_STREAM_PARTIAL_CHARS * 2)).slice(-MAX_SESSION_STREAM_PARTIAL_CHARS * 2)
    if (tail.charCodeAt(0) >= 0xDC00 && tail.charCodeAt(0) <= 0xDFFF) tail = tail.slice(1)
    partial.tail = Array.from(tail).slice(-MAX_SESSION_STREAM_PARTIAL_CHARS).join('')
    if (partial.truncated) return
    const bounded = boundedAppend(partial.text, `${separator}${data.chunk.text}`)
    partial.text = bounded.text
    partial.truncated = bounded.truncated
  }

  private snapshot(sessionId: string, afterSeq: number | null, partialSeq: number | null,
    force: boolean, forceTransient = false, protocolVersion: StreamProtocol = 1): SessionStreamSnapshot | undefined {
    const state = this.sessions.get(sessionId)
    if (state === undefined) {
      if (partialSeq !== null) {
        return { throughSeq: afterSeq, state: 'resync', partial: null }
      }
      return force ? { throughSeq: afterSeq, state: 'idle', partial: null } : undefined
    }
    if (protocolVersion === 3) {
      const after = afterSeq ?? -1
      if (after > state.latestSeq) return force ? {throughSeq:afterSeq,state:'idle',partial:null} : undefined
      if (after < state.floorSeq || (state.resyncSeq !== null && after < state.resyncSeq)) {
        return {throughSeq:state.latestSeq,state:'resync',partial:null}
      }
      if (state.calibrationSeq !== null && after < state.calibrationSeq) {
        return {throughSeq:state.latestSeq,state:'calibrate',partial:null}
      }
      return force || state.latestSeq > after ? {throughSeq:state.latestSeq,state:'idle',partial:null} : undefined
    }
    // Native frames do not advance the durable cursor. Keep each negotiated
    // projection pending independently, including changes beyond the V1 prefix.
    const pending = protocolVersion === 2 ? state.nativePartialPendingV2 : state.nativePartialPending
    const clearPending = (): void => {
      if (protocolVersion === 2) state.nativePartialPendingV2 = false
      else state.nativePartialPending = false
    }
    const after = afterSeq ?? -1
    const partial = immutablePartial(state.partial, protocolVersion)
    if (after > state.latestSeq) {
      if (partialSeq !== null) {
        return { throughSeq: afterSeq, state: 'resync', partial: null }
      }
      return force ? { throughSeq: afterSeq, state: 'idle', partial: null } : undefined
    }
    if (after < state.floorSeq || (state.resyncSeq !== null && after < state.resyncSeq)) {
      return { throughSeq: state.latestSeq, state: 'resync', partial: null }
    }
    if (state.calibrationSeq !== null && after < state.calibrationSeq) {
      if (partial !== null) clearPending()
      return { throughSeq: state.latestSeq, state: 'calibrate', partial }
    }
    if (partial !== null && (partialSeq !== partial.throughSeq || forceTransient || pending)) {
      clearPending()
      return { throughSeq: state.latestSeq, state: 'streaming', partial }
    }
    if (partial === null && partialSeq !== null) {
      return { throughSeq: state.latestSeq, state: 'resync', partial: null }
    }
    if (force || state.latestSeq > after) {
      if (partial !== null) clearPending()
      return { throughSeq: state.latestSeq, state: 'idle', partial }
    }
    return undefined
  }

  private notify(sessionId: string, forceTransient = false): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId !== sessionId) continue
      const value = this.snapshot(sessionId, waiter.afterSeq, waiter.partialSeq, false, forceTransient, waiter.protocolVersion)
      if (value !== undefined) waiter.resolve(value)
    }
  }

  private resolveAll(value: SessionStreamSnapshot | undefined): void {
    for (const waiter of [...this.waiters]) waiter.resolve(value)
  }

  private detach(token?: object): void {
    if (token !== undefined && this.active?.token !== token) return
    const active = this.active
    this.active = undefined
    this.online = false
    active?.abort.abort()
    this.sessions.clear()
    this.resolveAll(undefined)
  }
}

function responseBody(sessionId: string, requestedAfterSeq: number | null,
  snapshot: SessionStreamSnapshot, protocolVersion: StreamProtocol): string {
  if (protocolVersion === 3 && (snapshot.partial !== null || snapshot.state === 'streaming')) {
    throw new Error('Status stream cannot contain partial text')
  }
  const body = JSON.stringify({
    type: 'session_stream_update',
    protocolVersion,
    sessionId,
    requestedAfterSeq,
    throughSeq: snapshot.throughSeq,
    state: snapshot.state,
    partial: snapshot.partial,
  })
  if (Buffer.byteLength(body) > SESSION_STREAM_RESPONSE_MAX_BYTES) {
    throw new Error('Session stream response is too large')
  }
  return body
}

export function createSessionStreamRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionStreamSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_STREAM_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_STREAM_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') {
      return emptyResponse(400)
    }
    const parsed = parseRequest(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (source === undefined) return emptyResponse(503)
    try {
      const snapshot = await source.wait(
        parsed.sessionId,
        parsed.afterSeq,
        parsed.partialSeq,
        request.signal,
        SESSION_STREAM_WAIT_MS,
        parsed.protocolVersion,
        () => authorizer.authorize(request.authorization, request.connectionGeneration),
      )
      if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
        return emptyResponse(401)
      }
      if (snapshot === undefined) return emptyResponse(503)
      return {
        status: 200,
        contentType: 'application/json',
        body: responseBody(parsed.sessionId, parsed.afterSeq, snapshot, parsed.protocolVersion),
      }
    } catch {
      return emptyResponse(503)
    }
  }
}
