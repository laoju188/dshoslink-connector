import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { registrationBytes as bytes, registrationDigest as digest, registrationFields as fields, registrationId as id,
  validComputerRegistry, type ComputerRegistry, type JsonRecord } from './dsh-registration-contract.js'
import { createHash } from 'node:crypto'
import { RegistrationFile, registrationDirectory, registrationPath, registrationProtector,
  type RegistrationGuard, type RegistrationProtector } from './dsh-registration-storage.js'
import type { PairingTrustRecord, PairingTrustStore } from './pairing-trust-store.js'

const FILES = ['material-v2.json', 'source-v2.json', 'intent-v2.json', 'pairing-intent-v2.json', 'activation-v2.json']
const hash = (value: Buffer) => createHash('sha256').update(value).digest('base64url')
interface Journal {
  contract: 'dshos-dsh-local-retirement-v2'; computerId: string; proofDigest: string; beforeDigest: string
  after: ComputerRegistry | null; trust: PairingTrustRecord | null; files: { name: string; digest: string }[]; complete: boolean
}
const valid = (v: unknown): v is Journal => fields(v, ['contract', 'computerId', 'proofDigest', 'beforeDigest', 'after', 'trust', 'files', 'complete'])
  && v.contract === 'dshos-dsh-local-retirement-v2' && id(v.computerId) && id(v.proofDigest, 32) && id(v.beforeDigest, 32)
  && (v.after === null || validComputerRegistry(v.after)) && typeof v.complete === 'boolean'
  && (v.trust === null || fields(v.trust, ['pairingVersion', 'pairingId', 'mobilePublicKeyRaw', 'createdAt', 'updatedAt', 'status'])
  && v.trust.pairingVersion === 1 && id(v.trust.pairingId) && id(v.trust.mobilePublicKeyRaw, 32)
  && v.trust.status === 'active' && Number.isSafeInteger(v.trust.createdAt) && (v.trust.createdAt as number) >= 0
  && Number.isSafeInteger(v.trust.updatedAt) && (v.trust.updatedAt as number) >= (v.trust.createdAt as number))
  && Array.isArray(v.files) && v.files.length <= FILES.length
  && v.files.every((f: unknown, i: number, all: unknown[]) => fields(f, ['name', 'digest']) && FILES.includes(f.name as string)
    && id(f.digest, 32) && all.findIndex(x => (x as JsonRecord).name === f.name) === i)

// A single bounded archive slot outside enrollment-v2; its records never become active again.
export class DshLocalRetirement {
  readonly journal: RegistrationFile<Journal>
  private readonly completionTemporary: RegistrationFile<Journal>
  private readonly archive: string
  constructor(private readonly options: { directory: string; source: string; registry: RegistrationFile<ComputerRegistry>
    trustStore: PairingTrustStore; invalidate(): void; now?: () => number
    protector?: RegistrationProtector; prepare?: (path: string) => Promise<void> }) {
    this.archive = join(options.directory, 'archive')
    this.journal = new RegistrationFile(join(options.directory, 'retirement-v2.json'),
      options.protector ?? registrationProtector('DSH-REGISTRATION-INTENT/V2'), valid)
    this.completionTemporary = new RegistrationFile(this.journal.path + '.tmp',
      options.protector ?? registrationProtector('DSH-REGISTRATION-INTENT/V2'), valid)
  }
  private async read(name: string, archived: boolean, guard: RegistrationGuard): Promise<Buffer | null> {
    guard.assertHeld(); const path = join(archived ? this.archive : this.options.source, name)
    try { await registrationPath(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 16384) throw Error('retirement_file')
      const value = Buffer.alloc(16385); let size = 0
      while (size < value.length) { const r = await handle.read(value, size, value.length - size, null); if (!r.bytesRead) break; size += r.bytesRead }
      if (size > 16384) throw Error('retirement_capacity')
      guard.assertHeld(); return value.subarray(0, size)
    } finally { await handle.close() }
  }
  async resume(guard: RegistrationGuard): Promise<boolean> {
    const saved = await this.journal.read(); guard.assertHeld()
    if (!saved || saved.complete) return false
    await this.finish(saved, guard); return true
  }
  async begin(proof: JsonRecord, before: ComputerRegistry | null, after: ComputerRegistry | null,
    trust: PairingTrustRecord | null, guard: RegistrationGuard): Promise<void> {
    const removalProof = proof.contract === 'dshos-local-registration-status-result-v3'
    if (!fields(proof.request, ['contract', 'computerId', 'registrationPublicKey', 'platform', 'memberId', 'memberPublicKey', 'nonce',
      ...(removalProof ? ['accountBindingId'] : [])])
      || removalProof && (!id(proof.request.accountBindingId) || !proof.removal)
      || !id(proof.request.computerId) || trust !== null && (trust.status !== 'active' || !this.options.trustStore.deleteRevoked))
      throw Error('retirement_input')
    const fresh = { assertHeld: () => {
      guard.assertHeld(); const now = (this.options.now ?? Date.now)()
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt)
        || (proof.expiresAt as number) - (proof.issuedAt as number) !== 30000
        || now < (proof.issuedAt as number) || now >= (proof.expiresAt as number)) throw Error('retirement_proof_expired')
    } }
    fresh.assertHeld()
    if (!bytes(await this.options.registry.read()).equals(bytes(before))
      || !bytes(this.options.trustStore.read()).equals(bytes(trust))) throw Error('retirement_source_changed')
    if ((before && before.computerId !== proof.request.computerId || after && after.computerId !== proof.request.computerId)
      && !(proof.computer === null && bytes(before).equals(bytes(after)))) throw Error('retirement_scope')
    const previous = await this.journal.read(); guard.assertHeld()
    if (previous && !previous.complete) throw Error('retirement_pending')
    const files: Journal['files'] = []
    for (const name of FILES) { const value = await this.read(name, false, guard); if (value) files.push({ name, digest: hash(value) }) }
    if (!files.some(f => f.name === 'material-v2.json')
      || !files.some(f => f.name === (trust === null ? 'intent-v2.json' : 'activation-v2.json'))) throw Error('retirement_active_identity_missing')
    if (previous) for (const file of previous.files) {
      const value = await this.read(file.name, true, guard)
      if (value && hash(value) !== file.digest) throw Error('retirement_archive_changed')
      if (value) { guard.assertHeld(); await unlink(join(this.archive, file.name)); guard.assertHeld() }
    }
    await (this.options.prepare ?? registrationDirectory)(this.archive); guard.assertHeld()
    for (const name of FILES) if (await this.read(name, true, guard)) throw Error('retirement_archive_conflict')
    const saved: Journal = { contract: 'dshos-dsh-local-retirement-v2', computerId: proof.request.computerId,
      proofDigest: digest(proof), beforeDigest: digest(before), after, trust, files, complete: false }
    await this.journal.write(saved, fresh); guard.assertHeld(); await this.finish(saved, guard)
  }
  private async finish(saved: Journal, guard: RegistrationGuard): Promise<void> {
    const completed: Journal = { ...saved, complete: true }
    const temporary = await this.completionTemporary.read(); guard.assertHeld()
    if (temporary && !bytes(temporary).equals(bytes(completed))) throw Error('retirement_completion_conflict')
    const currentTrust = this.options.trustStore.read(), revoked = saved.trust === null ? null : { ...saved.trust, status: 'revoked' as const }
    guard.assertHeld()
    if (currentTrust !== null && !bytes(currentTrust).equals(bytes(saved.trust)) && !bytes(currentTrust).equals(bytes(revoked)))
      throw Error('retirement_trust_changed')
    if (currentTrust && currentTrust.status !== 'revoked') this.options.trustStore.replace(revoked!)
    this.options.invalidate(); guard.assertHeld()
    for (const file of saved.files) {
      const source = await this.read(file.name, false, guard), archived = await this.read(file.name, true, guard)
      if (source && archived || !source && !archived || hash((source ?? archived)!) !== file.digest) throw Error('retirement_source_changed')
      if (source) { guard.assertHeld(); await rename(join(this.options.source, file.name), join(this.archive, file.name)); guard.assertHeld() }
    }
    const current = await this.options.registry.read(); guard.assertHeld()
    if (digest(current) === saved.beforeDigest) {
      if (saved.after) await this.options.registry.write(saved.after, guard)
      else if (current) await this.options.registry.remove(current, guard)
    } else if (!bytes(current).equals(bytes(saved.after)) && !(saved.after === null && current && current.computerId !== saved.computerId))
      throw Error('retirement_registry_changed')
    guard.assertHeld()
    if (this.options.trustStore.read() !== null) {
      if (!revoked || !this.options.trustStore.deleteRevoked) throw Error('retirement_store_unavailable')
      this.options.trustStore.deleteRevoked(revoked)
    }
    if (!bytes(await this.journal.read()).equals(bytes(saved))) throw Error('retirement_journal_changed')
    guard.assertHeld()
    if (temporary) await this.completionTemporary.remove(completed, guard)
    await this.journal.write(completed, guard); guard.assertHeld()
  }
}
