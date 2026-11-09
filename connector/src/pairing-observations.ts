import {validLinkObservation, type LinkObservationPacket} from './link-observation-contract.js'
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { registrationFields, registrationId, registrationSign, registrationTranscript } from './dsh-registration-contract.js'
import { validSupportObservation, type SupportObservationPacket, type SupportStage } from './pairing-support-contract.js'
import { validTraceObservation, type TraceObservationPacket } from './pairing-trace-contract.js'

export const OBSERVATION_CONTRACT = 'dshos-pairing-observation-v1'
export const OBSERVATION_DOMAIN = 'PAIRING-OBSERVATION'
const OUTCOMES = ['open', 'cancelled', 'replaced', 'expired', 'interrupted', 'connected'] as const
const ERRORS = ['none', 'pin_mismatch', 'unauthorized', 'invalid_request', 'expired', 'clock', 'identity_conflict', 'busy', 'unavailable', 'other'] as const
export type ObservationOutcome = typeof OUTCOMES[number]
export type ObservationError = typeof ERRORS[number]
export interface ObservationBody {
  contract: typeof OBSERVATION_CONTRACT
  attemptId: string; publicKey: string; sequence: number; seen: number
  outcome: ObservationOutcome; error: ObservationError; elapsedMs: number
  mode: 'initial' | 'resume'; pluginVersion: string; startedAtMs: number
}
export type ObservationPacket = { body: ObservationBody; signature: string } | SupportObservationPacket | TraceObservationPacket | LinkObservationPacket
export interface ObservationHandle {
  display?(sessionId: string, shown: boolean): void
  listener?(signals: number): void
  refreshOrigin?(): { operationId: string; parentAttemptId: string }
  phase(bit: 2 | 4 | 8 | 16 | 32): void
  failure(error: ObservationError, stage?: SupportStage): void
  requestReceived?(): void
  end(outcome: Exclude<ObservationOutcome, 'open' | 'connected'>): void
}
export interface ObservationIdentity { publicKey: string; privateKey: string; mode: 'initial' | 'resume'; startedAtMs: number }
export function observationError(error: unknown): ObservationError {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('expired')) return 'expired'
  if (message.includes('clock')) return 'clock'
  if (message.includes('scope') || message.includes('recovery') || message.includes('instance')) return 'identity_conflict'
  if (message.includes('unauthorized') || message.includes('signature')) return 'unauthorized'
  if (message.includes('format') || message.includes('confirmation')) return 'invalid_request'
  if (message.includes('busy')) return 'busy'
  if (message.includes('unavailable')) return 'unavailable'
  return 'other'
}

// The signer is retained only during the live window. Neither a key nor a QR/PIN
// enters the persisted packet. Repeated polling/authentication produces no event.
export function beginObservation(identity: ObservationIdentity, pluginVersion: string,
  enqueue: (packet: {body:ObservationBody;signature:string}) => void, mono = () => performance.now(), expiryMs = 300000): ObservationHandle {
  const start = mono()
  let sequence = 0, seen = 1, outcome: ObservationOutcome = 'open', error: ObservationError = 'none'
  const attemptId = randomBytes(16).toString('base64url')
  let errorReports = 0
  const emit = () => {
    if (sequence >= 32) return
    const body: ObservationBody = { contract: OBSERVATION_CONTRACT, attemptId, publicKey: identity.publicKey,
      sequence: ++sequence, seen, outcome, error, elapsedMs: Math.max(0, Math.min(600000, Math.floor(mono() - start))),
      mode: identity.mode, pluginVersion, startedAtMs: identity.startedAtMs }
    enqueue({ body, signature: registrationSign(OBSERVATION_DOMAIN, body, identity.privateKey, identity.publicKey) })
  }
  const safelyEmit = () => { try { emit() } catch { /* Diagnostics must never affect pairing. */ } }
  let timer: ReturnType<typeof setTimeout>
  const handle: ObservationHandle = {
    phase(bit) {
      if (outcome === 'connected' || (seen & bit) || outcome !== 'open' && bit !== 32) return
      // Accept only actual ordered protocol milestones (phone/computer confirms may race).
      if (bit !== 2 && !(seen & 2) || bit === 16 && (seen & 15) !== 15 || bit === 32 && seen !== 31) return
      seen |= bit
      if (bit === 32) { outcome = 'connected'; clearTimeout(timer) }
      safelyEmit()
    },
    failure(value) {
      if (outcome !== 'open' || value === error || value === 'none') return
      error = value
      // Keep the latest category even under noisy alternating failures. Bound
      // error-only reports and reserve space for every milestone/end/late AUTH.
      if (errorReports < 24) { errorReports++; safelyEmit() }
    },
    end(value) {
      if (outcome !== 'open') return
      outcome = value; clearTimeout(timer); safelyEmit()
    },
  }
  timer = setTimeout(() => handle.end('expired'), expiryMs); timer.unref()
  safelyEmit()
  return handle
}

// Validate restored files before any network send. Reject unexpected fields even
// if signed: a local file must never become a conduit for arbitrary data.
export function validObservationPacket(value: unknown, now: number): value is ObservationPacket {
  try {
    if (validLinkObservation(value, now)) return true
    if (validSupportObservation(value, now) || validTraceObservation(value, now)) return true
    if (!registrationFields(value, ['body', 'signature']) || !registrationFields(value.body,
      ['contract', 'attemptId', 'publicKey', 'sequence', 'seen', 'outcome', 'error', 'elapsedMs', 'mode', 'pluginVersion', 'startedAtMs'])) return false
    const b = value.body
    if (b.contract !== OBSERVATION_CONTRACT || !registrationId(b.attemptId) || !registrationId(b.publicKey, 32)
      || !registrationId(value.signature, 64) || !Number.isInteger(b.sequence) || (b.sequence as number) < 1 || (b.sequence as number) > 32
      || !Number.isInteger(b.seen) || (b.seen as number) < 1 || (b.seen as number) > 63 || !((b.seen as number) & 1)
      || !OUTCOMES.includes(b.outcome as ObservationOutcome) || !ERRORS.includes(b.error as ObservationError)
      || !Number.isInteger(b.elapsedMs) || (b.elapsedMs as number) < 0 || (b.elapsedMs as number) > 600000
      || !['initial', 'resume'].includes(b.mode as string) || typeof b.pluginVersion !== 'string'
      || b.pluginVersion.length > 32 || b.pluginVersion.trim() !== b.pluginVersion
      || !/^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-z0-9.]{1,16})?$/.test(b.pluginVersion)
      || !Number.isSafeInteger(b.startedAtMs) || Math.abs(now - (b.startedAtMs as number)) > 86400000) return false
    const seen = b.seen as number
    if ((seen & 12) && !(seen & 2) || (seen & 16) && (seen & 15) !== 15 || (seen & 32) && seen !== 63
      || b.outcome === 'connected' && seen !== 63 || seen === 63 && b.outcome !== 'connected') return false
    return verify(null, registrationTranscript(OBSERVATION_DOMAIN, b),
      createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: b.publicKey } }), Buffer.from(value.signature, 'base64url'))
  } catch { return false }
}

// A small single-writer, asynchronous outbox; use one unique file per desktop
// runtime directory, outside identity storage. Diagnostics fail open for pairing.
export class PairingObservationQueue {
  private packets = new Map<string, ObservationPacket>()
  private loaded = false
  private running?: Promise<void>
  private closing?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private retry = 1000
  private controller?: AbortController
  private revision = 0
  private persistedRevision = 0
  constructor(private readonly file: string, private readonly send: (packet: ObservationPacket, signal: AbortSignal) => Promise<number>,
    private readonly now = Date.now) {}
  enqueue = (packet: ObservationPacket): void => {
    if (this.stopped || !validObservationPacket(packet, this.now())) return
    this.merge(packet); this.schedule(50)
  }
  private merge(packet: ObservationPacket): void {
    const old = this.packets.get(packet.body.attemptId)
    if (!old || old.body.sequence < packet.body.sequence) { this.packets.set(packet.body.attemptId, packet); this.revision++ }
    while (this.packets.size > 64) this.packets.delete(this.packets.keys().next().value!)
  }
  private schedule(delay: number): void {
    if (this.stopped || this.timer || this.running) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, delay); this.timer.unref()
  }
  private async persist(): Promise<void> {
    if (this.revision === this.persistedRevision) return
    const revision = this.revision
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file + '.tmp', JSON.stringify([...this.packets.values()]), { mode: 0o600 })
      await rename(this.file + '.tmp', this.file)
      this.persistedRevision = revision
    } catch { /* Read-only/full disk must not block pairing or network reporting. */ }
  }
  async flush(): Promise<void> {
    if (this.running) return this.running
    if (this.stopped) return
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.running = this.pump().catch(() => {}).then(() => this.persist()).finally(() => {
      this.running = undefined
      if (this.packets.size) this.schedule(this.retry)
    })
    return this.running
  }
  private async pump(): Promise<void> {
    if (!this.loaded) {
      this.loaded = true
      try {
        const stored = await stat(this.file)
        this.revision++ // Sanitize expired/malformed persisted data, even if nothing survives.
        if (stored.size <= 64 * 8192 + 65) {
          const values: unknown = JSON.parse(await readFile(this.file, 'utf8'))
          if (Array.isArray(values) && values.length <= 64) {
            const recent = [...this.packets.values()]
            this.packets.clear()
            for (const value of values) if (validObservationPacket(value, this.now())) this.merge(value)
            // Newly generated attempts take precedence over a full persisted queue.
            recent.forEach(value => this.merge(value))
          }
        }
      } catch { /* Missing/corrupt diagnostic data has no authority over identity. */ }
    }
    for (const [id, packet] of this.packets) if (!validObservationPacket(packet, this.now())) { this.packets.delete(id); this.revision++ }
    await this.persist()
    // One bounded batch; updates arriving during a request remain queued.
    for (const packet of [...this.packets.values()]) {
      if (this.stopped) return
      const controller = new AbortController(); this.controller = controller
      const timeout = setTimeout(() => controller.abort(), 2500); timeout.unref()
      let status = 0
      try { status = await this.send(packet, controller.signal) } catch { /* Retry later. */ }
      finally { clearTimeout(timeout); this.controller = undefined }
      if (status === 202 || [400, 403, 409, 413].includes(status)) {
        if (this.packets.get(packet.body.attemptId) === packet) { this.packets.delete(packet.body.attemptId); this.revision++ }
        this.retry = 1000
        await this.persist()
      } else { this.retry = Math.min(this.retry * 2, 300000); break }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    // Preserve valid pending packets on normal exit. The host must await this
    // writer before it starts a replacement that can clear the same file.
    if (!this.running) this.running = (this.loaded ? this.persist() : this.pump()).catch(() => {})
    this.closing = this.running
    this.controller?.abort()
    return this.closing
  }
  async discard(): Promise<void> {
    // Stop and drain the writer before deleting either file. A late response
    // must not recreate an outbox after the user has withdrawn permission.
    await this.close()
    this.packets.clear()
    await rm(this.file, { force: true })
    await rm(this.file + '.tmp', { force: true })
  }
}

export function observationSender(baseUrl: string): (packet: ObservationPacket, signal: AbortSignal) => Promise<number> {
  if (!['https://dshoslink.cn', 'https://dshoslink.cn/sandbox'].includes(baseUrl)) throw Error('Invalid observation destination')
  return async (packet, signal) => {
    const response = await fetch(baseUrl + '/v2/pairing-observations', { method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(packet) })
    await response.body?.cancel()
    return response.status
  }
}
