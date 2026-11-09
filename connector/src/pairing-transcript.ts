import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const SESSION_ID_BYTES = 16
const INVITE_SECRET_BYTES = 32
const NONCE_BYTES = 16
const SHA256_BYTES = 32

export type PairingDomainName =
  | 'START'
  | 'CHALLENGE'
  | 'SAS'
  | 'CREDENTIAL'
  | 'ACCEPT'
  | 'COMMIT'
  | 'COMPLETE'
  | 'AUTH'

interface InviteProofInput {
  inviteSecret: Uint8Array
  sessionId: Uint8Array
  qrHash: Uint8Array
  clientNonce: Uint8Array
}

interface ServerTranscriptInput extends InviteProofInput {
  serverNonce: Uint8Array
}

interface CredentialTranscriptInput extends ServerTranscriptInput {
  mobilePublicKeyRaw: Uint8Array
}

interface AcceptProofInput extends CredentialTranscriptInput {
  pairingId: Uint8Array
}

interface CommitTranscriptInput extends ServerTranscriptInput {
  pairingId: Uint8Array
}

interface CompleteProofInput {
  inviteSecret: Uint8Array
  sessionId: Uint8Array
  qrHash: Uint8Array
  pairingId: Uint8Array
}

export interface AuthTranscriptInput {
  pairingId: Uint8Array
  storedServerPin: Uint8Array
  clientNonce: Uint8Array
  serverChallenge: Uint8Array
  connectionGeneration: Uint8Array
}

function invalidTranscriptInput(): never {
  throw new TypeError('Invalid Pairing V1 transcript input')
}

function bytesView(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function exactView(value: Uint8Array, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    invalidTranscriptInput()
  }
  return bytesView(value)
}

function hmacSha256(inviteSecret: Uint8Array, parts: readonly Uint8Array[]): Buffer {
  const key = Buffer.from(exactView(inviteSecret, INVITE_SECRET_BYTES))
  try {
    const hmac = createHmac('sha256', key)
    for (const part of parts) hmac.update(part)
    return hmac.digest()
  } finally {
    key.fill(0)
  }
}

export function pairingDomain(name: PairingDomainName): Buffer {
  if (![
    'START', 'CHALLENGE', 'SAS', 'CREDENTIAL', 'ACCEPT', 'COMMIT', 'COMPLETE', 'AUTH',
  ].includes(name)) {
    invalidTranscriptInput()
  }
  return Buffer.from(`DSHOS-LINK/PAIR-V1/${name}\0`, 'utf8')
}

export function hashPairingQr(qrPayload: string): Buffer {
  if (typeof qrPayload !== 'string' || qrPayload.length === 0) {
    invalidTranscriptInput()
  }
  return createHash('sha256').update(qrPayload, 'utf8').digest()
}

export function deriveInviteProof(input: InviteProofInput): Buffer {
  return hmacSha256(input.inviteSecret, [
    pairingDomain('START'),
    exactView(input.sessionId, SESSION_ID_BYTES),
    exactView(input.qrHash, SHA256_BYTES),
    exactView(input.clientNonce, NONCE_BYTES),
  ])
}

export function deriveServerProof(input: ServerTranscriptInput): Buffer {
  return hmacSha256(input.inviteSecret, [
    pairingDomain('CHALLENGE'),
    exactView(input.sessionId, SESSION_ID_BYTES),
    exactView(input.qrHash, SHA256_BYTES),
    exactView(input.clientNonce, NONCE_BYTES),
    exactView(input.serverNonce, NONCE_BYTES),
  ])
}

export function deriveSasDigest(input: ServerTranscriptInput): Buffer {
  return hmacSha256(input.inviteSecret, [
    pairingDomain('SAS'),
    exactView(input.sessionId, SESSION_ID_BYTES),
    exactView(input.qrHash, SHA256_BYTES),
    exactView(input.clientNonce, NONCE_BYTES),
    exactView(input.serverNonce, NONCE_BYTES),
  ])
}

export function deriveCredentialTranscript(input: CredentialTranscriptInput): Buffer {
  return Buffer.concat([
    pairingDomain('CREDENTIAL'),
    exactView(input.sessionId, SESSION_ID_BYTES),
    exactView(input.qrHash, SHA256_BYTES),
    exactView(input.clientNonce, NONCE_BYTES),
    exactView(input.serverNonce, NONCE_BYTES),
    exactView(input.mobilePublicKeyRaw, SHA256_BYTES),
  ])
}

export function deriveAcceptProof(input: AcceptProofInput): Buffer {
  const mobileKeyHash = createHash('sha256')
    .update(exactView(input.mobilePublicKeyRaw, SHA256_BYTES))
    .digest()
  try {
    return hmacSha256(input.inviteSecret, [
      pairingDomain('ACCEPT'),
      exactView(input.sessionId, SESSION_ID_BYTES),
      exactView(input.qrHash, SHA256_BYTES),
      exactView(input.clientNonce, NONCE_BYTES),
      exactView(input.serverNonce, NONCE_BYTES),
      mobileKeyHash,
      exactView(input.pairingId, SESSION_ID_BYTES),
    ])
  } finally {
    mobileKeyHash.fill(0)
  }
}

export function deriveCommitTranscript(input: CommitTranscriptInput): Buffer {
  return Buffer.concat([
    pairingDomain('COMMIT'),
    exactView(input.sessionId, SESSION_ID_BYTES),
    exactView(input.qrHash, SHA256_BYTES),
    exactView(input.clientNonce, NONCE_BYTES),
    exactView(input.serverNonce, NONCE_BYTES),
    exactView(input.pairingId, SESSION_ID_BYTES),
  ])
}

export function deriveCompleteProof(input: CompleteProofInput): Buffer {
  return hmacSha256(input.inviteSecret, [
    pairingDomain('COMPLETE'),
    exactView(input.sessionId, SESSION_ID_BYTES),
    exactView(input.qrHash, SHA256_BYTES),
    exactView(input.pairingId, SESSION_ID_BYTES),
  ])
}

export function deriveAuthTranscript(input: AuthTranscriptInput): Buffer {
  return Buffer.concat([
    pairingDomain('AUTH'),
    exactView(input.pairingId, SESSION_ID_BYTES),
    exactView(input.storedServerPin, SHA256_BYTES),
    exactView(input.clientNonce, NONCE_BYTES),
    exactView(input.serverChallenge, SHA256_BYTES),
    exactView(input.connectionGeneration, SESSION_ID_BYTES),
  ])
}

export function sasFromDigest(digest: Uint8Array): string {
  const bytes = exactView(digest, SHA256_BYTES)
  return (bytes.readUInt32BE(0) % 1_000_000).toString().padStart(6, '0')
}

export function pairingProofEquals(expected: Uint8Array, candidate: Uint8Array): boolean {
  if (
    !(expected instanceof Uint8Array) ||
    !(candidate instanceof Uint8Array) ||
    expected.byteLength !== SHA256_BYTES ||
    candidate.byteLength !== SHA256_BYTES
  ) {
    return false
  }
  return timingSafeEqual(bytesView(expected), bytesView(candidate))
}
