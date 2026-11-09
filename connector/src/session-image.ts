import { createHash } from 'node:crypto'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
import {
  imageRecord, imageReference, parseSessionImageRequest, visibleSessionImage,
  SESSION_IMAGE_CHUNK_BYTES, SESSION_IMAGE_PATH, SESSION_IMAGE_REQUEST_MAX_BYTES,
  SESSION_IMAGE_RESPONSE_MAX_BYTES,
  type SessionImageReference, type SessionImageRequest,
} from './session-image-contract.js'

const CACHE_TTL_MS = 30_000

export interface SessionImageSource {
  readSurface(sessionId: string): Promise<unknown>
  readSession?(sessionId: string): Promise<unknown>
  readAttachment(sessionId: string, attachmentId: string): Promise<unknown>
}

interface CachedImage {
  readonly key: string
  readonly ref: SessionImageReference
  readonly data: Buffer
  readonly expiresAt: number
}

function empty(status: number): PairingV1HttpResponse { return { status, body: '' } }

function sameReference(left: SessionImageReference, right: SessionImageReference): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasImageSignature(data: Buffer, mediaType: SessionImageReference['mediaType']): boolean {
  if (mediaType === 'image/png') return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (mediaType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (mediaType === 'image/gif') return data.subarray(0, 6).toString('ascii') === 'GIF87a'
    || data.subarray(0, 6).toString('ascii') === 'GIF89a'
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP'
}

/** Read only through the official session-bound RPC; never interpret a path or URL. */
export class SessionImageService {
  private cache: CachedImage | undefined
  private timer: NodeJS.Timeout | undefined
  private pending: { readonly key: string; readonly result: Promise<CachedImage> } | undefined
  private disposed = false
  private cacheEpoch = 0

  constructor(private readonly authorizer: SessionListAuthorizer, private readonly source?: SessionImageSource) {}

  private async imageHistory(sessionId: string): Promise<unknown> {
    if(!this.source!.readSession)return this.source!.readSurface(sessionId)
    const raw=await this.source!.readSession(sessionId)
    if(!imageRecord(raw)||!Array.isArray(raw.events))return undefined
    const last: unknown=raw.events.at(-1)
    return {session:raw.session,events:raw.events,capturedThroughSeq:imageRecord(last)?last.seq:null}
  }
  private authorized(request: PairingV1HttpRequest): boolean {
    return !this.disposed && request.signal?.aborted !== true
      && this.authorizer.authorize(request.authorization, request.connectionGeneration)
  }

  private clearCache(): void {
    this.cacheEpoch++
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.cache?.data.fill(0)
    this.cache = undefined
  }

  dispose(): void {
    this.disposed = true
    this.clearCache()
  }

  private async load(key: string, ref: SessionImageReference, parsed: SessionImageRequest,
    request: PairingV1HttpRequest): Promise<CachedImage> {
    const epoch = this.cacheEpoch
    const result: unknown = await this.source!.readAttachment(parsed.sessionId, ref.attachmentId)
    if (!this.authorized(request)) throw new Error('unauthorized image read')
    const current = visibleSessionImage(await this.imageHistory(parsed.sessionId), parsed)
    if (!this.authorized(request)) throw new Error('unauthorized image read')
    if (epoch !== this.cacheEpoch || current === undefined || !sameReference(current, ref)) {
      throw new Error('image reference changed')
    }
    if (imageRecord(result) && imageRecord(result.result) && result.result.ok === false
      && imageRecord(result.result.error) && result.result.error.code === 'attachment-error'
      && imageRecord(result.result.error.details) && result.result.error.details.reason === 'ATTACHMENT_CORRUPT') {
      throw new Error('invalid image')
    }
    if (!imageRecord(result) || !imageRecord(result.result) || result.result.ok !== true
      || !imageRecord(result.result.value)) throw new Error('unavailable image')
    const value = result.result.value
    const actual = imageReference(value.attachment, ref.blockIndex)
    if (actual === undefined || !sameReference(actual, ref)
      || typeof value.data !== 'string'
      || value.data.length !== 4 * Math.ceil(ref.bytes / 3)) throw new Error('invalid image')
    const data = Buffer.from(value.data, 'base64')
    if (data.byteLength !== ref.bytes || data.toString('base64') !== value.data
      || !hasImageSignature(data, ref.mediaType)
      || `sha256:${createHash('sha256').update(data).digest('hex')}` !== ref.attachmentId) {
      data.fill(0)
      throw new Error('invalid image')
    }
    if (!this.authorized(request)) {
      data.fill(0)
      throw new Error('unauthorized image read')
    }
    this.clearCache()
    const cached: CachedImage = { key, ref, data, expiresAt: Date.now() + CACHE_TTL_MS }
    this.cache = cached
    this.timer = setTimeout(() => {
      if (this.cache === cached) this.clearCache()
    }, CACHE_TTL_MS)
    this.timer.unref()
    return cached
  }

  async handle(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_IMAGE_PATH) return empty(404)
    if (request.method !== 'POST') return empty(405)
    if (!(request.body instanceof Uint8Array)) return empty(400)
    if (request.body.byteLength > SESSION_IMAGE_REQUEST_MAX_BYTES) return empty(413)
    if (request.path !== barePath || request.contentType !== 'application/json') return empty(400)
    const parsed = parseSessionImageRequest(request.body)
    if (parsed === undefined) return empty(400)
    if (typeof request.authorization !== 'string' || typeof request.connectionGeneration !== 'string') return empty(401)
    const key = createHash('sha256').update(JSON.stringify([
      request.authorization, request.connectionGeneration, parsed.sessionId,
      parsed.seq, parsed.blockIndex, parsed.attachmentId,
    ])).digest('hex')
    if (!this.authorized(request)) {
      if (this.cache?.key === key || this.pending?.key === key) this.clearCache()
      return empty(401)
    }
    if (this.source === undefined) return empty(503)
    if (this.cache !== undefined && (this.cache.key !== key || Date.now() >= this.cache.expiresAt)) {
      this.clearCache()
    }
    try {
      const surface = await this.imageHistory(parsed.sessionId)
      if (!this.authorized(request)) { this.clearCache(); return empty(401) }
      const ref = visibleSessionImage(surface, parsed)
      if (ref === undefined) {
        if (this.cache?.key === key || this.pending?.key === key) this.clearCache()
        return empty(409)
      }
      if (parsed.offset >= ref.bytes) return empty(400)
      let cached = this.cache
      if (cached !== undefined && (cached.key !== key || !sameReference(cached.ref, ref)
        || Date.now() >= cached.expiresAt)) {
        this.clearCache()
        cached = undefined
      }
      if (cached === undefined) {
        if (this.pending !== undefined && this.pending.key !== key) return empty(409)
        if (this.pending === undefined) {
          const result = this.load(key, ref, parsed, request)
          this.pending = { key, result }
        }
        const pending = this.pending
        try {
          cached = await pending.result
        } finally {
          if (this.pending === pending) this.pending = undefined
        }
      }
      if (!this.authorized(request)) { this.clearCache(); return empty(401) }
      if (!sameReference(cached.ref, ref) || this.cache !== cached) return empty(409)
      const end = Math.min(parsed.offset + SESSION_IMAGE_CHUNK_BYTES, ref.bytes)
      const body = JSON.stringify({
        type: 'session_image_chunk', protocolVersion: 1, sessionId: parsed.sessionId,
        seq: parsed.seq, blockIndex: parsed.blockIndex, attachmentId: ref.attachmentId,
        mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
        offset: parsed.offset, data: cached.data.subarray(parsed.offset, end).toString('base64url'),
        last: end === ref.bytes,
      })
      return Buffer.byteLength(body) <= SESSION_IMAGE_RESPONSE_MAX_BYTES
        ? { status: 200, contentType: 'application/json', body } : empty(503)
    } catch (error) {
      if (!this.authorized(request)) { this.clearCache(); return empty(401) }
      if (this.cache?.key === key) this.clearCache()
      if (error instanceof Error && error.message === 'image reference changed') return empty(409)
      return empty(error instanceof Error && error.message === 'invalid image' ? 422 : 503)
    }
  }
}
