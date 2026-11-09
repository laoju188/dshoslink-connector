import { randomBytes } from 'node:crypto'
import { findAudio, record, type AudioSourceReference } from './session-audio-contract.js'
import { eventSessionMedia, SESSION_VIDEO_PATH, VIDEO_CHUNK_BYTES, type SessionMediaKey } from './session-media-contract.js'
import type { PairingV1HttpRequest } from './pairing-backend.js'
import type { PairingHttpsResponse } from './pairing-https-server.js'
import type { SessionListAuthorizer } from './session-list.js'

export interface VideoFile {
  readonly bytes: number
  readonly revision: string
  read(offset: number, length: number, check: () => void): Promise<Buffer>
  close(): Promise<void>
}
export interface SessionVideoSource {
  readSession?(id: string): Promise<unknown>
  openVideo?(ref: AudioSourceReference, check: () => void): Promise<VideoFile>
}

interface Preview {
  readonly token: string
  readonly owner: string
  readonly key: SessionMediaKey
  readonly reference: string
  readonly file: VideoFile
}

const idleMs = 60000
const empty = (status: number): PairingHttpsResponse => ({ status, body: '' })
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** Only the LAN HTTPS listener constructs this service. The relay has no video route. */
export class SessionVideoService {
  private preview?: Preview
  private timer?: NodeJS.Timeout
  private busy = false
  private disposed = false

  constructor(private readonly auth: SessionListAuthorizer, private readonly source?: SessionVideoSource) {}

  private async clear(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    const previous = this.preview
    this.preview = undefined
    await previous?.file.close()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.clear()
  }

  private renew(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.clear().catch(() => undefined), idleMs)
    this.timer.unref()
  }

  async handle(request: PairingV1HttpRequest): Promise<PairingHttpsResponse> {
    if (request.path !== SESSION_VIDEO_PATH || request.contentType !== 'application/json') return empty(400)
    if (request.method !== 'POST') return empty(405)
    if (request.body.byteLength > 4096) return empty(413)
    const valid = () => !this.disposed && !request.signal?.aborted &&
      this.auth.authorize(request.authorization, request.connectionGeneration)
    if (!valid()) return empty(401)
    if (!this.source?.readSession || !this.source?.openVideo) return empty(503)
    if (this.busy) return empty(409)
    this.busy = true
    const owner = JSON.stringify([request.authorization, request.connectionGeneration])
    const check = () => { if (!valid()) throw Error('video_auth') }
    try {
      let value: unknown
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body)
        value = JSON.parse(text)
        if (!record(value) || JSON.stringify(value) !== text) return empty(400)
      } catch { return empty(400) }
      if (value.type === 'open') {
        const { sessionId, seq, blockIndex, id } = value
        if (Object.keys(value).join(',') !== 'type,sessionId,seq,blockIndex,id' ||
          typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256 ||
          !nonnegative(seq) || !nonnegative(blockIndex) || !hex(id)) return empty(400)
        const key = { sessionId, seq, blockIndex, id }
        const ref = findAudio(await this.source.readSession(sessionId), key, eventSessionMedia)
        check()
        if (!ref || ref.ref.mediaType !== 'video/mp4') return empty(404)
        await this.clear()
        check()
        let file: VideoFile | undefined = await this.source.openVideo(ref, check)
        try {
          check()
          if (!Number.isSafeInteger(file.bytes) || file.bytes < 16 || !hex(file.revision) ||
            ref.ref.bytes !== null && file.bytes !== ref.ref.bytes)
            return empty(422)
          const header = await file.read(0, 16, check)
          try { if (header.length !== 16 || header.toString('ascii', 4, 8) !== 'ftyp') return empty(415) }
          finally { header.fill(0) }
          const current = findAudio(await this.source.readSession(sessionId), key, eventSessionMedia)
          check()
          const reference = JSON.stringify(ref)
          if (!current || JSON.stringify(current) !== reference) return empty(409)
          const token = randomBytes(32).toString('hex')
          this.preview = { token, owner, key, file, reference }
          file = undefined
          this.renew()
          return { status: 200, contentType: 'application/json',
            body: JSON.stringify({ token, bytes: this.preview.file.bytes, revision: this.preview.file.revision }) }
        } finally { await file?.close() }
      }
      const { token } = value
      if (!hex(token)) return empty(400)
      const preview = this.preview
      if (!preview || preview.token !== token || preview.owner !== owner) return empty(404)
      if (value.type === 'close' && Object.keys(value).join(',') === 'type,token') {
        await this.clear()
        return empty(204)
      }
      const { offset, length } = value
      if (value.type !== 'read' || Object.keys(value).join(',') !== 'type,token,offset,length' ||
        !nonnegative(offset) || !nonnegative(length) || length < 1 || length > VIDEO_CHUNK_BYTES ||
        offset >= preview.file.bytes || length > preview.file.bytes - offset) return empty(416)
      const current = findAudio(await this.source.readSession(preview.key.sessionId), preview.key, eventSessionMedia)
      check()
      if (this.preview !== preview || !current || JSON.stringify(current) !== preview.reference) {
        if (this.preview === preview) await this.clear()
        return empty(409)
      }
      const data = await preview.file.read(offset, length, check)
      if (!valid() || this.preview !== preview || data.length !== length) {
        data.fill(0)
        return empty(valid() ? 409 : 401)
      }
      this.renew()
      return { status: 200, contentType: 'application/octet-stream', body: data }
    } catch {
      if (this.preview?.owner === owner) await this.clear().catch(() => undefined)
      return empty(valid() ? 503 : 401)
    } finally { this.busy = false }
  }
}
