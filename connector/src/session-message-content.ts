import { createHash } from 'node:crypto'

export const QUEUE_CONTENT_MAX_BYTES = 32 * 1024 * 1024
export const QUEUE_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export interface QueueContentImage { mediaType: string; name: string; bytes: number; sha256: string; data: string }
export interface QueueMessageContent { contract: 'dshos-queue-message-content-v1'; text: string; images: QueueContentImage[] }
export interface QueueContentReference { id: string; bytes: number; sha256: string }
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k))
export const queueContentId = (v: unknown, size = 16): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)
  && Buffer.from(v,'base64url').length === size && Buffer.from(v,'base64url').toString('base64url') === v
export const queueContentHash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
export function readQueueContentReference(value: unknown): QueueContentReference {
  if (!fields(value,['id','bytes','sha256']) || !queueContentId(value.id) || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) < 1 || (value.bytes as number) > QUEUE_CONTENT_MAX_BYTES
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw Error('queue_content_reference')
  return { id:value.id,bytes:value.bytes as number,sha256:value.sha256 }
}
export function readQueueMessageContent(bytes: Buffer): QueueMessageContent {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > QUEUE_CONTENT_MAX_BYTES) throw Error('queue_content_limit')
  const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes), v: unknown = JSON.parse(text)
  if (!fields(v,['contract','text','images']) || JSON.stringify(v) !== text || v.contract !== 'dshos-queue-message-content-v1'
    || typeof v.text !== 'string' || [...v.text].length > 4000 || v.text.includes('\0') || Buffer.from(v.text).toString() !== v.text
    || !Array.isArray(v.images) || v.images.length > 20 || !v.text.trim() && v.images.length === 0) throw Error('queue_content_format')
  let total = 0
  for (const image of v.images) {
    if (!fields(image,['mediaType','name','bytes','sha256','data']) || !['image/png','image/jpeg','image/webp','image/gif'].includes(image.mediaType as string)
      || typeof image.name !== 'string' || !image.name || Buffer.byteLength(image.name) > 240 || /[\/\\\u0000-\u001f\u007f]/.test(image.name)
      || Buffer.from(image.name).toString() !== image.name || !Number.isSafeInteger(image.bytes) || (image.bytes as number) < 1
      || (image.bytes as number) > QUEUE_IMAGE_MAX_BYTES || typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)
      || typeof image.data !== 'string' || image.data.length > Math.ceil((image.bytes as number)*4/3) || !/^[A-Za-z0-9_-]+$/.test(image.data)) throw Error('queue_content_image')
    total += image.bytes as number
    if (total > QUEUE_IMAGE_MAX_BYTES) throw Error('queue_content_limit')
    const data = Buffer.from(image.data,'base64url')
    try {
      if (data.length !== image.bytes || data.toString('base64url') !== image.data || queueContentHash(data) !== image.sha256) throw Error('queue_content_image_digest')
    } finally { data.fill(0) }
  }
  return v as unknown as QueueMessageContent
}


export interface QueueBoundContent { content: QueueContentReference }
export function queueBoundContent(reference: QueueContentReference): string {
  return JSON.stringify({content:readQueueContentReference(reference)})
}
export function readQueueBoundContent(body: string): QueueContentReference | null {
  if(typeof body!=='string'||Buffer.byteLength(body)>32768)throw Error('queue_content_body')
  const value: unknown=JSON.parse(body)
  if(!fields(value,['content'])) {
    if(fields(value,['text'])&&typeof value.text==='string')return null
    throw Error('queue_content_body')
  }
  if(JSON.stringify(value)!==body)throw Error('queue_content_body')
  return readQueueContentReference(value.content)
}
