import { join } from 'node:path'
import { registrationBytes as bytes, registrationDigest as digest, registrationFields as fields, registrationId as id,
  registrationTime, type JsonRecord } from './dsh-registration-contract.js'
import { RegistrationFile, registrationDirectory, type RegistrationGuard, type RegistrationProtector } from './dsh-registration-storage.js'
import type { PairingTrustRecord, PairingTrustStore } from './pairing-trust-store.js'
import { legacyBindingHash } from './legacy-retirement-service.js'

interface LegacyRetirement {
  contract: 'dshos-local-legacy-retirement-v1'; trust: PairingTrustRecord
  authority: 'service' | 'local-revocation'; proofDigest: string | null; complete: boolean
}
const valid = (v: unknown): v is LegacyRetirement => fields(v, ['contract', 'trust', 'authority', 'proofDigest', 'complete'])
  && v.contract === 'dshos-local-legacy-retirement-v1' && typeof v.complete === 'boolean'
  && fields(v.trust, ['pairingVersion', 'pairingId', 'mobilePublicKeyRaw', 'createdAt', 'updatedAt', 'status'])
  && v.trust.pairingVersion === 1 && id(v.trust.pairingId) && id(v.trust.mobilePublicKeyRaw, 32)
  && Number.isSafeInteger(v.trust.createdAt) && (v.trust.createdAt as number) >= 0
  && Number.isSafeInteger(v.trust.updatedAt) && (v.trust.updatedAt as number) >= (v.trust.createdAt as number)
  && (v.authority === 'service' && v.trust.status === 'active' && id(v.proofDigest, 32)
    || v.authority === 'local-revocation' && v.trust.status === 'revoked' && v.proofDigest === null)

// The protected journal is also the bounded archive of the exact old public
// identity. It never touches sessions, the host identity or another instance.
export class DshLegacyRetirement {
  readonly journal: RegistrationFile<LegacyRetirement>
  private readonly temporary: RegistrationFile<LegacyRetirement>
  constructor(private readonly options: { directory: string; trustStore: PairingTrustStore; invalidate(): void
    protector: RegistrationProtector; prepare?: (path: string) => Promise<void>; now: () => number }) {
    this.journal = new RegistrationFile(join(options.directory, 'legacy-retirement-v1.json'), options.protector, valid)
    this.temporary = new RegistrationFile(this.journal.path + '.tmp', options.protector, valid)
  }
  async resume(guard: RegistrationGuard): Promise<boolean> {
    const saved = await this.journal.read(); guard.assertHeld()
    if (!saved || saved.complete) return false
    await this.finish(saved, guard); return true
  }
  async begin(trust: PairingTrustRecord, proof: JsonRecord | null, guard: RegistrationGuard): Promise<void> {
    const fresh = { assertHeld: () => {
      guard.assertHeld()
      if (proof) registrationTime(proof, this.options.now(), 30000)
    } }
    fresh.assertHeld()
    if (!this.options.trustStore.deleteRevoked || !bytes(this.options.trustStore.read()).equals(bytes(trust)))
      throw Error('legacy_retirement_source_changed')
    if (proof && (trust.status !== 'active' || proof.contract !== 'dshos-legacy-retirement-proof-v1' || proof.status !== 'retired'
      || !fields(proof.request, ['contract', 'computerBindingHash', 'nonce'])
      || proof.request.computerBindingHash !== legacyBindingHash(trust.pairingId))
      || !proof && trust.status !== 'revoked') throw Error('legacy_retirement_authority')
    const prior = await this.journal.read(); fresh.assertHeld()
    if (prior && !prior.complete) throw Error('legacy_retirement_pending')
    await (this.options.prepare ?? registrationDirectory)(this.options.directory); fresh.assertHeld()
    const saved: LegacyRetirement = { contract: 'dshos-local-legacy-retirement-v1', trust,
      authority: proof ? 'service' : 'local-revocation', proofDigest: proof ? digest(proof) : null, complete: false }
    await this.journal.write(saved, fresh); guard.assertHeld()
    await this.finish(saved, guard)
  }
  private async finish(saved: LegacyRetirement, guard: RegistrationGuard): Promise<void> {
    const done: LegacyRetirement = { ...saved, complete: true }, revoked = { ...saved.trust, status: 'revoked' as const }
    const temporary = await this.temporary.read(); guard.assertHeld()
    if (temporary && !bytes(temporary).equals(bytes(done))) throw Error('legacy_retirement_completion_conflict')
    const current = this.options.trustStore.read(); guard.assertHeld()
    if (current !== null && !bytes(current).equals(bytes(saved.trust)) && !bytes(current).equals(bytes(revoked)))
      throw Error('legacy_retirement_source_changed')
    if (current?.status === 'active') this.options.trustStore.replace(revoked)
    this.options.invalidate(); guard.assertHeld()
    if (this.options.trustStore.read() !== null) this.options.trustStore.deleteRevoked!(revoked)
    if (!bytes(await this.journal.read()).equals(bytes(saved))) throw Error('legacy_retirement_journal_changed')
    guard.assertHeld()
    if (temporary) await this.temporary.remove(done, guard)
    await this.journal.write(done, guard); guard.assertHeld()
  }
}
