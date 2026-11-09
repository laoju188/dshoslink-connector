import { randomBytes } from 'node:crypto'
import { registrationBytes, registrationFields, registrationId, registrationJson, registrationSign,
  registrationTime, verifyRegistrationService, type JsonRecord, type RegistrationTrust } from './dsh-registration-contract.js'

export interface LocalRegistrationIdentity {
  computerId: string; registrationPublicKey: string; registrationPrivateKey: string
  platform: 'dsh' | 'pi'; memberId: string; memberPublicKey: string
}
const REQUEST = ['contract', 'computerId', 'registrationPublicKey', 'platform', 'memberId', 'memberPublicKey', 'nonce']
function validRequest(value: unknown): value is JsonRecord {
  const withRemoval = !!value && typeof value === 'object' && (value as JsonRecord).contract === 'dshos-local-registration-status-request-v3'
  return registrationFields(value, withRemoval ? [...REQUEST, 'accountBindingId'] : REQUEST)
    && value.contract === (withRemoval ? 'dshos-local-registration-status-request-v3' : 'dshos-local-registration-status-request-v2')
    && (!withRemoval || value.platform === 'dsh' && registrationId(value.accountBindingId))
    && registrationId(value.computerId) && registrationId(value.memberId)
    && registrationId(value.registrationPublicKey, 32) && registrationId(value.memberPublicKey, 32)
    && registrationId(value.nonce, 32) && ['dsh', 'pi'].includes(value.platform as string)
    && value.registrationPublicKey !== value.memberPublicKey
}
export function createLocalStatusRequest(identity: LocalRegistrationIdentity, accountBindingId?: string): JsonRecord {
  const request = { contract: accountBindingId === undefined ? 'dshos-local-registration-status-request-v2' : 'dshos-local-registration-status-request-v3',
    computerId: identity.computerId,
    registrationPublicKey: identity.registrationPublicKey, platform: identity.platform, memberId: identity.memberId,
    memberPublicKey: identity.memberPublicKey, nonce: randomBytes(32).toString('base64url'),
    ...(accountBindingId === undefined ? {} : { accountBindingId }) }
  if (!validRequest(request)) throw Error('local_status_identity')
  return { ...request, registrationSignature: registrationSign('REGISTRATION/LOCAL-STATUS-REQUEST', request,
    identity.registrationPrivateKey, identity.registrationPublicKey) }
}

// A signed absence is only a retirement input. Callers must still fence the completed local
// identity and persist a retirement intent before changing any protected state.
export function parseLocalStatus(bytes: Uint8Array, sent: JsonRecord, trust: RegistrationTrust,
  timing: { startedAt: number; now: number; elapsedMs: number }): { retired: boolean; proof: JsonRecord } {
  const { registrationSignature, ...request } = sent
  if (!registrationId(registrationSignature, 64) || !validRequest(request)) throw Error('local_status_request')
  const value = registrationJson(bytes, 4096)
  const withRemoval = request.contract === 'dshos-local-registration-status-request-v3'
  if (!registrationFields(value, ['contract', 'keyId', 'request', 'computer', 'members', 'issuedAt', 'expiresAt',
    ...(withRemoval ? ['removal'] : []), 'signature'])
    || value.contract !== (withRemoval ? 'dshos-local-registration-status-result-v3' : 'dshos-local-registration-status-result-v2')
    || !registrationBytes(value.request).equals(registrationBytes(request))) throw Error('local_status_scope')
  verifyRegistrationService('REGISTRATION/LOCAL-STATUS-RESULT', value, trust)
  registrationTime(value, timing.now, 30000)
  if (!Number.isSafeInteger(timing.startedAt) || timing.startedAt < 0 || timing.now < timing.startedAt
    || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs < 0 || timing.elapsedMs >= 2000
    || timing.now - timing.startedAt >= 2000) throw Error('local_status_deadline')
  if (!Array.isArray(value.members)) throw Error('local_status_format')
  if (withRemoval && value.removal !== null && (!registrationFields(value.removal, ['registrationGeneration', 'removedAt'])
    || !registrationId(value.removal.registrationGeneration) || !Number.isSafeInteger(value.removal.removedAt)
    || (value.removal.removedAt as number) < 0 || (value.removal.removedAt as number) > (value.issuedAt as number)))
    throw Error('local_status_removal')
  if (value.computer === null) {
    if (value.members.length) throw Error('local_status_format')
    return { retired: !withRemoval || value.removal !== null, proof: value }
  }
  const parent = value.computer
  if (!registrationFields(parent, ['computerId', 'accountBindingId', 'registrationGeneration', 'registrationPublicKey', 'everDual'])
    || parent.computerId !== request.computerId || parent.registrationPublicKey !== request.registrationPublicKey
    || withRemoval && parent.accountBindingId !== request.accountBindingId
    || !registrationId(parent.accountBindingId) || !registrationId(parent.registrationGeneration)
    || typeof parent.everDual !== 'boolean' || value.members.length < 1 || value.members.length > 2)
    throw Error('local_status_format')
  let present = false
  const platforms = new Set<string>(), ids = new Set<string>(), keys = new Set<string>()
  for (const member of value.members) {
    if (!registrationFields(member, ['platform', 'memberId', 'memberPublicKey', 'keyGeneration'])
      || !['dsh', 'pi'].includes(member.platform as string) || !registrationId(member.memberId)
      || !registrationId(member.memberPublicKey, 32) || !registrationId(member.keyGeneration)
      || member.memberPublicKey === parent.registrationPublicKey || platforms.has(member.platform as string)
      || ids.has(member.memberId) || keys.has(member.memberPublicKey)) throw Error('local_status_format')
    platforms.add(member.platform as string); ids.add(member.memberId); keys.add(member.memberPublicKey)
    if (member.platform === request.platform) {
      if (member.memberId !== request.memberId || member.memberPublicKey !== request.memberPublicKey)
        throw Error('local_status_conflict')
      present = true
    } else if (member.memberId === request.memberId || member.memberPublicKey === request.memberPublicKey) {
      throw Error('local_status_conflict')
    }
  }
  if (value.members.length === 2 && !parent.everDual) throw Error('local_status_format')
  if (withRemoval && present && value.removal !== null) throw Error('local_status_removal')
  return { retired: !present && (!withRemoval || value.removal !== null), proof: value }
}
