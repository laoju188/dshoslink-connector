import { createHash, type KeyObject } from 'node:crypto'
import { lstatSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'
import { registrationId, registrationPrivateKey, type ComputerRegistry } from './dsh-registration-contract.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'

export interface DshQueueIdentity {
  accountBindingId: string; computerId: string; memberId: string; pairingId: string
  keyGeneration: string; memberPublicKey: string
}
export interface DshQueueIdentityLease { identity: Readonly<DshQueueIdentity>; memberKey: KeyObject; assertCurrent(): void }
export interface DshQueueMaterial {
  computerId: string; memberId: string; pairingId: string; mobilePublicKey: string | null
  accountBindingId: string | null; registrationGeneration: string | null
  registrationPublicKey: string; memberPrivateKey: string; memberPublicKey: string
}
type Material = DshQueueMaterial
export interface DshQueueIdentitySource {
  kind?: 'cloud'
  maximumMaterialBytes?: 32768
  material: { path: string; read(): Promise<Material | null> }
  registry: { path: string; read(): Promise<ComputerRegistry | null> }
}

// Pin the exact protected files read below, including absence of the other
// registration material. Final native admission rechecks this synchronously.
// No private material or path is returned in any protocol response.
function stamp(file: string, maximumBytes = 16384): string {
  const absolute = resolve(file)
  let existing = absolute
  let stat = lstatSync(existing, { throwIfNoEntry: false })
  while (stat === undefined) {
    const parent = dirname(existing)
    if (parent === existing) throw Error('queue_identity_path')
    existing = parent
    stat = lstatSync(existing, { throwIfNoEntry: false })
  }
  // Re-resolve on every check, including the nearest existing ancestor of an
  // absent file. Canonical equality rejects redirected parents without walking
  // the same entire directory tree again for each material and temporary file.
  if (stat.isSymbolicLink()) throw Error('queue_identity_path')
  const canonical = realpathSync(existing)
  if (canonical !== existing) {
    if (canonical.toLowerCase() !== existing.toLowerCase()) throw Error('queue_identity_path')
    // Windows spelling aliases are valid, but a case-folded match alone must
    // not admit links on a case-sensitive directory/volume. Keep the original
    // component check for this uncommon spelling-alias path.
    let part = parse(existing).root
    for (const name of existing.slice(part.length).split(/[\\/]/)) {
      if (!name) continue
      part = join(part, name)
      if (lstatSync(part).isSymbolicLink()) throw Error('queue_identity_path')
    }
  }
  if (existing !== absolute) {
    if (!stat.isDirectory()) throw Error('queue_identity_path')
    return 'absent'
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximumBytes) throw Error('queue_identity_path')
  const bytes = readFileSync(absolute)
  if (bytes.length > maximumBytes) throw Error('queue_identity_path')
  return createHash('sha256').update(bytes).digest('base64url')
}

export function createDshQueueIdentityLoader(sources: readonly DshQueueIdentitySource[],
  currentBinding: () => PairingAuthorizationBinding | undefined, assertRuntime: () => void): () => Promise<DshQueueIdentityLease> {
  let cached: DshQueueIdentityLease | null = null
  return async () => {
    assertRuntime()
    if (cached) { try { cached.assertCurrent(); return cached } catch { cached = null } }
    const binding = currentBinding()
    if (!binding) throw Error('queue_auth_required')
    const files = [...new Set(sources.flatMap(s => [s.material.path, s.registry.path]))]
    const limit = (file: string): number => sources.some(s => s.kind === 'cloud' && s.material.path === file && s.maximumMaterialBytes === 32768) ? 32768 : 16384
    const stamps = files.map(file => stamp(file,limit(file)))
    const assertCurrent = (): void => {
      assertRuntime()
      const active = currentBinding()
      if (!active || active.pairingId !== binding.pairingId || active.mobilePublicKeyRaw !== binding.mobilePublicKeyRaw
        || files.some((file, i) => stamp(file,limit(file)) !== stamps[i]) || files.some(file => stamp(file + '.tmp',limit(file)) !== 'absent')) throw Error('queue_identity_changed')
    }
    assertCurrent()
    const materials = await Promise.all(sources.map(s => s.material.read())); assertCurrent()
    let present = materials.flatMap((m, i) => m ? [{ m, i }] : [])
    const cloud = present.filter(v => sources[v.i]!.kind === 'cloud')
    if (cloud.length) {
      if (cloud.length !== 1 || cloud[0]!.m.pairingId !== binding.pairingId || cloud[0]!.m.mobilePublicKey !== binding.mobilePublicKeyRaw ||
        present.some(v => ['computerId','memberId','registrationPublicKey','memberPublicKey','memberPrivateKey'].some(k =>
          v.m[k as keyof Material] !== cloud[0]!.m[k as keyof Material]))) throw Error('queue_identity_changed')
      // A proved cloud re-pair retains old V2 evidence. Only identical desktop
      // and member keys may coexist; their old pairing generation is not used.
      present = cloud
    }
    if (present.length !== 1) throw Error('queue_registration_required')
    const { m, i } = present[0]!, registry = await sources[i]!.registry.read(); assertCurrent()
    const member = registry?.members.find(v => v.platform === 'dsh' && v.memberId === m.memberId)
    if (!registry || !member || member.pairingState !== 'active' || member.publicKey !== m.memberPublicKey
      || m.computerId !== registry.computerId || m.accountBindingId !== registry.accountBindingId
      || !registrationId(m.registrationGeneration) || m.registrationPublicKey !== registry.registrationPublicKey
      || m.pairingId !== binding.pairingId || m.mobilePublicKey !== binding.mobilePublicKeyRaw
      || !registrationId(m.accountBindingId) || !registrationId(member.keyGeneration)) throw Error('queue_identity_changed')
    const identity = Object.freeze({ accountBindingId: m.accountBindingId, computerId: m.computerId, memberId: m.memberId,
      pairingId: m.pairingId, keyGeneration: member.keyGeneration, memberPublicKey: member.publicKey })
    cached = Object.freeze({ identity, memberKey: registrationPrivateKey(m.memberPrivateKey, m.memberPublicKey), assertCurrent })
    return cached
  }
}
