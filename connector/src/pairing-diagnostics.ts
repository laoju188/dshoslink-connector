import type { LinkObservationPacket } from './link-observation-contract.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { CONNECTOR_VERSION } from './connector-metadata.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { beginObservation, observationSender, PairingObservationQueue,
  type ObservationHandle, type ObservationIdentity, type ObservationPacket } from './pairing-observations.js'
import { PairingSupportObservation } from './pairing-support-observation.js'

export const PAIRING_DIAGNOSTICS_NOTICE = '2026-10-05-v1'
export interface PairingDiagnosticsSnapshot {
  readonly enabled: boolean
  readonly available: boolean
  readonly forcedOff: boolean
  readonly pendingDisable: boolean
}
type Sender = (packet: ObservationPacket, signal: AbortSignal) => Promise<number>

/** One controller per host profile, shared across network/port runtime restarts. */
export class PairingDiagnostics {
  private enabled = false
  private disposed = false
  private pendingDisable = false
  private disposal?: Promise<void>
  private queue?: PairingObservationQueue
  private changes: Promise<unknown> = Promise.resolve()
  private latest?: PairingSupportObservation
  readonly ready: Promise<void>
  constructor(private readonly file: string | undefined, private readonly forcedOff = false,
    private readonly send: Sender = observationSender(SERVICE_ENDPOINTS.baseUrl)) {
    this.ready = this.initialize()
  }
  private get preference(): string { return this.file! + '.preference' }
  private async initialize(): Promise<void> {
    if (!this.file) return
    try {
      this.pendingDisable = existsSync(this.preference + '.tmp')
      if (!this.forcedOff && !this.pendingDisable) {
        try {
          if (statSync(this.preference).size <= 1024) {
            const value = JSON.parse(readFileSync(this.preference, 'utf8'))
            // A previous off choice survives notice/version updates.
            this.enabled = value?.notice === PAIRING_DIAGNOSTICS_NOTICE && value?.enabled === true
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            // Product default is on only for a genuinely absent preference.
            // Persist it first; corruption/failed writes stay conservatively off.
            this.save(true)
            this.enabled = true
          } else this.pendingDisable = true
        }
      }
    } catch { this.pendingDisable = true /* Failed saves must not look durably off. */ }
    if (this.enabled) this.startQueue()
    else {
      try { await new PairingObservationQueue(this.file, this.send).discard() }
      catch { this.pendingDisable = true }
    }
  }
  snapshot(): PairingDiagnosticsSnapshot {
    return { enabled: this.enabled && !this.disposed, available: !!this.file && !this.disposed,
      forcedOff: this.forcedOff, pendingDisable: this.pendingDisable }
  }
  private save(enabled: boolean): void {
    mkdirSync(dirname(this.preference), { recursive: true })
    writeFileSync(this.preference + '.tmp', JSON.stringify({ notice: PAIRING_DIAGNOSTICS_NOTICE, enabled }), { mode: 0o600 })
    renameSync(this.preference + '.tmp', this.preference)
  }
  private startQueue(): void {
    this.queue = new PairingObservationQueue(this.file!, this.send)
    void this.queue.flush()
  }
  setEnabled(enabled: boolean): Promise<PairingDiagnosticsSnapshot> {
    if (typeof enabled !== 'boolean') return Promise.reject(Error('diagnostics_invalid_choice'))
    if (this.disposed) return Promise.reject(Error('diagnostics_unavailable'))
    const change = this.changes.then(async () => {
      await this.ready
      if (!this.file || this.disposed || enabled && this.forcedOff) throw Error('diagnostics_unavailable')
      if (enabled && this.pendingDisable) throw Error('diagnostics_choice_not_saved')
      if (enabled && this.enabled) return this.snapshot()
      if (enabled) {
        // Never upload a legacy/withdrawn queue when the user opts in again.
        await new PairingObservationQueue(this.file, this.send).discard()
        if (this.disposed) throw Error('diagnostics_unavailable')
        this.save(true)
        this.enabled = true
        this.startQueue()
      } else {
        this.enabled = false
        this.pendingDisable = true
        const queue = this.queue
        this.queue = undefined
        void queue?.close()
        let saveFailed = false
        try { this.save(false) }
        catch {
          // Do not delete the old preference: absence means the install default.
          // An interrupted temporary write also keeps the next startup off.
          saveFailed = true
        }
        await (queue ?? new PairingObservationQueue(this.file, this.send)).discard()
        if (saveFailed) throw Error('diagnostics_choice_not_saved')
        this.pendingDisable = false
      }
      return this.snapshot()
    })
    this.changes = change.catch(() => {})
    return change
  }
  observe = (identity: ObservationIdentity): ObservationHandle | undefined => {
    const queue = this.queue
    if (!this.enabled || this.disposed || !queue) return undefined
    return beginObservation(identity, CONNECTOR_VERSION, packet => {
      // A grant is bound to this queue lifetime. Old AUTH/timer callbacks must
      // stay revoked even if the setting is enabled again during the same QR.
      if (this.enabled && !this.disposed && this.queue === queue) queue.enqueue(packet)
    })
  }
  prepare = (origin?: { operationId: string; parentAttemptId: string }): PairingSupportObservation => {
    const queue = this.queue
    const permitted = this.enabled && !this.disposed && !!queue
    const attempt = new PairingSupportObservation(CONNECTOR_VERSION, packet => {
      // A later opt-in must not resurrect an attempt begun with collection off.
      if (permitted && this.enabled && !this.disposed && this.queue === queue) queue!.enqueue(packet)
    }, Date.now(), undefined, origin)
    this.latest = attempt
    return attempt
  }
  // The grant belongs to this setting/queue lifetime. A later opt-in cannot revive old callbacks.
  linkObserver(): ((packet:LinkObservationPacket)=>void) | undefined {
    const queue=this.queue
    if(!this.enabled||this.disposed||!queue)return undefined
    return packet=>{if(this.enabled&&!this.disposed&&this.queue===queue)queue.enqueue(packet)}
  }
  currentSupport(): PairingSupportObservation | undefined { return this.latest }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    const writer = this.queue?.close()
    this.queue = undefined
    // Stop new callbacks synchronously, but do not release this profile to its
    // replacement until initialization, settings changes and the writer drain.
    this.disposal = Promise.all([this.ready, this.changes, writer]).then(() => {})
    return this.disposal
  }
}

export function createPairingDiagnostics(rootDirectory: string, env: NodeJS.ProcessEnv): PairingDiagnostics {
  const local = env.LOCALAPPDATA
  const instance = createHash('sha256').update(rootDirectory.toLowerCase()).digest('hex').slice(0, 24)
  const file = process.platform === 'win32' && local && /^[a-z]:[\\/]/i.test(local)
    ? join(local, 'DSHOSLink', 'diagnostics', SERVICE_ENDPOINTS.registrationStateDirectoryName, instance + '.json') : undefined
  return new PairingDiagnostics(file, env.DSHOS_LINK_PAIRING_DIAGNOSTICS === 'off')
}

// Host settings only. No new phone/relay method and no pairing authority.
export class PairingDiagnosticsRemote extends Service {
  readonly typertRemote: { service: PairingDiagnosticsRemote; serviceKey: 'dshosPairingDiagnostics'; namespace: 'dshosPairingDiagnostics' }
  constructor(ctx: Context, private readonly diagnostics: PairingDiagnostics) {
    super(ctx, 'dshosPairingDiagnostics')
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'dshosPairingDiagnostics', namespace: 'dshosPairingDiagnostics' })
  }
  async snapshot(): Promise<PairingDiagnosticsSnapshot> {
    await this.diagnostics.ready
    return this.diagnostics.snapshot()
  }
  async setEnabled(enabled: boolean): Promise<PairingDiagnosticsSnapshot> {
    try { return await this.diagnostics.setEnabled(enabled) }
    catch { throw Error('diagnostics_setting_unavailable') }
  }
}
