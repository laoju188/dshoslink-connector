import { SessionAudioService, type SessionAudioSource } from './session-audio.js'
import { parseAudioRequest } from './session-audio-contract.js'
import { GIF_MAX_BYTES } from './session-media-contract.js'
import type { SessionVideoSource } from './session-video.js'
import { SessionOutputReader, parseSessionOutputRequest } from './session-output.js'
import { parseSessionContentRequest, sessionContentResponse } from './session-content.js'
import { ContentPageStale } from './session-content-page.js'
import {
  MAX_PAIRING_MESSAGE_BYTES,
  type PairingV1HttpRequest,
  type PairingV1HttpResponse,
} from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
import {
  imageReference, SESSION_MESSAGE_MAX_BLOCKS, SESSION_MESSAGE_MAX_IMAGES,
  type SessionImageReference,
} from './session-image-contract.js'

export const SESSION_DETAIL_PATH = '/dshos/v1/session-detail'
export const SESSION_DETAIL_RESPONSE_MAX_BYTES = 512 * 1_024
export const MAX_SESSION_DETAIL_ITEMS = 200
export const MAX_SESSION_MESSAGE_CHARS = 4_000

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface SessionDetailSource extends SessionAudioSource, SessionVideoSource {
  readSurface(sessionId: string): Promise<unknown>
  readSession?(sessionId: string): Promise<unknown>
  outputRoot?(): string | undefined
}

interface SessionDetailRequest {
  readonly sessionId: string
  readonly protocolVersion: 2 | 3
}

interface ProjectedMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly operationId: string | null
}

interface ProjectedSnapshot {
  readonly capturedThroughSeq: number | null
  readonly messages: (ProjectedMessage | ProjectedRichMessage)[]
  readonly truncated: boolean
}

interface ProjectedRichMessage {
  readonly seq: number
  readonly role: 'user' | 'assistant'
  readonly operationId: string | null
  readonly content: ({ readonly type: 'text'; readonly text: string } | SessionImageReference)[]
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

function operationId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.byteLength === 16 && decoded.toString('base64url') === value ? value : null
  } catch {
    return null
  }
}

function parseRequest(body: Uint8Array): SessionDetailRequest | undefined {
  if (!(body instanceof Uint8Array) || body.byteLength === 0) return undefined
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    if (!isObject(value)
      || !sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId'])
      || value.type !== 'session_detail_request'
      || (value.protocolVersion !== 2 && value.protocolVersion !== 3)
      || typeof value.sessionId !== 'string'
      || value.sessionId.length === 0
      || value.sessionId.length > 256
      || JSON.stringify(value) !== text) return undefined
    return { sessionId: value.sessionId, protocolVersion: value.protocolVersion }
  } catch {
    return undefined
  }
}

function boundedText(text: string): { readonly text: string; readonly truncated: boolean } {
  const characters = Array.from(text)
  if (characters.length <= MAX_SESSION_MESSAGE_CHARS) return { text, truncated: false }
  return {
    text: `${characters.slice(0, MAX_SESSION_MESSAGE_CHARS - 1).join('')}…`,
    truncated: true,
  }
}

function visibleText(content: unknown): { readonly text: string; readonly truncated: boolean } | undefined {
  if (!Array.isArray(content)) throw new Error('invalid session message content')
  const text: string[] = []
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== 'string') {
      throw new Error('invalid session message block')
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new Error('invalid session text block')
      text.push(block.text)
    }
  }
  const joined = text.join('\n')
  return joined === '' ? undefined : boundedText(joined)
}

function visibleContent(content: unknown): { readonly blocks: ProjectedRichMessage['content']; readonly truncated: boolean } {
  if (!Array.isArray(content)) throw new Error('invalid session message content')
  const blocks: ProjectedRichMessage['content'] = []
  let remaining = MAX_SESSION_MESSAGE_CHARS
  let images = 0
  let truncated = false
  for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
    const block: unknown = content[blockIndex]
    if (!isObject(block) || typeof block.type !== 'string') throw new Error('invalid session message block')
    if (block.type !== 'text' && block.type !== 'image') continue
    if (blocks.length >= SESSION_MESSAGE_MAX_BLOCKS) { truncated = true; break }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new Error('invalid session text block')
      if (block.text === '') continue
      if (remaining === 0) { truncated = true; continue }
      const chars = Array.from(block.text)
      const text = chars.length <= remaining ? block.text : `${chars.slice(0, remaining - 1).join('')}…`
      truncated ||= chars.length > remaining
      remaining -= Math.min(remaining, chars.length)
      blocks.push({ type: 'text', text })
    } else {
      const ref = imageReference(block.attachment, blockIndex)
      if (ref === undefined || images >= SESSION_MESSAGE_MAX_IMAGES) { truncated = true; continue }
      blocks.push(ref)
      images++
    }
  }
  return { blocks, truncated }
}

function projectSnapshot(value: unknown, sessionId: string, version: 2 | 3): ProjectedSnapshot {
  if (!isObject(value)
    || !isObject(value.session)
    || value.session.id !== sessionId
    || (value.capturedThroughSeq !== null
      && (!Number.isSafeInteger(value.capturedThroughSeq) || Number(value.capturedThroughSeq) < 0))
    || !Array.isArray(value.events)) throw new Error('invalid session surface')

  const capturedThroughSeq = value.capturedThroughSeq as number | null
  if (capturedThroughSeq === null && value.events.length !== 0) {
    throw new Error('invalid empty session surface')
  }
  const seen = new Set<number>()
  const messages: (ProjectedMessage | ProjectedRichMessage)[] = []
  let truncated = false
  for (const event of value.events) {
    if (!isObject(event)
      || (event.type !== 'user/message'
        && event.type !== 'system/message'
        && event.type !== 'developer/message'
        && event.type !== 'assistant/message'
        && event.type !== 'tool/call'
        && event.type !== 'tool/result')
      || !Number.isSafeInteger(event.seq)
      || Number(event.seq) < 0
      || (capturedThroughSeq !== null && Number(event.seq) > capturedThroughSeq)
      || seen.has(Number(event.seq))
      || !Number.isSafeInteger(event.time)
      || Number(event.time) < 0
      || !isObject(event.data)) throw new Error('invalid session surface event')
    seen.add(Number(event.seq))

    if (event.type === 'system/message' || event.type === 'developer/message' || event.type === 'tool/call' || event.type === 'tool/result') continue
    if (version === 3) {
      let content: unknown
      const role = event.type === 'user/message' ? 'user' : 'assistant'
      let rpcId: string | null = null
      if (role === 'user') {
        if (!isObject(event.data.source) || typeof event.data.source.kind !== 'string') {
          throw new Error('invalid user message source')
        }
        if (event.data.source.kind !== 'user') continue
        content = event.data.content
        rpcId = operationId(event.data.source.rpcId)
      } else {
        if (!isObject(event.data.message)) throw new Error('invalid assistant message')
        content = event.data.message.content
      }
      const rich = visibleContent(content)
      if (rich.blocks.length > 0) {
        messages.push({ seq: Number(event.seq), role, operationId: rpcId, content: rich.blocks })
      }
      truncated ||= rich.truncated
      continue
    }
    let projected: { readonly text: string; readonly truncated: boolean } | undefined
    if (event.type === 'user/message') {
      if (!isObject(event.data.source) || typeof event.data.source.kind !== 'string') {
        throw new Error('invalid user message source')
      }
      if (event.data.source.kind !== 'user') continue
      projected = visibleText(event.data.content)
      if (projected !== undefined) {
        messages.push({
          role: 'user',
          text: projected.text,
          operationId: operationId(event.data.source.rpcId),
        })
      }
    } else {
      if (!isObject(event.data.message)) throw new Error('invalid assistant message')
      projected = visibleText(event.data.message.content)
      if (projected !== undefined) {
        messages.push({ role: 'assistant', text: projected.text, operationId: null })
      }
    }
    truncated ||= projected?.truncated === true
  }

  if (messages.length > MAX_SESSION_DETAIL_ITEMS) {
    messages.splice(0, messages.length - MAX_SESSION_DETAIL_ITEMS)
    truncated = true
  }
  return { capturedThroughSeq, messages, truncated }
}

function responseBody(sessionId: string, snapshot: ProjectedSnapshot, protocolVersion: 2 | 3): string {
  let truncated = snapshot.truncated
  const messages = snapshot.messages.slice()
  while (true) {
    const body = JSON.stringify({
      type: 'session_detail',
      protocolVersion,
      sessionId,
      capturedThroughSeq: snapshot.capturedThroughSeq,
      truncated,
      messages,
    })
    if (Buffer.byteLength(body) <= SESSION_DETAIL_RESPONSE_MAX_BYTES) return body
    if (messages.length === 0) throw new Error('session detail response cannot fit')
    messages.shift()
    truncated = true
  }
}

export function createSessionDetailRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionDetailSource,
) {
  const outputs = new SessionOutputReader(source ?? {})
  const audio = new SessionAudioService(authorizer, source)
  const gif = new SessionAudioService(authorizer, source, 'gif')
  const handler = async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_DETAIL_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_PAIRING_MESSAGE_BYTES) return emptyResponse(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return emptyResponse(400)
    const audioRequest = parseAudioRequest(request.body)
    const gifRequest = audioRequest === undefined ? parseAudioRequest(request.body, 'session_gif_request', GIF_MAX_BYTES) : undefined
    const output = parseSessionOutputRequest(request.body)
    const content = parseSessionContentRequest(request.body)
    const parsed = parseRequest(request.body)
    if (parsed === undefined && content === undefined && output === undefined && audioRequest === undefined && gifRequest === undefined) return emptyResponse(400)
    if (!authorizer.authorize(request.authorization, request.connectionGeneration)) {
      return emptyResponse(401)
    }
    if (source === undefined) return emptyResponse(503)

    try {
      if (audioRequest !== undefined) return audio.handle(request,audioRequest)
      if (gifRequest !== undefined) return gif.handle(request,gifRequest)
      if (output !== undefined) {
        const check = (): void => {
          if (request.signal?.aborted === true || !authorizer.authorize(request.authorization, request.connectionGeneration)) throw Error('output_unauthorized')
        }
        const body = await outputs.handle(output, check, JSON.stringify([request.authorization, request.connectionGeneration]))
        check()
        return {status:200,contentType:'application/json',body}
      }
      if (content !== undefined) {
        if (!source.readSession) return emptyResponse(503)
        const raw = await source.readSession(content.sessionId)
        if (request.signal?.aborted === true || !authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
        const body = sessionContentResponse(raw,content)
        if (!authorizer.authorize(request.authorization,request.connectionGeneration)) return emptyResponse(401)
        return {status:200,contentType:'application/json',body}
      }
      if (parsed === undefined) return emptyResponse(400)
      const snapshot = projectSnapshot(await source.readSurface(parsed.sessionId), parsed.sessionId, parsed.protocolVersion)
      if (request.signal?.aborted === true
        || !authorizer.authorize(request.authorization, request.connectionGeneration)) return emptyResponse(401)
      return {
        status: 200,
        contentType: 'application/json',
        body: responseBody(parsed.sessionId, snapshot, parsed.protocolVersion),
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'output_unauthorized') return emptyResponse(401)
      return emptyResponse(error instanceof ContentPageStale || error instanceof Error && error.message === 'output_changed' ? 409 : 503)
    }
   }
  return Object.assign(handler,{dispose:()=>{audio.dispose();gif.dispose()}})
}
