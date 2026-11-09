import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import type { NotificationConnectorCredentialStore } from './notification-connector-credential.js'
import { registrationBytes as bytes, registrationDigest as digest, registrationFields as fields, registrationId as id,
  registrationJson as json, registrationSign, registrationPrivateKey, registrationTime, registrationTranscript,
  parseDshRegistrationChallenge, validComputerRegistry, validDshPairingBody, verifyRegistrationService,
  type ComputerRegistry, type JsonRecord, type RegistrationTrust } from './dsh-registration-contract.js'
import { RegistrationFile, registrationDirectory, registrationLock, registrationProtector,
  type RegistrationGuard, type RegistrationLease, type RegistrationProtector } from './dsh-registration-storage.js'

const fresh = (n = 16) => randomBytes(n).toString('base64url')
export interface DshRegistrationMaterial { contract: string; computerId: string; registrationPrivateKey: string; registrationPublicKey: string;
  memberId: string; memberPrivateKey: string; memberPublicKey: string; pairingId: string; mobilePublicKey: string;
  accountBindingId: string | null; registrationGeneration: string | null }
type Material = DshRegistrationMaterial
interface Intent { contract: string; offer: JsonRecord; proof: JsonRecord }
interface PairIntent { contract: string; offer: JsonRecord; proof: JsonRecord }
function pairIntentValid(v: unknown): v is PairIntent {
  return fields(v, ['contract', 'offer', 'proof']) && v.contract === 'dshos-dsh-member-pairing-intent-v2' && offerValid(v.offer)
    && fields(v.proof, ['contract', 'body', 'memberSignature', 'mobileSignature']) && v.proof.contract === 'dshos-member-pairing-complete-v2'
    && validDshPairingBody(v.proof.body) && id(v.proof.memberSignature, 64) && id(v.proof.mobileSignature, 64)
}
function materialValid(v: unknown): v is Material {
  try {
    if (!fields(v, ['contract', 'computerId', 'registrationPrivateKey', 'registrationPublicKey', 'memberId', 'memberPrivateKey', 'memberPublicKey', 'pairingId', 'mobilePublicKey', 'accountBindingId', 'registrationGeneration'])
      || v.contract !== 'dshos-dsh-registration-material-v2' || !['computerId', 'memberId', 'pairingId'].every(k => id(v[k]))
      || !id(v.mobilePublicKey, 32) || new Set([v.mobilePublicKey, v.registrationPublicKey, v.memberPublicKey]).size !== 3
      || !(v.accountBindingId === null && v.registrationGeneration === null || id(v.accountBindingId) && id(v.registrationGeneration))) return false
    registrationPrivateKey(v.registrationPrivateKey, v.registrationPublicKey); registrationPrivateKey(v.memberPrivateKey, v.memberPublicKey)
    return true
  } catch { return false }
}
export { materialValid as validDshRegistrationMaterial }
function offerValid(v: unknown): v is JsonRecord {
  return fields(v, ['contract', 'sid', 'computerId', 'accountBindingId', 'registrationGeneration', 'registrationPublicKey', 'memberId', 'memberPublicKey',
    'pairingId', 'mobilePublicKey', 'dshBindingHash', 'expiresAt']) && v.contract === 'dshos-dsh-registration-offer-v2'
    && ['sid', 'computerId', 'memberId', 'pairingId'].every(k => id(v[k]))
    && (v.accountBindingId === null && v.registrationGeneration === null || id(v.accountBindingId) && id(v.registrationGeneration))
    && ['registrationPublicKey', 'memberPublicKey', 'mobilePublicKey'].every(k => id(v[k], 32))
    && /^[a-f0-9]{64}$/.test(v.dshBindingHash as string) && Number.isSafeInteger(v.expiresAt) && (v.expiresAt as number) >= 0
}
function intentValid(v: unknown): v is Intent {
  if (!fields(v, ['contract', 'offer', 'proof']) || v.contract !== 'dshos-dsh-registration-intent-v2' || !offerValid(v.offer)
    || !fields(v.proof, ['contract', 'body', 'registrationSignature', 'memberSignature', 'authoritySignature', 'legacyProof'])
    || v.proof.contract !== 'dshos-registration-complete-v2' || !id(v.proof.registrationSignature, 64) || !id(v.proof.memberSignature, 64)
    || !v.proof.body || typeof v.proof.body !== 'object' || Array.isArray(v.proof.body)) return false
  const proof = v.proof, offer = v.offer, body = proof.body as JsonRecord
  if (body.platform !== 'dsh' || !['create', 'bootstrap', 'add'].includes(body.purpose as string)
    || !['computerId', 'memberId', 'registrationPublicKey', 'memberPublicKey', 'mobilePublicKey'].every(k => body[k] === offer[k])
    || body.invitationDigest !== digest(offer) || !id(body.accountBindingId)) return false
  try {
    const domain = `REGISTRATION/${(body.purpose as string).toUpperCase()}`
    return [['registrationPublicKey', 'registrationSignature'], ['memberPublicKey', 'memberSignature']].every(([k, s]) =>
      verify(null, registrationTranscript(domain, body), createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: body[k!] as string } }),
        Buffer.from(proof[s!] as string, 'base64url')))
  } catch { return false }
}
export interface DshRegistrationOptions {
  readonly directory: string
  readonly registryDirectory: string
  readonly currentBinding: () => PairingAuthorizationBinding | undefined
  readonly legacy: NotificationConnectorCredentialStore
  readonly loadTrust: (signal: AbortSignal) => Promise<RegistrationTrust>
  readonly now?: () => number
  readonly monotonic?: () => number
  readonly protector?: (purpose: 'COMPUTER-REGISTRY/V1' | 'DSH-REGISTRATION/V2' | 'DSH-REGISTRATION-INTENT/V2') => RegistrationProtector
  readonly lock?: (directory: string) => Promise<RegistrationLease>
  readonly prepareDirectory?: (directory: string) => Promise<void>
}
// Adds only product-owned registration files. Does not replace V1 pairing, roots, ports or the DSH host.
export class DshRegistration {
  readonly material: RegistrationFile<Material>
  readonly intent: RegistrationFile<Intent>
  readonly pairingIntent: RegistrationFile<PairIntent>
  readonly registry: RegistrationFile<ComputerRegistry>
  private window: { binding: PairingAuthorizationBinding; expires: number; deadline: number } | null = null
  private offerValue: JsonRecord | null = null
  private trust: RegistrationTrust | null = null
  private busy = false
  private revision = 0
  private high = -1
  private controller: AbortController | null = null
  private continuing = false
  private unified = false
  private continuation: { previousDigest: string; source: Intent | null; offer: JsonRecord; registry: ComputerRegistry | null } | null = null
  private readonly now: () => number
  private readonly time: () => number
  constructor(private readonly options: DshRegistrationOptions) {
    this.now = options.now ?? Date.now; this.time = options.monotonic ?? (() => performance.now())
    const protect = options.protector ?? registrationProtector
    this.material = new RegistrationFile(join(options.directory, 'material-v2.json'), protect('DSH-REGISTRATION/V2'), materialValid)
    this.intent = new RegistrationFile(join(options.directory, 'intent-v2.json'), protect('DSH-REGISTRATION-INTENT/V2'), intentValid)
    this.pairingIntent = new RegistrationFile(join(options.directory, 'pairing-intent-v2.json'), protect('DSH-REGISTRATION-INTENT/V2'), pairIntentValid)
    this.registry = new RegistrationFile(join(options.registryDirectory, 'computer-registry-v2.json'), protect('COMPUTER-REGISTRY/V1'), validComputerRegistry)
  }
  // Invoked only by the local DSH command. Opening/reading the normal settings page never calls it.
  allow(): void {
    if (this.busy) throw Error('registration_busy')
    const binding = this.options.currentBinding(), now = this.now()
    if (!binding || !id(binding.pairingId) || !id(binding.mobilePublicKeyRaw, 32) || !Number.isSafeInteger(now) || now < this.high)
      throw Error('registration_binding')
    this.cancel(); this.high = now
    this.window = { binding: { ...binding }, expires: now + 120000, deadline: this.time() + 120000 }
  }
  // The single local entry authorizes coordination, never removal of existing identity.
  allowUnified(): void {
    const previousOffer = this.offerValue
    this.allow(); this.unified = true; this.offerValue = previousOffer
  }
  allowContinue(): void {
    const previousOffer = this.offerValue
    this.allow(); this.continuing = true; this.offerValue = previousOffer
  }
  cancel(): void {
    this.revision++; this.window = null; this.offerValue = null; this.trust = null; this.controller?.abort()
    this.continuing = false; this.unified = false; this.continuation = null
  }
  private check(): void {
    const w = this.window, b = this.options.currentBinding(), now = this.now()
    if (!w || !b || b.pairingId !== w.binding.pairingId || b.mobilePublicKeyRaw !== w.binding.mobilePublicKeyRaw
      || !Number.isSafeInteger(now) || now < this.high || now >= w.expires || this.time() >= w.deadline) throw Error('registration_confirmation')
    this.high = now
  }
  private async held<T>(operation: (guard: RegistrationGuard) => Promise<T>, assertAuthorized: () => void): Promise<T> {
    if (this.busy) throw Error('registration_busy')
    this.check(); this.busy = true
    const revision = this.revision; let lease: RegistrationLease | undefined
    const guard = { assertHeld: () => { assertAuthorized(); this.check(); lease?.assertHeld(); if (revision !== this.revision) throw Error('registration_cancelled') } }
    try {
      lease = await (this.options.lock ?? registrationLock)(this.options.registryDirectory); guard.assertHeld()
      await (this.options.prepareDirectory ?? registrationDirectory)(this.options.directory); guard.assertHeld()
      return await operation(guard)
    } finally { try { await lease?.release() } finally { this.busy = false } }
  }
  private async keys(guard: RegistrationGuard): Promise<Material> {
    const m = await this.material.read(); guard.assertHeld()
    const b = this.window!.binding
    if (!m || m.pairingId !== b.pairingId || m.mobilePublicKey !== b.mobilePublicKeyRaw) throw Error('registration_material')
    return m
  }
  private matchIntent(m: Material, pending: Intent): void {
    const body = pending.proof.body as JsonRecord
    if (!['computerId', 'memberId', 'registrationPublicKey', 'memberPublicKey', 'pairingId', 'mobilePublicKey'].every(k => pending.offer[k] === m[k as keyof Material])
      || m.accountBindingId !== null && m.accountBindingId !== body.accountBindingId
      || pending.offer.dshBindingHash !== createHash('sha256').update(Buffer.from(m.pairingId, 'base64url')).digest('hex')
      || !Number.isSafeInteger(body.issuedAt) || (body.issuedAt as number) < 0 || !Number.isSafeInteger(body.expiresAt)
      || (body.expiresAt as number) - (body.issuedAt as number) !== 60000) throw Error('registration_recovery_required')
  }
  async statusProof(nonce: unknown, assertAuthorized: () => void): Promise<JsonRecord> {
    if (!id(nonce, 32)) throw Error('registration_format')
    return this.held(async guard => {
      const m = await this.keys(guard), pending = await this.intent.read(); guard.assertHeld()
      if (!pending) throw Error('registration_recovery_required')
      this.matchIntent(m, pending)
      await this.intent.write(pending, guard); guard.assertHeld()
      return { contract: 'dshos-dsh-registration-status-proof-result-v2', nonce, offer: pending.offer, proof: pending.proof }
    }, assertAuthorized)
  }
  async continueOffer(previousDigest: unknown, assertAuthorized: () => void): Promise<JsonRecord> {
    if (!id(previousDigest, 32)) throw Error('registration_format')
    return this.held(async guard => {
      if (!this.continuing) throw Error('registration_confirmation')
      const m = await this.keys(guard), pending = await this.intent.read(); guard.assertHeld()
      const pairing = await this.pairingIntent.read(), registry = await this.registry.read(); guard.assertHeld()
      if (pairing || m.accountBindingId !== null || registry?.members.some(v => v.platform === 'dsh')) throw Error('registration_recovery_required')
      if (pending) this.matchIntent(m, pending)
      const original = pending?.offer ?? this.continuation?.offer ?? this.offerValue
      if (!original || previousDigest !== digest(pending?.proof ?? original)) throw Error('registration_recovery_required')
      if (!['computerId', 'memberId', 'registrationPublicKey', 'memberPublicKey', 'pairingId', 'mobilePublicKey'].every(k => original[k] === m[k as keyof Material]))
        throw Error('registration_scope')
      const expires = pending ? (pending.proof.body as JsonRecord).expiresAt : (original.expiresAt as number) + 60000
      if (!Number.isSafeInteger(expires) || this.now() < (expires as number)) throw Error('registration_expired')
      const account = pending ? (pending.proof.body as JsonRecord).accountBindingId : original.accountBindingId
      if (registry && (registry.computerId !== m.computerId || registry.registrationPrivateKey !== m.registrationPrivateKey
        || registry.registrationPublicKey !== m.registrationPublicKey
        || account !== null && registry.accountBindingId !== account)) throw Error('registration_scope')
      if (!this.trust) {
        const controller = new AbortController(); this.controller = controller
        try { this.trust = await this.options.loadTrust(controller.signal); guard.assertHeld() }
        finally { if (this.controller === controller) this.controller = null }
      }
      if (this.continuation && this.continuation.previousDigest !== previousDigest) throw Error('registration_recovery_required')
      if (!this.continuation) {
        this.continuation = { previousDigest, source: pending, offer: original, registry }
        this.offerValue = { ...original, sid: fresh(), accountBindingId: registry?.accountBindingId ?? original.accountBindingId,
          registrationGeneration: registry?.registrationGeneration ?? original.registrationGeneration, expiresAt: this.window!.expires }
      }
      return { contract: 'dshos-dsh-registration-offer-result-v2', offer: this.offerValue, recoveryRequired: true }
    }, assertAuthorized)
  }
  async offer(assertAuthorized: () => void): Promise<JsonRecord> {
    return this.held(async guard => {
      if (this.continuation) throw Error('registration_confirmation')
      if (!this.trust) {
        const controller = new AbortController(); this.controller = controller
        try { this.trust = await this.options.loadTrust(controller.signal); guard.assertHeld() }
        finally { if (this.controller === controller) this.controller = null }
      }
      const registry = await this.registry.read(); guard.assertHeld()
      let m = await this.material.read(); guard.assertHeld()
      const pending = await this.intent.read(); guard.assertHeld()
      if (this.unified) this.continuing = pending !== null || this.offerValue !== null
      if (this.continuing && !m) throw Error('registration_recovery_required')
      if (this.continuing && !pending && !this.offerValue) throw Error('registration_recovery_required')
      const b = this.window!.binding, existing = registry?.members.find(v => v.platform === 'dsh')
      if (m && (m.pairingId !== b.pairingId || m.mobilePublicKey !== b.mobilePublicKeyRaw)
        || registry && m?.accountBindingId && registry.accountBindingId !== m.accountBindingId
        || registry && m && ['computerId', 'registrationPrivateKey', 'registrationPublicKey'].some(k => m![k as keyof Material] !== registry[k as keyof ComputerRegistry])
        || existing && (!m || existing.memberId !== m.memberId || existing.publicKey !== m.memberPublicKey)) throw Error('registration_recovery_required')
      if (!m) {
        const reg = registry ?? (() => { const k = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
          return { computerId: fresh(), registrationPrivateKey: k.d!, registrationPublicKey: k.x! } })()
        const member = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
        m = { contract: 'dshos-dsh-registration-material-v2', computerId: reg.computerId, registrationPrivateKey: reg.registrationPrivateKey,
          registrationPublicKey: reg.registrationPublicKey, memberId: fresh(), memberPrivateKey: member.d!, memberPublicKey: member.x!,
          pairingId: b.pairingId, mobilePublicKey: b.mobilePublicKeyRaw, accountBindingId: null, registrationGeneration: null }
      }
      await this.material.write(m, guard); guard.assertHeld() // Confirm durable storage before any signatures can escape.
      if (pending) {
        if (!['computerId', 'memberId', 'registrationPublicKey', 'memberPublicKey', 'pairingId', 'mobilePublicKey'].every(k => pending.offer[k] === m![k as keyof Material]))
          throw Error('registration_recovery_required')
        this.offerValue = pending.offer
      } else this.offerValue = this.offerValue ?? {
        contract: 'dshos-dsh-registration-offer-v2', sid: fresh(), computerId: m.computerId,
        accountBindingId: registry?.accountBindingId ?? m.accountBindingId, registrationGeneration: registry?.registrationGeneration ?? m.registrationGeneration,
        registrationPublicKey: m.registrationPublicKey, memberId: m.memberId, memberPublicKey: m.memberPublicKey,
        pairingId: b.pairingId, mobilePublicKey: b.mobilePublicKeyRaw,
        dshBindingHash: createHash('sha256').update(Buffer.from(b.pairingId, 'base64url')).digest('hex'), expiresAt: this.window!.expires,
      }
      return { contract: 'dshos-dsh-registration-offer-result-v2', offer: this.offerValue, recoveryRequired: pending !== null || !registry && m.accountBindingId !== null }
    }, assertAuthorized)
  }
  async prove(signed: Uint8Array, assertAuthorized: () => void): Promise<JsonRecord> {
    return this.proveRegistration(signed, assertAuthorized)
  }
  async continueProof(previousDigest: unknown, signed: Uint8Array, assertAuthorized: () => void): Promise<JsonRecord> {
    if (!id(previousDigest, 32)) throw Error('registration_format')
    return this.proveRegistration(signed, assertAuthorized, previousDigest)
  }
  private async proveRegistration(signed: Uint8Array, assertAuthorized: () => void, previousDigest?: string): Promise<JsonRecord> {
    return this.held(async guard => {
      if (!this.offerValue || !this.trust) throw Error('registration_offer_required')
      if (previousDigest === undefined ? this.continuation !== null : !this.continuing || this.continuation?.previousDigest !== previousDigest)
        throw Error('registration_confirmation')
      const m = await this.keys(guard), offer = this.offerValue
      const body = parseDshRegistrationChallenge(signed, this.trust, this.now())
      if (this.now() >= (offer.expiresAt as number) || !['computerId', 'memberId', 'registrationPublicKey', 'memberPublicKey', 'mobilePublicKey'].every(k => body[k] === offer[k])
        || body.invitationDigest !== digest(offer)
        || (body.purpose === 'add' ? body.accountBindingId !== offer.accountBindingId || body.previousGeneration !== offer.registrationGeneration
          : offer.accountBindingId !== null || offer.registrationGeneration !== null
            || body.purpose === 'create' && body.previousGeneration !== Buffer.alloc(16).toString('base64url')))
        throw Error('registration_scope')
      const saved = await this.intent.read(); guard.assertHeld()
      if (this.continuing && previousDigest === undefined && (!saved || !bytes(saved.proof.body).equals(bytes(body))))
        throw Error('registration_confirmation')
      if (previousDigest !== undefined) {
        const source = this.continuation!.source, original = this.continuation!.offer
        const expires = source ? (source.proof.body as JsonRecord).expiresAt : (original.expiresAt as number) + 60000
        const account = source ? (source.proof.body as JsonRecord).accountBindingId : original.accountBindingId
        const pairing = await this.pairingIntent.read(), registry = await this.registry.read(); guard.assertHeld()
        if (pairing || m.accountBindingId !== null || registry?.members.some(v => v.platform === 'dsh')
          || !bytes(registry).equals(bytes(this.continuation!.registry))
          || !Number.isSafeInteger(expires) || (body.issuedAt as number) < (expires as number)
          || account !== null && body.accountBindingId !== account) throw Error('registration_scope')
        if (saved && !bytes(saved.proof.body).equals(bytes(body)) && digest(saved.proof) !== previousDigest
          || !saved && source !== null) throw Error('registration_recovery_required')
        if (source) this.matchIntent(m, source)
      }
      if (saved) {
        if (bytes(saved.proof.body).equals(bytes(body))) {
          await this.intent.write(saved, guard)
          guard.assertHeld(); parseDshRegistrationChallenge(signed, this.trust, this.now())
          return saved.proof
        }
        if (previousDigest === undefined) throw Error('registration_recovery_required')
      }
      const domain = `REGISTRATION/${(body.purpose as string).toUpperCase()}`
      const regSignature = registrationSign(domain, body, m.registrationPrivateKey, m.registrationPublicKey)
      const proof = { contract: 'dshos-registration-complete-v2', body, registrationSignature: regSignature,
        memberSignature: registrationSign(domain, body, m.memberPrivateKey, m.memberPublicKey),
        authoritySignature: body.purpose === 'add' ? regSignature : null,
        legacyProof: body.purpose === 'bootstrap' ? await this.options.legacy.proveLegacyRegistration(signed, this.trust, bytes(body),
          this.window!.binding, () => guard.assertHeld(), this.now) : null }
      guard.assertHeld(); parseDshRegistrationChallenge(signed, this.trust, this.now())
      if (!bytes(await this.intent.read()).equals(bytes(saved))) throw Error('registration_recovery_required')
      guard.assertHeld()
      await this.intent.write({ contract: 'dshos-dsh-registration-intent-v2', offer, proof }, guard)
      guard.assertHeld(); parseDshRegistrationChallenge(signed, this.trust, this.now())
      return proof
    }, assertAuthorized)
  }
  async provePairing(signedBytes: Uint8Array, mobileSignature: unknown, assertAuthorized: () => void): Promise<JsonRecord> {
    return this.held(async guard => {
      if (!this.offerValue || !this.trust) throw Error('registration_offer_required')
      const m = await this.keys(guard), registry = await this.registry.read(); guard.assertHeld()
      const offer = this.offerValue, signed = json(signedBytes), b = signed.body
      if (!fields(signed, ['contract', 'keyId', 'body', 'signature']) || signed.contract !== 'dshos-member-pairing-challenge-signed-v2'
        || !validDshPairingBody(b) || !id(mobileSignature, 64)) throw Error('registration_format')
      verifyRegistrationService('MEMBER-PAIRING/CHALLENGE', signed, this.trust); registrationTime(b, this.now(), 60000)
      const member = registry?.members.find(v => v.platform === 'dsh')
      if (!registry || !member || this.now() >= (offer.expiresAt as number) || member.memberId !== m.memberId || member.publicKey !== m.memberPublicKey
        || b.computerId !== m.computerId || b.accountBindingId !== registry.accountBindingId || b.memberId !== m.memberId
        || b.registrationGeneration !== registry.registrationGeneration || b.memberKeyGeneration !== member.keyGeneration
        || b.newPairingId !== m.pairingId || b.newMobilePublicKey !== m.mobilePublicKey || b.invitationDigest !== digest(offer)
        || b.dshBindingHash !== offer.dshBindingHash) throw Error('registration_scope')
      const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: m.mobilePublicKey } })
      if (!verify(null, registrationTranscript('MEMBER-PAIRING/MOBILE', b), publicKey, Buffer.from(mobileSignature, 'base64url'))) throw Error('registration_signature')
      const saved = await this.pairingIntent.read(); guard.assertHeld()
      if (saved) {
        if (!bytes(saved.proof.body).equals(bytes(b)) || saved.proof.mobileSignature !== mobileSignature) throw Error('registration_recovery_required')
        await this.pairingIntent.write(saved, guard)
        guard.assertHeld(); registrationTime(b, this.now(), 60000)
        return saved.proof
      }
      const proof = { contract: 'dshos-member-pairing-complete-v2', body: b,
        memberSignature: registrationSign('MEMBER-PAIRING/MEMBER', b, m.memberPrivateKey, m.memberPublicKey), mobileSignature }
      await this.pairingIntent.write({ contract: 'dshos-dsh-member-pairing-intent-v2', offer, proof }, guard)
      guard.assertHeld(); registrationTime(b, this.now(), 60000); return proof
    }, assertAuthorized)
  }
  async pairingStatus(nonce: unknown, assertAuthorized: () => void): Promise<JsonRecord> {
    if (!id(nonce, 32)) throw Error('registration_format')
    return this.held(async guard => {
      const m = await this.keys(guard), saved = await this.pairingIntent.read(); guard.assertHeld()
      if (!saved || saved.proof.body === null) throw Error('registration_recovery_required')
      const b = saved.proof.body as JsonRecord
      if (b.computerId !== m.computerId || b.memberId !== m.memberId || b.newPairingId !== m.pairingId || b.newMobilePublicKey !== m.mobilePublicKey)
        throw Error('registration_scope')
      await this.pairingIntent.write(saved, guard); guard.assertHeld()
      return { contract: 'dshos-member-pairing-status-v2', body: b, memberSignature: saved.proof.memberSignature,
        mobileSignature: saved.proof.mobileSignature, nonce }
    }, assertAuthorized)
  }
  // The transport is the current authenticated phone, never a PC-held Huawei token or an arbitrary URL.
  async synchronize(query: (request: JsonRecord, signal: AbortSignal) => Promise<Uint8Array>, assertAuthorized: () => void): Promise<JsonRecord> {
    if (typeof query !== 'function') throw Error('registration_transport')
    return this.held(async guard => {
      if (!this.trust) throw Error('registration_offer_required')
      const m = await this.keys(guard), intent = await this.intent.read(); guard.assertHeld()
      const previous = await this.registry.read(); guard.assertHeld()
      if (previous && ['computerId', 'registrationPrivateKey', 'registrationPublicKey'].some(k => previous[k as keyof ComputerRegistry] !== m[k as keyof Material]))
        throw Error('registration_recovery_required')
      const account = previous?.accountBindingId ?? m.accountBindingId ?? (intent?.proof.body as JsonRecord | undefined)?.accountBindingId
      if (m.accountBindingId !== null && account !== m.accountBindingId) throw Error('registration_scope')
      if (!id(account)) throw Error('registration_account')
      const request = { contract: 'dshos-computer-registry-current-v2', accountBindingId: account, computerId: m.computerId,
        platform: 'dsh', memberId: m.memberId, nonce: fresh(32) }
      const signedRequest = { ...request, memberSignature: registrationSign('REGISTRATION/CURRENT-REQUEST', request, m.memberPrivateKey, m.memberPublicKey) }
      const controller = new AbortController(); this.controller = controller
      const deadline = this.time() + 8000
      const held = { assertHeld: () => { guard.assertHeld(); if (controller.signal.aborted || this.time() >= deadline) throw Error('registration_timeout') } }
      const timer = setTimeout(() => controller.abort(), 8000)
      let transport: Promise<Uint8Array> | undefined
      try {
        held.assertHeld()
        const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('registration_timeout')), { once: true }))
        transport = Promise.resolve().then(() => { held.assertHeld(); return query(signedRequest, controller.signal) })
        const result = json(await Promise.race([transport, aborted])); held.assertHeld()
        if (!fields(result, ['contract', 'keyId', 'request', 'computer', 'members', 'issuedAt', 'expiresAt', 'signature'])
          || result.contract !== 'dshos-computer-registry-current-result-v2' || !bytes(result.request).equals(bytes(request))) throw Error('registration_scope')
        verifyRegistrationService('REGISTRATION/CURRENT-RESULT', result, this.trust); registrationTime(result, this.now(), 30000)
        const c = result.computer
        if (!fields(c, ['computerId', 'accountBindingId', 'registrationGeneration', 'registrationPublicKey', 'everDual'])
          || c.computerId !== m.computerId || c.accountBindingId !== account || c.registrationPublicKey !== m.registrationPublicKey
          || !id(c.registrationGeneration) || typeof c.everDual !== 'boolean' || !Array.isArray(result.members)) throw Error('registration_scope')
        const members = result.members.map((v: unknown) => {
          if (!fields(v, ['platform', 'memberId', 'memberPublicKey', 'keyGeneration'])) throw Error('registration_scope')
          const old = previous?.members.find(old => old.platform === v.platform && old.memberId === v.memberId && old.publicKey === v.memberPublicKey && old.keyGeneration === v.keyGeneration)
          return { platform: v.platform, memberId: v.memberId, publicKey: v.memberPublicKey, keyGeneration: v.keyGeneration, pairingState: old?.pairingState ?? 'unpaired' }
        })
        const current = { contract: 'dshos-computer-registry-v2', computerId: c.computerId, accountBindingId: c.accountBindingId,
          registrationGeneration: c.registrationGeneration, registrationPrivateKey: m.registrationPrivateKey, registrationPublicKey: m.registrationPublicKey, members }
        if (!validComputerRegistry(current) || !current.members.some(v => v.platform === 'dsh' && v.memberId === m.memberId && v.publicKey === m.memberPublicKey)) throw Error('registration_scope')
        if (previous?.members.some(old => !current.members.some(v => v.platform === old.platform && v.memberId === old.memberId
          && v.publicKey === old.publicKey && v.keyGeneration === old.keyGeneration))) throw Error('registration_recovery_required')
        const unchanged = await this.registry.read(); held.assertHeld(); registrationTime(result, this.now(), 30000)
        if (!bytes(unchanged).equals(bytes(previous))) throw Error('registration_changed')
        if (m.accountBindingId !== current.accountBindingId || m.registrationGeneration !== current.registrationGeneration) {
          await this.material.write({ ...m, accountBindingId: current.accountBindingId, registrationGeneration: current.registrationGeneration }, held)
          held.assertHeld(); registrationTime(result, this.now(), 30000)
        }
        await this.registry.write(current, held); held.assertHeld(); registrationTime(result, this.now(), 30000)
        if (intent) { await this.intent.remove(intent, held); held.assertHeld() }
        this.offerValue = null
        this.continuation = null; this.continuing = false
        return { contract: 'dshos-dsh-registration-synchronized-v2', computerId: m.computerId, memberId: m.memberId,
          registrationGeneration: current.registrationGeneration }
      } finally {
        clearTimeout(timer); controller.abort()
        // The query owns no filesystem authority. A late transport result is ignored and cannot write.
        void transport?.catch(() => {})
        if (this.controller === controller) this.controller = null
      }
    }, assertAuthorized)
  }
}
