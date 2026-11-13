import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

export type JsonRecord = Record<string, unknown>
export const registrationBytes = (v: unknown): Buffer => Buffer.from(JSON.stringify(v))
export const registrationDigest = (v: unknown): string => createHash('sha256').update(registrationBytes(v)).digest('base64url')
export function registrationFields(v: unknown, names: readonly string[]): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.keys(v).join(',') === names.join(',')
}
export function registrationId(v: unknown, size = 16): v is string {
  return typeof v === 'string' && v.length === Math.ceil(size * 8 / 6) && /^[A-Za-z0-9_-]+$/.test(v)
    && Buffer.from(v, 'base64url').length === size && Buffer.from(v, 'base64url').toString('base64url') === v
}
export function registrationJson(bytes: Uint8Array, limit = 4096): JsonRecord {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > limit) throw Error('registration_format')
  const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  if (!v || typeof v !== 'object' || Array.isArray(v) || !registrationBytes(v).equals(bytes)) throw Error('registration_format')
  return v as JsonRecord
}
export function registrationTranscript(domain: string, value: unknown): Buffer {
  const bytes = registrationBytes(value), size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  return Buffer.concat([Buffer.from(`DSHOS-LINK/V2/${domain}\0`), size, bytes])
}
export function registrationPrivateKey(seed: unknown, expected: unknown): KeyObject {
  if (!registrationId(seed, 32) || !registrationId(expected, 32)) throw Error('registration_key')
  const bytes = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64url')])
  try {
    const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' })
    if (createPublicKey(key).export({ format: 'jwk' }).x !== expected) throw Error('registration_key')
    return key
  } finally { bytes.fill(0) }
}
export interface RegistrationTrust {
  storageDiagnostics?: true
  readonly keyId: string; readonly publicKey: KeyObject
  /** Local metadata from the fresh first-party HTTPS response, never a wire field. */
  readonly pairingClockOffsetMs?: number
}
export function verifyRegistrationService(domain: string, value: JsonRecord, trust: RegistrationTrust): void {
  const { signature, ...payload } = value
  if (!/^[a-z0-9-]{1,32}$/.test(trust.keyId) || value.keyId !== trust.keyId
    || trust.publicKey.type !== 'public' || trust.publicKey.asymmetricKeyType !== 'ed25519'
    || !registrationId(signature, 64)
    || !verify(null, registrationTranscript(domain, domain.endsWith('/CHALLENGE') ? value.body : payload),
      trust.publicKey, Buffer.from(signature, 'base64url'))) throw Error('registration_signature')
}
export function registrationSign(domain: string, body: unknown, seed: unknown, key: unknown): string {
  return sign(null, registrationTranscript(domain, body), registrationPrivateKey(seed, key)).toString('base64url')
}
export function registrationTime(value: JsonRecord, now: number, ttl: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || (value.issuedAt as number) < 0 || (value.expiresAt as number) - (value.issuedAt as number) !== ttl
    || now < (value.issuedAt as number) || now >= (value.expiresAt as number)) throw Error('registration_expired')
}
export interface RegistryMember { platform: 'dsh' | 'pi'; memberId: string; publicKey: string; keyGeneration: string; pairingState: 'unpaired' | 'pending' | 'active' }
export interface ComputerRegistry {
  contract: 'dshos-computer-registry-v2'; computerId: string; accountBindingId: string; registrationGeneration: string
  registrationPrivateKey: string; registrationPublicKey: string; members: RegistryMember[]
}
export function validComputerRegistry(v: unknown): v is ComputerRegistry {
  try {
    if (!registrationFields(v, ['contract', 'computerId', 'accountBindingId', 'registrationGeneration', 'registrationPrivateKey', 'registrationPublicKey', 'members'])
      || v.contract !== 'dshos-computer-registry-v2' || !['computerId', 'accountBindingId', 'registrationGeneration'].every(k => registrationId(v[k]))
      || !Array.isArray(v.members) || v.members.length < 1 || v.members.length > 2) return false
    registrationPrivateKey(v.registrationPrivateKey, v.registrationPublicKey)
    return v.members.every((m: unknown, i: number, all: unknown[]) => registrationFields(m, ['platform', 'memberId', 'publicKey', 'keyGeneration', 'pairingState'])
      && ['dsh', 'pi'].includes(m.platform as string) && registrationId(m.memberId) && registrationId(m.publicKey, 32) && registrationId(m.keyGeneration)
      && m.publicKey !== v.registrationPublicKey && ['unpaired', 'pending', 'active'].includes(m.pairingState as string)
      && (i === 0 || (all[i - 1] as RegistryMember).platform < (m.platform as string)
        && (all[i - 1] as RegistryMember).memberId !== m.memberId && (all[i - 1] as RegistryMember).publicKey !== m.publicKey))
  } catch { return false }
}
export function parseDshRegistrationChallenge(bytes: Uint8Array, trust: RegistrationTrust, now: number): JsonRecord {
  const signed = registrationJson(bytes)
  if (!registrationFields(signed, ['contract', 'keyId', 'body', 'signature'])
    || signed.contract !== 'dshos-registration-challenge-signed-v2') throw Error('registration_format')
  const b = signed.body
  if (!registrationFields(b, ['contract', 'purpose', 'requestId', 'accountBindingId', 'computerId', 'previousGeneration', 'newGeneration', 'platform',
    'memberId', 'registrationPublicKey', 'memberPublicKey', 'invitationDigest', 'mobilePublicKey', 'challenge', 'issuedAt', 'expiresAt'])
    || b.contract !== 'dshos-registration-v2' || b.platform !== 'dsh' || !['create', 'bootstrap', 'add'].includes(b.purpose as string)
    || !['requestId', 'accountBindingId', 'computerId', 'previousGeneration', 'newGeneration', 'memberId'].every(k => registrationId(b[k]))
    || !['registrationPublicKey', 'memberPublicKey', 'mobilePublicKey', 'invitationDigest', 'challenge'].every(k => registrationId(b[k], 32))
    || new Set([b.registrationPublicKey, b.memberPublicKey, b.mobilePublicKey]).size !== 3 || b.previousGeneration === b.newGeneration)
    throw Error('registration_format')
  verifyRegistrationService('REGISTRATION/CHALLENGE', signed, trust)
  registrationTime(b, now, 60000)
  return b
}
export function validDshPairingBody(b: unknown): b is JsonRecord {
  return registrationFields(b, ['contract', 'purpose', 'requestId', 'accountBindingId', 'computerId', 'memberId', 'platform', 'registrationGeneration',
    'memberKeyGeneration', 'newPairingId', 'newPairingGeneration', 'newMobilePublicKey', 'invitationDigest', 'dshBindingHash', 'challenge', 'issuedAt', 'expiresAt'])
    && b.contract === 'dshos-member-pairing-v2' && b.purpose === 'establishPairing' && b.platform === 'dsh'
    && ['requestId', 'accountBindingId', 'computerId', 'memberId', 'registrationGeneration', 'memberKeyGeneration', 'newPairingId', 'newPairingGeneration'].every(k => registrationId(b[k]))
    && ['newMobilePublicKey', 'invitationDigest', 'challenge'].every(k => registrationId(b[k], 32))
    && typeof b.dshBindingHash === 'string' && /^[a-f0-9]{64}$/.test(b.dshBindingHash)
    && Number.isSafeInteger(b.issuedAt) && (b.issuedAt as number) >= 0 && Number.isSafeInteger(b.expiresAt)
    && (b.expiresAt as number) - (b.issuedAt as number) === 60000
}
