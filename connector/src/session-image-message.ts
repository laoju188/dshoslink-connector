import { createHash, randomBytes } from 'node:crypto'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
import { MAX_SESSION_PROMPT_CHARS, responseKind, type SessionMessageSource } from './session-message.js'
import { SESSION_IMAGE_MAX_BYTES } from './session-image-contract.js'
import { prepareSessionImage, type SessionImagePreparer } from './session-image-prepare.js'

export const SESSION_IMAGE_MESSAGE_PATH = '/dshos/v1/session-image-message'
export const SESSION_IMAGE_MESSAGE_REQUEST_MAX_BYTES = 180 * 1024
export const SESSION_IMAGE_MESSAGE_CHUNK_BYTES = 128 * 1024
export const SESSION_IMAGE_MESSAGE_MAX_BYTES = 20 * 1024 * 1024
export const SESSION_IMAGE_MESSAGE_MAX_IMAGES = 20
const ID = /^[A-Za-z0-9_-]{22}$/
const SHA = /^[0-9a-f]{64}$/
const MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

interface Manifest {
  mediaType: string
  name: string
  size: number
  sha256: string
}
interface Upload {
  id: string
  authorization: string | undefined
  generation: string | undefined
  operationId: string
  sessionId: string
  mode: 'queue' | 'steer'
  text: string
  images: Manifest[]
  buffers: Buffer[]
  imageIndex: number
  offset: number
  submitting: boolean
  timer?: NodeJS.Timeout
}
const empty = (status: number): PairingV1HttpResponse => ({ status, body: '' })
const json = (value: unknown): PairingV1HttpResponse => ({
  status: 200, contentType: 'application/json', body: JSON.stringify(value),
})
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).join(',') === names.join(',')
}
function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value
}
function manifest(value: unknown): value is Manifest {
  return record(value) && fields(value, ['mediaType', 'name', 'size', 'sha256'])
    && typeof value.mediaType === 'string' && MEDIA.includes(value.mediaType)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 240
    && !/[\\/\u0000-\u001f]/.test(value.name)
    && Number.isSafeInteger(value.size) && Number(value.size) > 0
    && Number(value.size) <= SESSION_IMAGE_MESSAGE_MAX_BYTES
    && typeof value.sha256 === 'string' && SHA.test(value.sha256)
}

/** One online, bounded upload. Drafts remain exclusively on the phone until start. */
export class SessionImageMessageService {
  private upload?: Upload
  private disposed = false
  private preparingInput?: Buffer
  private last?: { id: string; authorization?: string; generation?: string; response: PairingV1HttpResponse }

  constructor(private readonly authorizer: SessionListAuthorizer,
    private readonly source?: SessionMessageSource,
    private readonly prepareImage: SessionImagePreparer = prepareSessionImage) {}

  private release(upload: Upload): void {
    if (upload.timer !== undefined) clearTimeout(upload.timer)
    for (const bytes of upload.buffers) if (bytes !== this.preparingInput) bytes.fill(0)
    upload.buffers = []
    if (this.upload === upload) this.upload = undefined
  }

  private refresh(upload: Upload): void {
    if (upload.timer !== undefined) clearTimeout(upload.timer)
    upload.timer = setTimeout(() => this.release(upload), 120_000)
    upload.timer.unref()
  }

  dispose(): void {
    this.disposed = true
    if (this.upload !== undefined) this.release(this.upload)
    this.last = undefined
  }

  async handle(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    if (request.path.split(/[?#]/, 1)[0] !== SESSION_IMAGE_MESSAGE_PATH) return empty(404)
    if (request.method !== 'POST') return empty(405)
    if (request.path !== SESSION_IMAGE_MESSAGE_PATH || request.contentType !== 'application/json'
      || !(request.body instanceof Uint8Array)) return empty(400)
    if (request.body.byteLength > SESSION_IMAGE_MESSAGE_REQUEST_MAX_BYTES) return empty(413)
    if (this.disposed) return empty(503)
    if (this.upload !== undefined
      && !this.authorizer.authorize(this.upload.authorization, this.upload.generation)) {
      this.release(this.upload)
    }
    if (!this.authorizer.authorize(request.authorization, request.connectionGeneration)) return empty(401)
    if (this.source === undefined) return empty(503)
    let value: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body)
      value = JSON.parse(text)
      if (JSON.stringify(value) !== text) return empty(400)
    } catch { return empty(400) }
    if (!record(value) || value.protocolVersion !== 1) return empty(400)
    if (value.type === 'session_image_message_start') return this.start(value, request)
    if (value.type !== 'session_image_message_chunk' && value.type !== 'session_image_message_send'
      && value.type !== 'session_image_message_abort') return empty(400)
    const chunk = value.type === 'session_image_message_chunk'
    if (!fields(value, chunk
      ? ['type', 'protocolVersion', 'uploadId', 'imageIndex', 'offset', 'data']
      : ['type', 'protocolVersion', 'uploadId']) || !id(value.uploadId)) return empty(400)
    if (value.type === 'session_image_message_send' && this.last?.id === value.uploadId) {
      return this.last.authorization === request.authorization
        && this.last.generation === request.connectionGeneration ? this.last.response : empty(401)
    }
    const upload = this.upload
    // A missing receipt cannot prove that an earlier send was not accepted.
    if (upload === undefined || upload.id !== value.uploadId) return empty(410)
    if (upload.authorization !== request.authorization || upload.generation !== request.connectionGeneration) {
      return empty(401)
    }
    if (upload.submitting) return empty(503)
    if (value.type === 'session_image_message_abort') {
      this.release(upload)
      return json({ type: 'session_image_message_aborted', protocolVersion: 1, uploadId: upload.id })
    }
    if (this.preparingInput !== undefined) return empty(409)
    if (chunk) return this.chunk(upload, value)
    return this.send(upload)
  }

  private start(value: Record<string, unknown>, request: PairingV1HttpRequest): PairingV1HttpResponse {
    if (!fields(value, ['type', 'protocolVersion', 'sessionId', 'operationId', 'mode', 'text', 'images'])
      || typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 256
      || !id(value.operationId) || (value.mode !== 'queue' && value.mode !== 'steer')
      || typeof value.text !== 'string' || value.text.startsWith('/')
      || Array.from(value.text).length > MAX_SESSION_PROMPT_CHARS
      || !Array.isArray(value.images) || value.images.length < 1
      || value.images.length > SESSION_IMAGE_MESSAGE_MAX_IMAGES || !value.images.every(manifest)) return empty(400)
    if (value.images.reduce((sum: number, image: Manifest) => sum + image.size, 0)
      > SESSION_IMAGE_MESSAGE_MAX_BYTES) return empty(413)
    if (this.upload !== undefined || this.preparingInput !== undefined) return empty(409)
    const upload: Upload = {
      id: randomBytes(16).toString('base64url'), authorization: request.authorization,
      generation: request.connectionGeneration, operationId: value.operationId,
      sessionId: value.sessionId, mode: value.mode, text: value.text, images: value.images,
      buffers: value.images.map((image: Manifest) => Buffer.alloc(image.size)),
      imageIndex: 0, offset: 0, submitting: false,
    }
    this.upload = upload
    this.refresh(upload)
    return json({ type: 'session_image_message_started', protocolVersion: 1, uploadId: upload.id })
  }

  private async chunk(upload: Upload, value: Record<string, unknown>): Promise<PairingV1HttpResponse> {
    const descriptor = upload.images[upload.imageIndex]
    if (descriptor === undefined || value.imageIndex !== upload.imageIndex || value.offset !== upload.offset
      || typeof value.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.data)) return empty(400)
    const bytes = Buffer.from(value.data, 'base64url')
    if (bytes.toString('base64url') !== value.data
      || bytes.length !== Math.min(SESSION_IMAGE_MESSAGE_CHUNK_BYTES, descriptor.size - upload.offset)) {
      bytes.fill(0)
      return empty(400)
    }
    bytes.copy(upload.buffers[upload.imageIndex]!, upload.offset)
    bytes.fill(0)
    upload.offset += bytes.length
    const nextOffset = upload.offset
    const imageIndex = upload.imageIndex
    if (upload.offset === descriptor.size) {
      if (createHash('sha256').update(upload.buffers[imageIndex]!).digest('hex') !== descriptor.sha256) {
        this.release(upload)
        return empty(422)
      }
      const input = upload.buffers[imageIndex]!
      this.preparingInput = input
      let prepared: Awaited<ReturnType<SessionImagePreparer>> | undefined
      try {
        prepared = await this.prepareImage({ data: input, mediaType: descriptor.mediaType, name: descriptor.name })
        if (!this.authorizer.authorize(upload.authorization, upload.generation)) {
          this.release(upload)
          return empty(401)
        }
        if (this.disposed || this.upload !== upload) return empty(410)
        const total = upload.buffers.reduce((sum, buffer) => sum + buffer.length, 0)
          - input.length + prepared.data.length
        if (prepared.data.length < 1 || prepared.data.length > SESSION_IMAGE_MAX_BYTES
          || total > SESSION_IMAGE_MESSAGE_MAX_BYTES || !MEDIA.includes(prepared.mediaType)) {
          this.release(upload)
          return empty(422)
        }
        upload.buffers[imageIndex] = prepared.data
        descriptor.mediaType = prepared.mediaType
        prepared = undefined
      } catch {
        this.release(upload)
        return empty(422) // No prompt was attempted; the phone can retain and retry its draft.
      } finally {
        input.fill(0)
        prepared?.data.fill(0)
        this.preparingInput = undefined
      }
      upload.imageIndex += 1
      upload.offset = 0
    }
    this.refresh(upload)
    return json({ type: 'session_image_message_chunked', protocolVersion: 1, imageIndex, nextOffset })
  }

  private async send(upload: Upload): Promise<PairingV1HttpResponse> {
    if (upload.imageIndex !== upload.images.length) return empty(409)
    if (!this.authorizer.authorize(upload.authorization, upload.generation)) {
      this.release(upload)
      return empty(401)
    }
    upload.submitting = true
    if (upload.timer !== undefined) clearTimeout(upload.timer)
    let response = empty(503)
    try {
      const content = upload.images.map((image, index) => ({
        type: 'image' as const, mediaType: image.mediaType,
        data: upload.buffers[index]!.toString('base64'), name: image.name,
      }))
      for (const bytes of upload.buffers) bytes.fill(0)
      upload.buffers = []
      const result = responseKind(await this.source!.prompt({
        rpcId: upload.operationId,
        payload: { sessionId: upload.sessionId, mode: upload.mode,
          content: [...content, ...(upload.text === '' ? [] : [{ type: 'text' as const, text: upload.text }])],
        },
      }), upload.operationId)
      if (result === 'rejected') response = empty(409)
      if (result === 'accepted') response = json({
        type: 'session_message_accepted', protocolVersion: 3, accepted: true, operationId: upload.operationId,
      })
    } catch { /* Unknown means read history; never invoke prompt again for this receipt. */ }
    finally {
      if (!this.disposed) this.last = { id: upload.id, authorization: upload.authorization,
        generation: upload.generation, response }
      this.release(upload)
    }
    return response
  }
}
