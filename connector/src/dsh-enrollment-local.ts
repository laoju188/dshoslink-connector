// Historical record decoder only. New enrollment uses the cloud pairing-code flow.
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { registrationFields as fields, registrationId as id, registrationJson as json,
  type JsonRecord } from './dsh-registration-contract.js'

export const DSH_ENROLLMENT_PREFIX = '/dshos/v2/enrollment/'
export const DSH_ENROLLMENT_QR = 'DSHOSLINK-DSH-ENROLL-V2.'
export const enrollmentHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64url')
export function enrollmentInvitation(text: string): JsonRecord {
  if (typeof text !== 'string' || text.length > 2048 || !text.startsWith(DSH_ENROLLMENT_QR)) throw Error('enrollment_format')
  const raw = text.slice(DSH_ENROLLMENT_QR.length), decoded = Buffer.from(raw, 'base64url')
  if (decoded.toString('base64url') !== raw) throw Error('enrollment_format')
  const v = json(decoded, 1536), i = v.identity
  if (!fields(v, ['v', 'host', 'port', 'bootstrapPort', 'sid', 'secret', 'exp', 'pin', 'identity']) || v.v !== 2
    || typeof v.host !== 'string' || isIP(v.host) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(v.host)
    || ![v.port, v.bootstrapPort].every(p => Number.isInteger(p) && (p as number) > 0 && (p as number) <= 65535) || v.port === v.bootstrapPort
    || !id(v.sid) || !id(v.secret, 32) || !id(v.pin, 32) || !Number.isSafeInteger(v.exp) || (v.exp as number) < 120000
    || !fields(i, ['computerId', 'accountBindingId', 'registrationGeneration', 'registrationPublicKey', 'memberId', 'memberPublicKey', 'pairingId'])
    || !['computerId', 'memberId', 'pairingId'].every(k => id(i[k]))
    || !['registrationPublicKey', 'memberPublicKey'].every(k => id(i[k], 32)) || i.registrationPublicKey === i.memberPublicKey
    || !(i.accountBindingId === null && i.registrationGeneration === null || id(i.accountBindingId) && id(i.registrationGeneration))) throw Error('enrollment_format')
  return v
}
