import { randomUUID } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import {
  MAX_SESSION_ID_CHARS,
  type SessionListAuthorizer,
} from './session-list.js'

export const SESSION_QUESTION_LIST_PATH = '/dshos/v1/session-questions'
export const SESSION_QUESTION_RESPONSE_PATH = '/dshos/v1/session-question-response'
export const MAX_SESSION_QUESTION_REQUEST_BYTES = 16 * 1_024
export const MAX_SESSION_QUESTION_RESPONSE_BYTES = 256 * 1_024
export const MAX_SESSION_QUESTION_REQUESTS = 20
export const MAX_SESSION_QUESTIONS_PER_REQUEST = 20
export const MAX_SESSION_QUESTION_OPTIONS = 50

const MAX_PENDING_QUESTION_REQUESTS = 100
const MAX_IDENTIFIER_CHARS = 256
const MAX_VISIBLE_TEXT_CHARS = 16_000
const MAX_CUSTOM_ANSWER_CHARS = 4_000
const RECONNECT_DELAY_MS = 500
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SessionQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface SessionQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options: readonly SessionQuestionOption[]
  readonly multiSelect: boolean
}

export interface SessionQuestionRequest {
  readonly questionRpcId: string
  readonly questions: readonly SessionQuestionItem[]
}

export interface SessionQuestionSnapshot {
  readonly requests: readonly SessionQuestionRequest[]
  readonly truncated: boolean
}

export interface SessionQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export type SessionQuestionResponseResult =
  | 'accepted'
  | 'conflict'
  | 'invalid'
  | 'unavailable'

export interface SessionQuestionSource {
  list(sessionId: string): SessionQuestionSnapshot | undefined
  answer(
    sessionId: string,
    questionRpcId: string,
    answers: readonly SessionQuestionAnswerItem[],
  ): Promise<SessionQuestionResponseResult>
  cancel(sessionId: string, questionRpcId: string): Promise<SessionQuestionResponseResult>
}

interface DshQuestionMuxRequest {
  readonly rpcId: string
  readonly payload: Record<string, never>
}

export interface DshQuestionApiProxy {
  readonly events: {
    mux(request: DshQuestionMuxRequest, signal: AbortSignal): AsyncIterable<unknown>
  }
  respond(response: unknown): Promise<unknown>
}

interface PendingQuestionRequest extends SessionQuestionRequest {
  readonly sessionId: string
}

interface ActiveMonitor {
  readonly api: DshQuestionApiProxy
  readonly abort: AbortController
  readonly token: object
}

interface ListRequest {
  readonly type: 'list'
  readonly sessionId: string
}

interface AnswerRequest {
  readonly type: 'answer'
  readonly sessionId: string
  readonly questionRpcId: string
  readonly answers: readonly SessionQuestionAnswerItem[]
}

interface CancelRequest {
  readonly type: 'cancel'
  readonly sessionId: string
  readonly questionRpcId: string
}

type ParsedRequest = ListRequest | AnswerRequest | CancelRequest

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

function codePointLength(value: string): number {
  return Array.from(value).length
}

function validIdentifier(value: unknown, maximum = MAX_IDENTIFIER_CHARS): value is string {
  return typeof value === 'string'
    && value.length > 0
    && codePointLength(value) <= maximum
}

function validVisibleText(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && codePointLength(value) <= MAX_VISIBLE_TEXT_CHARS
}

function validCustomAnswer(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length > 0
    && codePointLength(normalized) <= MAX_CUSTOM_ANSWER_CHARS
}

function parseQuestionOption(value: unknown): SessionQuestionOption | undefined {
  if (!isObject(value)) return undefined
  const expected = value.description === undefined
    ? ['label']
    : ['label', 'description']
  if (!sameFields(Object.keys(value), expected)
    || !validVisibleText(value.label)
    || (value.description !== undefined && !validVisibleText(value.description, true))) return undefined
  return Object.freeze({
    label: value.label,
    ...(value.description === undefined ? {} : { description: value.description }),
  })
}

function validQuestionIntent(value: unknown, detail: unknown,
  labels: ReadonlySet<string>): boolean {
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['kind', 'approve'])
    || value.kind !== 'plan-review'
    || !validVisibleText(detail, true)
    || !validVisibleText(value.approve)) return false
  return labels.has(value.approve)
}

function parseQuestion(value: unknown): SessionQuestionItem | undefined {
  if (!isObject(value)) return undefined
  const expected = ['id', 'question']
  if ('detail' in value) expected.push('detail')
  if ('header' in value) expected.push('header')
  if ('options' in value) expected.push('options')
  if ('multiSelect' in value) expected.push('multiSelect')
  if ('intent' in value) expected.push('intent')
  if (!sameFields(Object.keys(value), expected)
    || !validIdentifier(value.id)
    || !validVisibleText(value.question)
    || (value.detail !== undefined && !validVisibleText(value.detail, true))
    || (value.header !== undefined && !validVisibleText(value.header, true))
    || (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean')
    || (value.options !== undefined && !Array.isArray(value.options))) return undefined

  const rawOptions = value.options as unknown[] | undefined
  if (rawOptions !== undefined && rawOptions.length > MAX_SESSION_QUESTION_OPTIONS) return undefined
  const options: SessionQuestionOption[] = []
  const labels = new Set<string>()
  for (const rawOption of rawOptions ?? []) {
    const option = parseQuestionOption(rawOption)
    if (option === undefined || labels.has(option.label)) return undefined
    labels.add(option.label)
    options.push(option)
  }
  if (value.intent !== undefined && !validQuestionIntent(value.intent, value.detail, labels)) {
    return undefined
  }
  return Object.freeze({
    id: value.id,
    question: value.question,
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    ...(value.header === undefined ? {} : { header: value.header as string }),
    options: Object.freeze(options),
    multiSelect: value.multiSelect === true,
  })
}

function parseAnswerItem(value: unknown): SessionQuestionAnswerItem | undefined {
  if (!isObject(value)) return undefined
  const custom = value.custom === undefined
    ? undefined
    : validCustomAnswer(value.custom) ? value.custom.trim() : undefined
  const expected = value.custom === undefined
    ? ['id', 'selected']
    : ['id', 'selected', 'custom']
  if (!sameFields(Object.keys(value), expected)
    || !validIdentifier(value.id)
    || !Array.isArray(value.selected)
    || value.selected.length > MAX_SESSION_QUESTION_OPTIONS
    || (value.custom !== undefined && custom === undefined)) return undefined
  const selected: string[] = []
  const labels = new Set<string>()
  for (const label of value.selected) {
    if (!validVisibleText(label) || labels.has(label)) return undefined
    labels.add(label)
    selected.push(label)
  }
  return Object.freeze({
    id: value.id,
    selected: Object.freeze(selected),
    ...(custom === undefined ? {} : { custom }),
  })
}

function parseRequest(body: Uint8Array): ParsedRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_QUESTION_REQUEST_BYTES) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (!isObject(value) || value.protocolVersion !== 1 || JSON.stringify(value) !== text) return undefined
    if (value.type === 'session_question_list_request') {
      if (!sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId'])
        || !validIdentifier(value.sessionId, MAX_SESSION_ID_CHARS)) return undefined
      return { type: 'list', sessionId: value.sessionId }
    }
    if (value.type === 'session_question_answer_request') {
      if (!sameFields(Object.keys(value), [
        'type', 'protocolVersion', 'sessionId', 'questionRpcId', 'answers',
      ])
        || !validIdentifier(value.sessionId, MAX_SESSION_ID_CHARS)
        || !validIdentifier(value.questionRpcId)
        || !Array.isArray(value.answers)
        || value.answers.length === 0
        || value.answers.length > MAX_SESSION_QUESTIONS_PER_REQUEST) return undefined
      const answers: SessionQuestionAnswerItem[] = []
      const ids = new Set<string>()
      for (const rawAnswer of value.answers) {
        const answer = parseAnswerItem(rawAnswer)
        if (answer === undefined || ids.has(answer.id)) return undefined
        ids.add(answer.id)
        answers.push(answer)
      }
      return {
        type: 'answer',
        sessionId: value.sessionId,
        questionRpcId: value.questionRpcId,
        answers: Object.freeze(answers),
      }
    }
    if (value.type === 'session_question_cancel_request') {
      if (!sameFields(Object.keys(value), [
        'type', 'protocolVersion', 'sessionId', 'questionRpcId',
      ])
        || !validIdentifier(value.sessionId, MAX_SESSION_ID_CHARS)
        || !validIdentifier(value.questionRpcId)) return undefined
      return {
        type: 'cancel',
        sessionId: value.sessionId,
        questionRpcId: value.questionRpcId,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

function exactReceipt(value: unknown): 'accepted' | 'not-pending' | 'invalid' {
  if (!isObject(value) || typeof value.accepted !== 'boolean') return 'invalid'
  if (value.accepted) {
    return sameFields(Object.keys(value), ['accepted']) ? 'accepted' : 'invalid'
  }
  if (!sameFields(Object.keys(value), ['accepted', 'reason'])) return 'invalid'
  return value.reason === 'not-pending' ? 'not-pending' : 'invalid'
}

function answersMatch(answers: readonly SessionQuestionAnswerItem[],
  pending: PendingQuestionRequest): boolean {
  if (answers.length !== pending.questions.length) return false
  return answers.every((answer, index) => {
    const question = pending.questions[index]
    if (question === undefined || answer.id !== question.id) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom.length === 0) return false
    if (!question.multiSelect) {
      if (custom !== undefined && answer.selected.length > 0) return false
      if (answer.selected.length > 1) return false
    }
    const labels = new Set(question.options.map(option => option.label))
    return answer.selected.every(label => labels.has(label))
  })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Question monitor detached'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref()
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Question monitor detached'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function questionApiProxy(value: unknown): DshQuestionApiProxy | undefined {
  if (!isObject(value)
    || !isObject(value.events)
    || typeof value.events.mux !== 'function'
    || typeof value.respond !== 'function') return undefined
  return value as unknown as DshQuestionApiProxy
}

export class SessionQuestionMonitor implements SessionQuestionSource {
  private readonly pending: Map<string, PendingQuestionRequest> = new Map()
  private readonly inFlight: Set<string> = new Set()
  private active: ActiveMonitor | undefined = undefined
  private online = false

  constructor(
    private readonly onChanged: (sessionId: string) => void = () => undefined,
    private readonly onRequested: (sessionId: string, questionRpcId: string) => void = () => undefined,
  ) {}

  attach(api: DshQuestionApiProxy): () => void {
    this.detach()
    const active: ActiveMonitor = { api, abort: new AbortController(), token: {} }
    this.active = active
    void this.consumeUntilDetached(active)
    return () => this.detach(active.token)
  }

  list(sessionId: string): SessionQuestionSnapshot | undefined {
    if (this.active === undefined || !this.online) return undefined
    const pending = [...this.pending.values()].filter(item => item.sessionId === sessionId)
    const requests = pending.slice(0, MAX_SESSION_QUESTION_REQUESTS).map(item => Object.freeze({
      questionRpcId: item.questionRpcId,
      questions: item.questions,
    }))
    return { requests, truncated: pending.length > requests.length }
  }

  answer(sessionId: string, questionRpcId: string,
    answers: readonly SessionQuestionAnswerItem[]): Promise<SessionQuestionResponseResult> {
    return this.respond(sessionId, questionRpcId, answers)
  }

  cancel(sessionId: string, questionRpcId: string): Promise<SessionQuestionResponseResult> {
    return this.respond(sessionId, questionRpcId)
  }

  private async respond(sessionId: string, questionRpcId: string,
    answers?: readonly SessionQuestionAnswerItem[]): Promise<SessionQuestionResponseResult> {
    const active = this.active
    if (active === undefined || !this.online) return 'unavailable'
    const pending = this.pending.get(questionRpcId)
    if (pending === undefined || pending.sessionId !== sessionId || this.inFlight.has(questionRpcId)) {
      return 'conflict'
    }
    if (answers !== undefined && !answersMatch(answers, pending)) return 'invalid'
    this.inFlight.add(questionRpcId)
    try {
      const response = answers === undefined
        ? {
          type: 'client-response',
          rpcId: questionRpcId,
          result: {
            ok: false,
            error: {
              code: 'cancelled',
              message: 'the user closed this question request',
              details: {},
            },
          },
        }
        : {
          type: 'client-response',
          rpcId: questionRpcId,
          result: {
            ok: true,
            value: {
              sessionId,
              answer: {
                answers: answers.map(answer => ({
                  id: answer.id,
                  selected: [...answer.selected],
                  ...(answer.custom === undefined ? {} : { custom: answer.custom }),
                })),
              },
            },
          },
        }
      const receipt = exactReceipt(await active.api.respond(response))
      if (receipt === 'accepted') {
        this.pending.delete(questionRpcId)
        this.notifyChanged(sessionId)
        return 'accepted'
      }
      if (receipt === 'not-pending') {
        this.pending.delete(questionRpcId)
        this.notifyChanged(sessionId)
        return 'conflict'
      }
      return 'unavailable'
    } catch {
      return 'unavailable'
    } finally {
      this.inFlight.delete(questionRpcId)
    }
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
        throw new Error('DSH question stream ended')
      } catch {
        if (this.active?.token !== active.token || active.abort.signal.aborted) return
        this.online = false
        this.clearPendingAndNotify()
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
      throw new Error('Invalid DSH question envelope')
    }
    const payload = value.payload
    if (payload.type === 'question/requested') {
      if (!sameFields(Object.keys(payload), ['type', 'sessionId', 'questions'])
        || !validIdentifier(payload.sessionId, MAX_SESSION_ID_CHARS)
        || !Array.isArray(payload.questions)
        || payload.questions.length === 0
        || payload.questions.length > MAX_SESSION_QUESTIONS_PER_REQUEST) {
        throw new Error('Invalid DSH question request')
      }
      const questions: SessionQuestionItem[] = []
      const ids = new Set<string>()
      for (const rawQuestion of payload.questions) {
        const question = parseQuestion(rawQuestion)
        if (question === undefined || ids.has(question.id)) {
          throw new Error('Invalid DSH question request')
        }
        ids.add(question.id)
        questions.push(question)
      }
      const pending: PendingQuestionRequest = Object.freeze({
        sessionId: payload.sessionId,
        questionRpcId: value.rpcId,
        questions: Object.freeze(questions),
      })
      const existing = this.pending.get(value.rpcId)
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(pending)) {
          throw new Error('Changed DSH question replay')
        }
        return
      }
      if (this.pending.size >= MAX_PENDING_QUESTION_REQUESTS) {
        throw new Error('Too many pending DSH question requests')
      }
      this.pending.set(value.rpcId, pending)
      try {
        this.onRequested(payload.sessionId, value.rpcId)
      } catch {
      }
      this.notifyChanged(payload.sessionId)
      return
    }
    if (payload.type === 'question/resolved') {
      if (!sameFields(Object.keys(payload), [
        'type', 'sessionId', 'questionRpcId', 'outcome',
      ])
        || !validIdentifier(payload.sessionId, MAX_SESSION_ID_CHARS)
        || !validIdentifier(payload.questionRpcId)
        || (payload.outcome !== 'answered' && payload.outcome !== 'cancelled')) {
        throw new Error('Invalid DSH question resolution')
      }
      const pending = this.pending.get(payload.questionRpcId)
      if (pending !== undefined && pending.sessionId !== payload.sessionId) {
        throw new Error('Mismatched DSH question resolution')
      }
      if (this.pending.delete(payload.questionRpcId)) this.notifyChanged(payload.sessionId)
    }
  }

  private notifyChanged(sessionId: string): void {
    try {
      this.onChanged(sessionId)
    } catch {
    }
  }

  private clearPendingAndNotify(): void {
    const sessionIds = new Set([...this.pending.values()].map(item => item.sessionId))
    this.pending.clear()
    this.inFlight.clear()
    for (const sessionId of sessionIds) this.notifyChanged(sessionId)
  }

  private detach(token?: object): void {
    if (token !== undefined && this.active?.token !== token) return
    const active = this.active
    this.active = undefined
    this.online = false
    active?.abort.abort()
    this.clearPendingAndNotify()
  }
}

export function createSessionQuestionListRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionQuestionSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_QUESTION_LIST_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_QUESTION_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return emptyResponse(400)
    const parsed = parseRequest(request.body)
    if (parsed?.type !== 'list') return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    const snapshot = source?.list(parsed.sessionId)
    if (snapshot === undefined) return emptyResponse(503)
    const body = JSON.stringify({
      type: 'session_question_list',
      protocolVersion: 1,
      sessionId: parsed.sessionId,
      truncated: snapshot.truncated,
      requests: snapshot.requests,
    })
    if (Buffer.byteLength(body) > MAX_SESSION_QUESTION_RESPONSE_BYTES) return emptyResponse(503)
    return { status: 200, contentType: 'application/json', body }
  }
}

export function createSessionQuestionResponseRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionQuestionSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_QUESTION_RESPONSE_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_SESSION_QUESTION_REQUEST_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return emptyResponse(400)
    const parsed = parseRequest(request.body)
    if (parsed === undefined || parsed.type === 'list') return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (source === undefined) return emptyResponse(503)
    const result = parsed.type === 'answer'
      ? await source.answer(parsed.sessionId, parsed.questionRpcId, parsed.answers)
      : await source.cancel(parsed.sessionId, parsed.questionRpcId)
    if (result === 'invalid') return emptyResponse(400)
    if (result === 'conflict') return emptyResponse(409)
    if (result !== 'accepted') return emptyResponse(503)
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'session_question_response_accepted',
        protocolVersion: 1,
        accepted: true,
      }),
    }
  }
}
