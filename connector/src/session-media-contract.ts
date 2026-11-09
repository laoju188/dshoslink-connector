import { createHash } from 'node:crypto'
import { extname, isAbsolute } from 'node:path'
import { record, type AudioSourceReference } from './session-audio-contract.js'

export const GIF_MAX_BYTES = 4 * 1024 * 1024
export const VIDEO_CHUNK_BYTES = 512 * 1024
export const SESSION_VIDEO_PATH = '/dshos/v1/session-video'

export interface SessionMediaKey {
  readonly sessionId: string
  readonly seq: number
  readonly blockIndex: number
  readonly id: string
}

function mediaType(name: string): 'image/gif' | 'video/mp4' | undefined {
  if (name.length < 1 || name.length > 256 || /[\\/:\x00-\x1f\x7f]/.test(name)) return undefined
  const extension = extname(name).toLowerCase()
  return extension === '.gif' ? 'image/gif' : extension === '.mp4' ? 'video/mp4' : undefined
}

/** Only a file explicitly surfaced by DSH in a persisted assistant response. */
export function eventSessionMedia(event: Record<string, unknown>): AudioSourceReference[] {
  const data = event.data
  if (!record(data) || !Number.isSafeInteger(event.seq)) return []
  if (event.type === 'deliverables/presented' && Array.isArray(data.files)) {
    return data.files.flatMap((entry: unknown, blockIndex): AudioSourceReference[] => {
      if (!record(entry) || typeof entry.path !== 'string' || !isAbsolute(entry.path) ||
        /[\x00-\x1f\x7f]/.test(entry.path)) return []
      const name = entry.path.split(/[\\/]/).at(-1)!
      const type = mediaType(name)
      if (!type) return []
      const id = createHash('sha256').update(JSON.stringify([event.seq, blockIndex, entry.path])).digest('hex')
      return [{ file: entry.path, ref: { id, name, mediaType: type, bytes: null, blockIndex } }]
    })
  }
  if (!['assistant/message', 'tool/result'].includes(String(event.type)) || !record(data.message) ||
    !Array.isArray(data.message.content)) return []
  return data.message.content.flatMap((block: unknown, blockIndex): AudioSourceReference[] => {
    if (!record(block) || block.type !== 'file' || !record(block.attachment)) return []
    const { attachmentId, name, bytes } = block.attachment
    if (typeof name !== 'string' || typeof attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(attachmentId) ||
      typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) return []
    const type = mediaType(name)
    if (!type) return []
    return [{ attachment: { attachmentId, name, bytes },
      ref: { id: attachmentId.slice(7), name, mediaType: type, bytes, blockIndex } }]
  })
}

export function gifSignature(data: Buffer): boolean {
  if (data.length < 14 || !['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return false
  const width = data.readUInt16LE(6), height = data.readUInt16LE(8)
  return width > 0 && height > 0 && width <= 2048 && height <= 2048
}
