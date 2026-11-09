export const SESSION_IMAGE_PATH = '/dshos/v1/session-image'
export const SESSION_IMAGE_REQUEST_MAX_BYTES = 4_096
export const SESSION_IMAGE_RESPONSE_MAX_BYTES = 192 * 1_024
export const SESSION_IMAGE_MAX_BYTES = 4 * 1_024 * 1_024
export const SESSION_IMAGE_CHUNK_BYTES = 128 * 1_024
export const SESSION_IMAGE_MAX_DIMENSION = 2_048
export const SESSION_IMAGE_MAX_PIXELS = 4_194_304
export const SESSION_MESSAGE_MAX_IMAGES = 20
export const SESSION_MESSAGE_MAX_BLOCKS = 100

export interface SessionImageReference {
  readonly type: 'image'
  readonly blockIndex: number
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
}

export interface SessionImageRequest {
  readonly type: 'session_image_request'
  readonly protocolVersion: 1
  readonly sessionId: string
  readonly seq: number
  readonly blockIndex: number
  readonly attachmentId: string
  readonly offset: number
}

export function imageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validImageId(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

export function imageReference(value: unknown, blockIndex: number): SessionImageReference | undefined {
  if (!imageRecord(value) || !validImageId(value.attachmentId)
    || (value.mediaType !== 'image/png' && value.mediaType !== 'image/jpeg'
      && value.mediaType !== 'image/webp' && value.mediaType !== 'image/gif')
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1
    || Number(value.bytes) > SESSION_IMAGE_MAX_BYTES
    || !Number.isSafeInteger(value.width) || Number(value.width) < 1
    || Number(value.width) > SESSION_IMAGE_MAX_DIMENSION
    || !Number.isSafeInteger(value.height) || Number(value.height) < 1
    || Number(value.height) > SESSION_IMAGE_MAX_DIMENSION
    || Number(value.width) * Number(value.height) > SESSION_IMAGE_MAX_PIXELS
    || !Number.isSafeInteger(blockIndex) || blockIndex < 0) return undefined
  return {
    type: 'image', blockIndex, attachmentId: value.attachmentId, mediaType: value.mediaType,
    bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height),
  }
}

export function parseSessionImageRequest(body: Uint8Array): SessionImageRequest | undefined {
  if (!(body instanceof Uint8Array) || body.byteLength < 1
    || body.byteLength > SESSION_IMAGE_REQUEST_MAX_BYTES) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    const value: unknown = JSON.parse(text)
    const fields = ['type', 'protocolVersion', 'sessionId', 'seq', 'blockIndex', 'attachmentId', 'offset']
    if (!imageRecord(value) || Object.keys(value).join(',') !== fields.join(',')
      || JSON.stringify(value) !== text || value.type !== 'session_image_request'
      || value.protocolVersion !== 1 || typeof value.sessionId !== 'string'
      || value.sessionId.length < 1 || value.sessionId.length > 256
      || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0
      || !Number.isSafeInteger(value.blockIndex) || Number(value.blockIndex) < 0
      || !validImageId(value.attachmentId)
      || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0
      || Number(value.offset) >= SESSION_IMAGE_MAX_BYTES
      || Number(value.offset) % SESSION_IMAGE_CHUNK_BYTES !== 0) return undefined
    return value as unknown as SessionImageRequest
  } catch {
    return undefined
  }
}

/** Only the exact durable, visible top-level block may authorize image reads. */
export function visibleSessionImage(surface: unknown, request: SessionImageRequest): SessionImageReference | undefined {
  if (!imageRecord(surface) || !imageRecord(surface.session)
    || surface.session.id !== request.sessionId || !Array.isArray(surface.events)
    || !Number.isSafeInteger(surface.capturedThroughSeq)
    || Number(surface.capturedThroughSeq) < request.seq) return undefined
  const seen = new Set<number>()
  let found: SessionImageReference | undefined
  for (const event of surface.events) {
    if (!imageRecord(event) || !Number.isSafeInteger(event.seq) || Number(event.seq) < 0
      || Number(event.seq) > Number(surface.capturedThroughSeq) || seen.has(Number(event.seq))) return undefined
    seen.add(Number(event.seq))
    if (event.seq !== request.seq) continue
    if (!imageRecord(event.data)) return undefined
    let content: unknown
    if (event.type === 'user/message' && imageRecord(event.data.source)
      && event.data.source.kind === 'user') content = event.data.content
    else if ((event.type === 'assistant/message' || event.type === 'tool/result') && imageRecord(event.data.message)) {
      content = event.data.message.content
    } else return undefined
    if (!Array.isArray(content) || request.blockIndex >= content.length) return undefined
    const block: unknown = content[request.blockIndex]
    if (!imageRecord(block) || block.type !== 'image') return undefined
    const ref = imageReference(block.attachment, request.blockIndex)
    if (ref?.attachmentId !== request.attachmentId) return undefined
    found = ref
  }
  return found
}
