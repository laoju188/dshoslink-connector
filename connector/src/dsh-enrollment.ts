import {createHash, createPublicKey, randomBytes, verify} from 'node:crypto'
import {dirname, join} from 'node:path'
import {lstatSync, readdirSync} from 'node:fs'
import {performance} from 'node:perf_hooks'
import {enrollmentHash, enrollmentInvitation} from './dsh-enrollment-local.js'
import {registrationDigest as digest, registrationFields as fields, registrationId as id, registrationPrivateKey, registrationTranscript as transcript, validComputerRegistry, validDshPairingBody, type ComputerRegistry, type JsonRecord, type RegistrationTrust} from './dsh-registration-contract.js'
import {RegistrationFile, registrationLock, registrationProtector, type RegistrationGuard, type RegistrationLease, type RegistrationProtector} from './dsh-registration-storage.js'
import {PairingTrustStore} from './pairing-trust-store.js'
import {DshLocalRetirement} from './dsh-local-retirement.js'
import {queryLocalStatus} from './local-status-service.js'
import {queryLegacyRetirement} from './legacy-retirement-service.js'
import {DshLegacyRetirement} from './dsh-legacy-retirement.js'
import {type ObservationHandle, type ObservationIdentity} from './pairing-observations.js'

import {PairingSupportObservation} from './pairing-support-observation.js'

import {withRegistrationOperation} from './registration-operation.js'

// An empty directory can remain after a failed pre-material attempt. Anything else
// (including unknown files, reparse points and unreadable state) requires recovery.
export function hasDshEnrollmentState(directory: string): boolean {
  try {
    const stat = lstatSync(directory)
    return !stat.isDirectory() || stat.isSymbolicLink() || readdirSync(directory).length !== 0
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
const fresh = (n = 16) => randomBytes(n).toString('base64url')
export interface DshEnrollmentMaterial {
  contract: string; computerId: string; registrationPrivateKey: string; registrationPublicKey: string
  memberId: string; memberPrivateKey: string; memberPublicKey: string; pairingId: string; mobilePublicKey: string | null
  pin: string; accountBindingId: string | null; registrationGeneration: string | null
}
type Material = DshEnrollmentMaterial
interface Source { contract: string; offer: string }
interface Intent extends Source { proof: JsonRecord }
function materialValid(v: unknown): v is Material {
  try {
    if (!fields(v, ['contract', 'computerId', 'registrationPrivateKey', 'registrationPublicKey', 'memberId', 'memberPrivateKey',
      'memberPublicKey', 'pairingId', 'mobilePublicKey', 'pin', 'accountBindingId', 'registrationGeneration'])
      || v.contract !== 'dshos-dsh-enrollment-material-v2' || !['computerId', 'memberId', 'pairingId'].every(k => id(v[k]))
      || !id(v.pin, 32) || !(v.mobilePublicKey === null || id(v.mobilePublicKey, 32))
      || new Set([v.registrationPublicKey, v.memberPublicKey, v.mobilePublicKey]).size !== 3
      || !(v.accountBindingId === null && v.registrationGeneration === null || id(v.accountBindingId) && id(v.registrationGeneration))) return false
    registrationPrivateKey(v.registrationPrivateKey, v.registrationPublicKey); registrationPrivateKey(v.memberPrivateKey, v.memberPublicKey)
    return true
  } catch { return false }
}
export { materialValid as validDshEnrollmentMaterial }
function sourceValid(v: unknown): v is Source {
  try { return fields(v, ['contract', 'offer']) && v.contract === 'dshos-dsh-enrollment-source-v2'
    && typeof v.offer === 'string' && !!enrollmentInvitation(v.offer) } catch { return false }
}
function signature(domain: string, body: unknown, pub: unknown, value: unknown): boolean {
  return id(pub, 32) && id(value, 64) && verify(null, transcript(domain, body),
    createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: pub } }), Buffer.from(value, 'base64url'))
}
function intentValid(v: unknown, pairing: boolean): v is Intent {
  try {
    if (!fields(v, ['contract', 'offer', 'proof']) || v.contract !== `dshos-dsh-enrollment-${pairing ? 'pairing-' : ''}intent-v2`
      || typeof v.offer !== 'string') return false
    const q = enrollmentInvitation(v.offer), i = q.identity as JsonRecord, p = v.proof
    if (!fields(p, pairing ? ['contract', 'body', 'memberSignature', 'mobileSignature']
      : ['contract', 'body', 'registrationSignature', 'memberSignature', 'authoritySignature', 'legacyProof'])) return false
    const b = p.body as JsonRecord
    if (!b || b.invitationDigest !== enrollmentHash(v.offer) || b.computerId !== i.computerId || b.memberId !== i.memberId
      || b.platform !== 'dsh' || !id(b.accountBindingId)) return false
    if (pairing) return p.contract === 'dshos-member-pairing-complete-v2' && validDshPairingBody(b)
      && b.newPairingId === i.pairingId && b.dshBindingHash === bindingHash(i.pairingId as string)
      && signature('MEMBER-PAIRING/MEMBER', b, i.memberPublicKey, p.memberSignature)
      && signature('MEMBER-PAIRING/MOBILE', b, b.newMobilePublicKey, p.mobileSignature)
    return p.contract === 'dshos-registration-complete-v2' && ['create', 'add'].includes(b.purpose as string)
      && b.registrationPublicKey === i.registrationPublicKey && b.memberPublicKey === i.memberPublicKey && id(b.mobilePublicKey, 32)
      && p.legacyProof === null && p.authoritySignature === (b.purpose === 'add' ? p.registrationSignature : null)
      && signature(`REGISTRATION/${(b.purpose as string).toUpperCase()}`, b, i.registrationPublicKey, p.registrationSignature)
      && signature(`REGISTRATION/${(b.purpose as string).toUpperCase()}`, b, i.memberPublicKey, p.memberSignature)
      && Number.isSafeInteger(b.issuedAt) && (b.issuedAt as number) >= 0 && Number.isSafeInteger(b.expiresAt)
      && (b.expiresAt as number) - (b.issuedAt as number) === 60000
  } catch { return false }
}
const bindingHash = (pairingId: string) => createHash('sha256').update(Buffer.from(pairingId, 'base64url')).digest('hex')
export interface DshEnrollmentOptions {
  preparePairing?: (origin?: {operationId:string;parentAttemptId:string}) => PairingSupportObservation
  addressState?: () => 'current' | 'changed' | 'unknown'
  observePairing?: (identity: ObservationIdentity) => ObservationHandle | undefined
  directory: string; registryDirectory: string; host: string; port: number; bootstrapPort: number; pin: string
  trustStore: PairingTrustStore
  /** Checks original TLS/runtime and V1 exclusion; never opens or replaces a V1 invitation. */
  assertAvailable(): void
  /** New invitation admission is independent from accepted retirement recovery. */
  assertNewInvitationAllowed?(): void
  legacyManagementAllowed?(): boolean
  loadTrust(signal: AbortSignal): Promise<RegistrationTrust>
  invalidateRetired?(): void
  queryLocalStatus?: typeof queryLocalStatus
  queryLegacyRetirement?: typeof queryLegacyRetirement
  now?: () => number; monotonic?: () => number
  protector?: (purpose: 'COMPUTER-REGISTRY/V1' | 'DSH-REGISTRATION/V2' | 'DSH-REGISTRATION-INTENT/V2') => RegistrationProtector
  lock?: (directory: string) => Promise<RegistrationLease>; prepareDirectory?: (directory: string) => Promise<void>
}
export class DshEnrollment {
  readonly material: RegistrationFile<Material>
  readonly source: RegistrationFile<Source>
  readonly intent: RegistrationFile<Intent>
  readonly pairingIntent: RegistrationFile<Intent>
  readonly registry: RegistrationFile<ComputerRegistry>
  readonly activation: RegistrationFile<JsonRecord>
  private readonly retirement?: DshLocalRetirement
  private readonly legacyRetirement?: DshLegacyRetirement
  private trust: RegistrationTrust | null = null
  private busy = false
  private addressReserved = false
  private revision = 0
  private high = -1
  private monoHigh = -1
  private controller: AbortController | null = null
  private retirementCheck: Promise<boolean> | null = null
  private readonly now: () => number
  private readonly wall: () => number
  private clockOffset = 0
  private clockUncertainty = 0
  private readonly mono: () => number
  constructor(private readonly options: DshEnrollmentOptions) {
    this.wall = options.now ?? Date.now; this.now = () => this.wall() + this.clockOffset
    this.mono = options.monotonic ?? (() => performance.now())
    const protect = options.protector ?? registrationProtector
    this.material = new RegistrationFile(join(options.directory, 'material-v2.json'), protect('DSH-REGISTRATION/V2'), materialValid, 'material')
    this.source = new RegistrationFile(join(options.directory, 'source-v2.json'), protect('DSH-REGISTRATION-INTENT/V2'), sourceValid, 'source')
    this.intent = new RegistrationFile(join(options.directory, 'intent-v2.json'), protect('DSH-REGISTRATION-INTENT/V2'), v => intentValid(v, false), 'intent')
    this.pairingIntent = new RegistrationFile(join(options.directory, 'pairing-intent-v2.json'), protect('DSH-REGISTRATION-INTENT/V2'), v => intentValid(v, true), 'pairing_intent')
    this.registry = new RegistrationFile(join(options.registryDirectory, 'computer-registry-v2.json'), protect('COMPUTER-REGISTRY/V1'), validComputerRegistry, 'registry')
    this.activation = new RegistrationFile(join(options.directory, 'activation-v2.json'), protect('DSH-REGISTRATION-INTENT/V2'),
      (v): v is JsonRecord => fields(v, ['contract', 'keyId', 'body', 'nonce', 'computer', 'members', 'issuedAt', 'expiresAt', 'signature'])
        && v.contract === 'dshos-dsh-pairing-current-result-v2' && validDshPairingBody(v.body) && id(v.nonce, 32) && id(v.signature, 64), 'activation')
    if (options.invalidateRetired) this.retirement = new DshLocalRetirement({
      directory: join(dirname(options.directory), 'retirement-v2'), source: options.directory, registry: this.registry,
      trustStore: options.trustStore, invalidate: () => {
        // Revocation is synchronous. Retire the visible window in the same turn,
        // so status polling cannot call close() and abort the accepted journal.
        options.invalidateRetired!()
      }, now: this.now,
      protector: protect('DSH-REGISTRATION-INTENT/V2'), prepare: options.prepareDirectory,
    })
    if (options.invalidateRetired) this.legacyRetirement = new DshLegacyRetirement({
      directory: join(dirname(options.directory), 'legacy-retirement-v1'), trustStore: options.trustStore,
      invalidate: options.invalidateRetired, now: this.now,
      protector: protect('DSH-REGISTRATION-INTENT/V2'), prepare: options.prepareDirectory,
    })
  }
  snapshot(): {payload:string;sessionId:string;expiresAt:number} | null { return null }
  close():void {this.revision++;this.controller?.abort();this.trust=null}
  get allowsLegacyInvitation(): boolean {
    return !this.blocksLegacyInvitation && !hasDshEnrollmentState(this.options.directory)
  }
  // Stable UI classification. A bounded background check must not remove the
  // legacy action or its confirmation; execution still uses the busy guard.
  get hasLegacyManagement(): boolean {
    return this.options.legacyManagementAllowed?.() !== false
      && !hasDshEnrollmentState(this.options.directory)
      && !hasDshEnrollmentState(join(dirname(this.options.directory), 'retirement-v2'))
      && !hasDshEnrollmentState(join(dirname(this.options.directory), 'legacy-retirement-v1'))
  }
  get blocksLegacyInvitation(): boolean {
    return this.busy
      || !!this.retirement && hasDshEnrollmentState(join(dirname(this.options.directory), 'retirement-v2'))
      || !!this.legacyRetirement && hasDshEnrollmentState(join(dirname(this.options.directory), 'legacy-retirement-v1'))
  }
  // Runtime startup invokes this before publishing AUTH listeners. A crash after accepted
  // intent but before revocation must never expose the old active trust on the next start.
  async resumeRetirement(): Promise<void> {
    if (!this.retirement) return
    await this.held(async guard => {
      await this.legacyRetirement?.resume(guard)
      await this.retirement!.resume(guard)
    }, () => {}, 'retirement')
  }
  private clock(checkAvailability = true): void {
    if (checkAvailability) this.options.assertAvailable()
    const now = this.wall(), mono = this.mono()
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 180000 || now < this.high
      || !Number.isFinite(mono) || mono < this.monoHigh) { throw Error('enrollment_clock') }
    this.high = now; this.monoHigh = mono
  }
  private async loadTrust(signal: AbortSignal, guard: RegistrationGuard): Promise<void> {
    if (this.trust !== null) return
    const trust = await this.options.loadTrust(signal); guard.assertHeld()
    if (trust.pairingClockOffsetMs !== undefined) {
      if (!Number.isSafeInteger(trust.pairingClockOffsetMs) || Math.abs(trust.pairingClockOffsetMs) > 120000)
        throw Error('enrollment_clock_settings')
      // Retained evidence is checked with bounded service time; no invitation is opened.
      this.clockOffset = trust.pairingClockOffsetMs; this.clockUncertainty = 6000
    }
    this.trust = trust
  }
  get addressChanged(): boolean { return this.options.addressState?.()==='changed' }
  async reserveAddressChange(): Promise<void> {
    if(!this.addressChanged)throw Error('enrollment_window_changed')
    await this.held(async guard=>{
      const m=await this.material.read(),intent=await this.intent.read(),pair=await this.pairingIntent.read(),active=await this.activation.read(),r=await this.registry.read()
      guard.assertHeld()
      if(m?.mobilePublicKey||intent||pair||active||this.options.trustStore.read()||r?.members.some(v=>v.platform==='dsh'))throw Error('enrollment_address_changed')
      // Reserve before yielding the lease: no new START can bind the retired QR.
    },()=>{},true)
    this.addressReserved=true
  }
  // One local DSH slot, then the shared computer guard. A timed-out continuation never retains write authority.
  private held<T>(action: (guard: RegistrationGuard, signal: AbortSignal) => Promise<T>, check = () => {}, opening: boolean | 'retirement' = false,
    onDeadline?: () => void, onFailure?: (error: unknown) => void): Promise<T> {
    if (this.busy) return Promise.reject(Error('enrollment_busy'))
    this.busy = true; const revision = this.revision, controller = new AbortController(); this.controller = controller
    const deadline = this.mono() + 8000, expires = this.wall() + 8000
    let lease: RegistrationLease | undefined
    let deadlineReported = false, failed = false, failure: unknown
    const rememberFailure = (error: unknown) => {
      if (failed) return
      failed = true; failure = error
      // Capture the first cause before asynchronous cleanup or a later close can replace it.
      try { onFailure?.(error) } catch { /* Diagnostics never affect the operation guard. */ }
    }
    const reportDeadline = () => {
      if (failed || deadlineReported || controller.signal.aborted || revision !== this.revision) return
      deadlineReported = true
      try { onDeadline?.() } catch { /* Diagnostics never affect the operation guard. */ }
      rememberFailure(Error('enrollment_cancelled'))
    }
    const guard = { assertHeld: () => {
      if (controller.signal.aborted || revision !== this.revision) throw Error('enrollment_cancelled')
      if (this.addressReserved) throw Error('enrollment_address_changed')
      if (this.mono() >= deadline || this.wall() >= expires) { reportDeadline(); throw Error('enrollment_cancelled') }
      // Accepted retirement must finish before publishing AUTH listeners, even
      // when retained cloud state prohibits opening another legacy invitation.
      // It retains the same clock, cancellation, deadline and lease checks.
      if (!opening) throw Error('pairing_upgrade_required')
      this.clock(opening !== 'retirement')
      check(); lease?.assertHeld()
    } }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { reportDeadline(); controller.abort() }, 8000)
      controller.signal.addEventListener('abort', () => {
        rememberFailure(Error('enrollment_cancelled')); reject(failure)
      }, { once: true })
      void withRegistrationOperation({guard, signal: controller.signal, now: this.mono,
        remaining: () => Math.max(0, Math.min(deadline - this.mono(), expires - this.wall())),
      }, async () => {
        let value: T | undefined
        try {
          guard.assertHeld(); lease = await (this.options.lock ?? registrationLock)(this.options.registryDirectory); guard.assertHeld()
          value = await action(guard, controller.signal); guard.assertHeld()
          await lease.release(); lease = undefined; guard.assertHeld()
        } catch (e) { rememberFailure(e) }
        finally {
          try { if (lease) await lease.release() } catch (e) { rememberFailure(e) }
          finally { this.busy = false; if (this.controller === controller) this.controller = null }
        }
        try { if (failed) throw failure; guard.assertHeld(); resolve(value as T) }
        catch (e) { rememberFailure(e); reject(failure) }
        finally { clearTimeout(timer) }
      })
    })
  }
  // Absence only retires a locally established identity. If service registration
  // may have completed before local synchronization, require its exact signed
  // removal receipt instead. An uncommitted attempt must keep its original keys.
  private match(m: Material, offer: string, proof?: JsonRecord, pairing = false): void {
    const q = enrollmentInvitation(offer), i = q.identity as JsonRecord
    if (q.pin !== m.pin || ['computerId', 'registrationPublicKey', 'memberId', 'memberPublicKey', 'pairingId'].some(k => i[k] !== m[k as keyof Material]))
      throw Error('enrollment_scope')
    if (proof) {
      const b = proof.body as JsonRecord
      if (b[pairing ? 'newMobilePublicKey' : 'mobilePublicKey'] !== m.mobilePublicKey
        || m.accountBindingId !== null && b.accountBindingId !== m.accountBindingId) throw Error('enrollment_scope')
    }
  }
  private async retireRemoved(guard: RegistrationGuard, signal: AbortSignal, allowOffline: boolean): Promise<boolean> {
    if (!this.retirement) return false
    const m = await this.material.read(), active = await this.activation.read(), registry = await this.registry.read()
    guard.assertHeld()
    const t = this.options.trustStore.read()
    if (!m && !active && t && this.legacyRetirement) {
      if (hasDshEnrollmentState(this.options.directory) || registry?.members.some(v => v.platform === 'dsh'))
        throw Error('enrollment_retirement_identity')
      if (t.status === 'revoked') {
        // Only the existing desktop confirmation action writes a local revoked
        // record. Never interpret an arbitrary missing server row as revocation.
        await this.legacyRetirement.begin(t, null, guard); return true
      }
      if (t.status !== 'active') return false
      let result: Awaited<ReturnType<typeof queryLegacyRetirement>>
      try {
        await this.loadTrust(signal, guard); guard.assertHeld()
        result = await (this.options.queryLegacyRetirement ?? queryLegacyRetirement)(t.pairingId, this.trust!, signal, this.now)
      } catch (error) {
        guard.assertHeld(); if (!allowOffline) throw error; return false
      }
      guard.assertHeld()
      if (!result.retired) return false
      await this.legacyRetirement.begin(t, result.proof, guard); return true
    }
    if (!m) return false
    let removalAccount: string | undefined
    if (active || t) {
      if (!active || t?.status !== 'active') throw Error('enrollment_retirement_identity')
      const body = active.body as JsonRecord
      if (t.pairingId !== m.pairingId || t.mobilePublicKeyRaw !== m.mobilePublicKey
        || body.computerId !== m.computerId || body.memberId !== m.memberId || body.newPairingId !== m.pairingId
        || body.newMobilePublicKey !== m.mobilePublicKey || body.accountBindingId !== m.accountBindingId)
        throw Error('enrollment_retirement_identity')
    } else {
      const intent = await this.intent.read(), pair = await this.pairingIntent.read(); guard.assertHeld()
      if (!intent) return false
      this.match(m, intent.offer, intent.proof)
      if (pair) this.match(m, pair.offer, pair.proof, true)
      if (!registry || registry.computerId !== m.computerId || registry.registrationPublicKey !== m.registrationPublicKey
        || !registry.members.some(member => member.platform === 'dsh'
          && member.memberId === m.memberId && member.publicKey === m.memberPublicKey))
        removalAccount = (intent.proof.body as JsonRecord).accountBindingId as string
      const latestExpiry = Math.max((intent.proof.body as JsonRecord).expiresAt as number,
        pair ? (pair.proof.body as JsonRecord).expiresAt as number : 0)
      await this.loadTrust(signal, guard); guard.assertHeld()
      if (!Number.isSafeInteger(latestExpiry) || this.now() - this.clockUncertainty < latestExpiry) return false
    }
    let result: Awaited<ReturnType<typeof queryLocalStatus>>
    try {
      await this.loadTrust(signal, guard); guard.assertHeld()
      result = await (this.options.queryLocalStatus ?? queryLocalStatus)({ ...m, platform: 'dsh' }, this.trust!, signal, this.now, removalAccount)
    } catch (error) {
      guard.assertHeld()
      if (!allowOffline) throw error
      return false
    }
    guard.assertHeld()
    if (!result.retired) return false
    const proof = result.proof
    if (removalAccount !== undefined && (proof.contract !== 'dshos-local-registration-status-result-v3'
      || (proof.request as JsonRecord).accountBindingId !== removalAccount || !proof.removal)) return false
    let after = registry
    if (proof.computer === null) {
      if (registry?.computerId === m.computerId) after = null
    } else {
      const parent = proof.computer as JsonRecord
      if (!registry || registry.computerId !== m.computerId || registry.accountBindingId !== m.accountBindingId
        || parent.accountBindingId !== m.accountBindingId) throw Error('enrollment_retirement_registry')
      const members = (proof.members as JsonRecord[]).map(member => {
        const saved = registry.members.find(v => v.platform === member.platform)
        if (!saved || saved.memberId !== member.memberId || saved.publicKey !== member.memberPublicKey
          || saved.keyGeneration !== member.keyGeneration) throw Error('enrollment_retirement_registry')
        return saved
      })
      after = { ...registry, registrationGeneration: parent.registrationGeneration as string, members }
    }
    await this.retirement.begin(proof, registry, after, t, guard); guard.assertHeld()
    return true
  }
  reconcileRetirement(): Promise<boolean> {
    if (this.retirementCheck) return this.retirementCheck
    if (this.busy || !this.retirement) return Promise.resolve(false)
    const current = this.options.trustStore.read()
    if (current?.status !== 'active' && current?.status !== 'revoked' && !hasDshEnrollmentState(this.options.directory)
      && !hasDshEnrollmentState(join(dirname(this.options.directory), 'retirement-v2'))
      && !hasDshEnrollmentState(join(dirname(this.options.directory), 'legacy-retirement-v1')))
      return Promise.resolve(false)
    // Existing explicit revocation must finish its protected archive without
    // requiring the retired QR entry point to be opened.
    const work = this.held(async (guard, signal) => {
      const resumed = await this.legacyRetirement?.resume(guard)
      const resumedCurrent = await this.retirement!.resume(guard); guard.assertHeld()
      const retired = await this.retireRemoved(guard, signal, false) || resumed === true || resumedCurrent
      if (retired) {
        this.trust = null
      }
      return retired
    }, () => {}, true)
    this.retirementCheck = work
    const clear = () => { if (this.retirementCheck === work) this.retirementCheck = null }
    void work.then(clear, clear)
    return work
  }
}
