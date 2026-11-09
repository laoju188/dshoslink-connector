import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { cloudFields, cloudDigest, cloudUnusedResult, cloudVerify, parseCloudDesktop, type CloudDesktop, type CloudEnvironment,
  type CloudPayload } from './cloud-pairing-contract.js'
import { registrationId, registrationPrivateKey, type ComputerRegistry } from './dsh-registration-contract.js'
import type { DshEnrollmentMaterial } from './dsh-enrollment.js'
import type { DshRegistrationMaterial } from './dsh-registration.js'
import type { CloudDesktopJournal } from './cloud-pairing-client.js'
import { parseServiceAccess } from './service-access.js'

export interface CloudDesktopRecord {
  contract: 'dshos-cloud-desktop-record-v3'
  environment: CloudEnvironment
  desktop: CloudDesktop
  registrationPrivateKey: string
  memberPrivateKey: string
  journal: CloudDesktopJournal | null
  savedReplyText: string | null
  previousReplyText?: string | null
  relayKeyId?: string
}
type LegacyMaterial = DshEnrollmentMaterial | DshRegistrationMaterial
export interface CloudLegacyIdentity {
  registry: ComputerRegistry | null
  enrollment: DshEnrollmentMaterial | null
  registration: DshRegistrationMaterial | null
  /** Unexplained old files are evidence, never an instruction to start over. */
  incomplete: boolean
}
const identityFields = ['computerId', 'registrationPrivateKey', 'registrationPublicKey', 'memberId', 'memberPrivateKey', 'memberPublicKey'] as const

export function assertCloudLegacy(record: CloudDesktopRecord, old: CloudLegacyIdentity): void {
  if (old.incomplete) throw Error('cloud_pairing_legacy_recovery_required')
  const current = { ...record.desktop, registrationPrivateKey: record.registrationPrivateKey, memberPrivateKey: record.memberPrivateKey }
  for (const material of [old.enrollment, old.registration]) {
    if (material && identityFields.some(field => current[field] !== material[field])) throw Error('cloud_pairing_original_identity_changed')
  }
  const registry = old.registry
  if (registry && (registry.computerId !== current.computerId || registry.registrationPublicKey !== current.registrationPublicKey ||
    registry.registrationPrivateKey !== current.registrationPrivateKey)) throw Error('cloud_pairing_original_identity_changed')
  const member = registry?.members.find(m => m.platform === 'dsh')
  if (member && (member.memberId !== current.memberId || member.publicKey !== current.memberPublicKey))
    throw Error('cloud_pairing_original_identity_changed')
}
export function newCloudDesktopRecord(old: CloudLegacyIdentity, name: string, environment: CloudEnvironment): CloudDesktopRecord {
  if (old.incomplete) throw Error('cloud_pairing_legacy_recovery_required')
  const material: LegacyMaterial | null = old.enrollment ?? old.registration
  if (!material && old.registry?.members.some(m => m.platform === 'dsh')) throw Error('cloud_pairing_original_key_missing')
  const fresh = () => { const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }); return { seed: jwk.d!, pub: jwk.x! } }
  const reg = material ? { seed: material.registrationPrivateKey, pub: material.registrationPublicKey }
    : old.registry ? { seed: old.registry.registrationPrivateKey, pub: old.registry.registrationPublicKey } : fresh()
  const member = material ? { seed: material.memberPrivateKey, pub: material.memberPublicKey } : fresh()
  const record: CloudDesktopRecord = { contract: 'dshos-cloud-desktop-record-v3', environment,
    desktop: { computerId: material?.computerId ?? old.registry?.computerId ?? randomBytes(16).toString('base64url'),
      registrationPublicKey: reg.pub, memberId: material?.memberId ?? randomBytes(16).toString('base64url'),
      memberPublicKey: member.pub, pairingId: randomBytes(16).toString('base64url'), name },
    registrationPrivateKey: reg.seed, memberPrivateKey: member.seed, journal: null, savedReplyText: null }
  parseCloudDesktop(record.desktop); assertCloudLegacy(record, old); return record
}
export function cloudHistoricalReply(text: string, trust: {keyId: string; publicKey: string}, record: CloudDesktopRecord): CloudPayload {
  if (Buffer.byteLength(text) > 16_384) throw Error('cloud_pairing_record_capacity')
  const value = JSON.parse(text)
  if (JSON.stringify(value) !== text || !cloudFields(value, ['contract', 'product', 'environment', 'keyId', 'requestId', 'requestDigest', 'serverTime', 'result', 'signature']))
    throw Error('cloud_pairing_record_reply')
  const { signature, ...reply } = value
  if (reply.contract !== 'dshos-cloud-pairing-v3' || reply.product !== 'harmony-dsh' || reply.environment !== record.environment ||
    reply.keyId !== trust.keyId || !registrationId(reply.requestId) || !registrationId(reply.requestDigest, 32) ||
    !Number.isSafeInteger(reply.serverTime) || (reply.serverTime as number) < 0 ||
    !cloudVerify('RESPONSE', reply, trust.publicKey, signature)) throw Error('cloud_pairing_record_reply')
  const status = reply.result as CloudPayload
  if(status?.state==='unused') {
    if(!cloudUnusedResult(status,'desktop',record.desktop.registrationPublicKey,status.attemptId as string,record.desktop))
      throw Error('cloud_pairing_record_scope');
    return status;
  }
  if (!status || cloudDigest(status.desktop) !== cloudDigest(record.desktop) || !registrationId(status.mobilePublicKey,32) ||
    !registrationId(status.attemptId) || !Number.isSafeInteger(status.revision) || (status.revision as number) < 1)
    throw Error('cloud_pairing_record_scope')
  return status
}
/** Historical evidence only; consumers still need fresh service proof and AUTH. */
export function validCloudDesktopRecord(value: unknown, trust: {keyId: string; publicKey: string}): value is CloudDesktopRecord {
  try {
    const optional=value&&typeof value==='object'?['previousReplyText','relayKeyId'].filter(k=>Object.hasOwn(value,k)):[]
    if (!cloudFields(value, ['contract','environment','desktop','registrationPrivateKey','memberPrivateKey','journal','savedReplyText',...optional]) ||
      value.contract !== 'dshos-cloud-desktop-record-v3' || !['PRODUCTION','SANDBOX'].includes(value.environment as string)) return false
    const record = value as unknown as CloudDesktopRecord, desktop = parseCloudDesktop(record.desktop)
    if(record.relayKeyId!==undefined&&(!registrationId(record.relayKeyId,32)||!record.savedReplyText))return false
    registrationPrivateKey(record.registrationPrivateKey, desktop.registrationPublicKey)
    registrationPrivateKey(record.memberPrivateKey, desktop.memberPublicKey)
    if (record.previousReplyText !== undefined && record.previousReplyText !== null) {
      const previous=cloudHistoricalReply(record.previousReplyText,trust,record)
      if (!['cancelled','rejected','expired','unused'].includes(previous.state as string) || previous.binding !== null ||
        record.journal?.attemptId === previous.attemptId) return false
    }
    const journal = record.journal
    if (!journal) return journal === null && record.savedReplyText === null
    const journalOptional=Object.hasOwn(journal,'claimRefusal')?['claimRefusal']:[]
    if (!cloudFields(journal, ['contract','claimId','attemptId','revision','startedAt','last','replyText','pending',...journalOptional]) ||
      journal.contract !== 'dshos-cloud-desktop-journal-v3' || !registrationId(journal.claimId) ||
      journal.attemptId !== null && !registrationId(journal.attemptId) || !Number.isSafeInteger(journal.revision) || journal.revision < 0 ||
      !Number.isSafeInteger(journal.startedAt) || journal.startedAt < 0) return false
    if (journalOptional.length && (parseServiceAccess(JSON.stringify(journal.claimRefusal)).mode === 'normal' ||
      journal.pending?.operation !== 'claim' || journal.attemptId !== null || journal.last !== null || journal.replyText !== null)) return false
    if (journal.pending) {
      const { signature, ...request } = journal.pending
      if (request.contract !== 'dshos-cloud-pairing-v3' || request.product !== 'harmony-dsh' || request.environment !== record.environment ||
        request.role !== 'desktop' || request.publicKey !== desktop.registrationPublicKey ||
        request.attemptId !== (journal.attemptId ?? journal.claimId) ||
        !cloudVerify('REQUEST', request, desktop.registrationPublicKey, signature)) return false
    }
    if (journal.last === null) return journal.replyText === null && journal.revision === 0 && journal.attemptId === null && record.savedReplyText === null
    if (!journal.replyText) return false
    const last = cloudHistoricalReply(journal.replyText, trust, record)
    if (cloudDigest(last) !== cloudDigest(journal.last) || last.attemptId !== journal.attemptId || last.revision !== journal.revision) return false
    if (record.savedReplyText !== null) {
      const saved = cloudHistoricalReply(record.savedReplyText, trust, record)
      if (!['registered','paired'].includes(saved.state as string) || !saved.binding || saved.attemptId !== journal.attemptId ||
        (saved.revision as number) > journal.revision || last.binding !== null && cloudDigest(saved.binding) !== cloudDigest(last.binding) ||
        last.binding === null && last.state !== 'revoked') return false
    }
    return true
  } catch { return false }
}
export function cloudDesktopTransition(old: CloudDesktopRecord | null, next: CloudDesktopRecord): boolean {
  if (!old) return next.journal === null && next.savedReplyText === null
  if (old.environment !== next.environment || cloudDigest(old.desktop) !== cloudDigest(next.desktop) ||
    old.registrationPrivateKey !== next.registrationPrivateKey || old.memberPrivateKey !== next.memberPrivateKey) return false
  if (old.journal && next.journal === null) return old.savedReplyText === null && next.savedReplyText === null &&
    old.journal.pending === null && ['cancelled','rejected','expired','unused'].includes(old.journal.last?.state as string) &&
    old.journal.last?.binding === null && old.journal.replyText !== null && next.previousReplyText === old.journal.replyText
  if ((old.previousReplyText ?? null) !== (next.previousReplyText ?? null)) return false
  if (old.journal?.claimRefusal && !next.journal?.claimRefusal && !next.journal?.replyText) return false
  if(old.relayKeyId!==undefined&&next.relayKeyId!==old.relayKeyId)return false
  if (old.journal && (!next.journal || old.journal.claimId !== next.journal.claimId || old.journal.startedAt !== next.journal.startedAt ||
    old.journal.attemptId !== null && old.journal.attemptId !== next.journal.attemptId || next.journal.revision < old.journal.revision)) return false
  if (old.savedReplyText !== null && old.savedReplyText !== next.savedReplyText) return false
  return true
}
