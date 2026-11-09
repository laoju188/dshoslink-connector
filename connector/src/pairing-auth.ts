import {
  createPublicKey,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { deriveAuthTranscript } from './pairing-transcript.js'
import { type PairingTrustRecord, type PairingTrustStore } from './pairing-trust-store.js'

const PAIRING_ID_BYTES = 16
const CLIENT_NONCE_BYTES = 16
const SERVER_PIN_BYTES = 32
const SERVER_CHALLENGE_BYTES = 32
const CONNECTION_GENERATION_BYTES = 16
const CONNECTION_TOKEN_BYTES = 32
const SIGNATURE_BYTES = 64
const CHALLENGE_TTL_MS = 30_000
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export interface PairingAuthenticationDependencies {
  // Capture an optional observer when this challenge starts, never look up a
  // newer window when its signed response arrives. This has no auth authority.
  readonly observeChallenge?: (pairingId: string) => (() => void) | undefined
  readonly now?: () => number
  readonly randomBytes?: (size: number) => Uint8Array
}

export type PairingAuthenticationStartResult =
  | {
    readonly ok: true
    readonly pairingId: Buffer
    readonly clientNonce: Buffer
    readonly serverChallenge: Buffer
    readonly connectionGeneration: Buffer
  }
  | { readonly ok: false }

export type PairingAuthenticationResponseResult =
  | {
    readonly ok: true
    readonly pairingId: Buffer
    readonly connectionGeneration: Buffer
    readonly connectionToken: Buffer
  }
  | { readonly ok: false }

export interface PairingAuthorizationBinding {
  readonly pairingId: string
  readonly mobilePublicKeyRaw: string
}

interface PendingChallenge {
  readonly record: PairingTrustRecord
  readonly pairingId: Buffer
  readonly clientNonce: Buffer
  readonly serverChallenge: Buffer
  readonly connectionGeneration: Buffer
  readonly issuedAt: number
  readonly onAuthenticated?: () => void
}

interface ActiveAuthorization {
  readonly record: PairingTrustRecord
  readonly connectionGeneration: Buffer
  readonly connectionToken: Buffer
}

function invalidAuthenticationInput(): never {
  throw new TypeError('Invalid Pairing V1 authentication input')
}

function bytesView(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

function exactView(value: Uint8Array, length: number): Buffer | undefined {
  return value instanceof Uint8Array && value.byteLength === length ? bytesView(value) : undefined
}

function fixedEqual(expected: Uint8Array, actual: Uint8Array | undefined): boolean {
  return actual !== undefined
    && expected.byteLength === actual.byteLength
    && timingSafeEqual(bytesView(expected), bytesView(actual))
}

function decodeCanonical(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === length && decoded.toString('base64url') === value ? decoded : undefined
}

function sameRecord(left: PairingTrustRecord, right: PairingTrustRecord): boolean {
  return left.pairingVersion === right.pairingVersion
    && left.pairingId === right.pairingId
    && left.mobilePublicKeyRaw === right.mobilePublicKeyRaw
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.status === right.status
}

function copyRecord(record: PairingTrustRecord): PairingTrustRecord {
  return {
    pairingVersion: record.pairingVersion,
    pairingId: record.pairingId,
    mobilePublicKeyRaw: record.mobilePublicKeyRaw,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
  }
}

/**
 * Pure in-memory Pairing V1 authentication core. It owns only outstanding
 * challenges and connection tokens; routing, HTTP parsing, and revocation UI
 * remain outside this module.
 */
export class InMemoryPairingAuthentication {
  private readonly storedServerPin: Buffer
  private readonly now: () => number
  private readonly randomBytes: (size: number) => Uint8Array
  private challenge: PendingChallenge | undefined
  private authorization: ActiveAuthorization | undefined
  private disabled = false
  private readonly observeChallenge?: PairingAuthenticationDependencies['observeChallenge']

  constructor(
    private readonly trustStore: PairingTrustStore,
    storedServerPin: Uint8Array,
    dependencies: PairingAuthenticationDependencies = {},
  ) {
    const pin = exactView(storedServerPin, SERVER_PIN_BYTES)
    if (pin === undefined) invalidAuthenticationInput()
    this.storedServerPin = Buffer.from(pin)
    this.now = dependencies.now ?? Date.now
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes
    this.observeChallenge = dependencies.observeChallenge
  }

  start(pairingId: Uint8Array, clientNonce: Uint8Array): PairingAuthenticationStartResult {
    if (this.disabled) return { ok: false }
    const acceptedAt = this.readNow()
    const pairingIdView = exactView(pairingId, PAIRING_ID_BYTES)
    const clientNonceView = exactView(clientNonce, CLIENT_NONCE_BYTES)
    if (acceptedAt === undefined || pairingIdView === undefined || clientNonceView === undefined) {
      return { ok: false }
    }
    const record = this.readActiveRecord(pairingIdView)
    if (record === undefined) return { ok: false }
    const serverChallenge = this.ownedRandom(SERVER_CHALLENGE_BYTES)
    const connectionGeneration = this.ownedRandom(CONNECTION_GENERATION_BYTES)
    if (serverChallenge === undefined || connectionGeneration === undefined || this.disabled) {
      serverChallenge?.fill(0)
      connectionGeneration?.fill(0)
      return { ok: false }
    }
    this.clearChallenge()
    let onAuthenticated: (() => void) | undefined
    try { onAuthenticated = this.observeChallenge?.(record.pairingId) } catch { /* Optional diagnostics. */ }
    this.challenge = {
      record,
      pairingId: Buffer.from(pairingIdView),
      clientNonce: Buffer.from(clientNonceView),
      serverChallenge,
      connectionGeneration,
      issuedAt: acceptedAt,
      onAuthenticated,
    }
    return this.copyChallenge(this.challenge)
  }

  respond(
    pairingId: Uint8Array,
    clientNonce: Uint8Array,
    connectionGeneration: Uint8Array,
    signature: Uint8Array,
  ): PairingAuthenticationResponseResult {
    const challenge = this.challenge
    const pairingIdView = exactView(pairingId, PAIRING_ID_BYTES)
    const clientNonceView = exactView(clientNonce, CLIENT_NONCE_BYTES)
    const generationView = exactView(connectionGeneration, CONNECTION_GENERATION_BYTES)
    const signatureView = exactView(signature, SIGNATURE_BYTES)
    const now = this.readNow()
    if (this.disabled
      || challenge === undefined
      || pairingIdView === undefined
      || clientNonceView === undefined
      || generationView === undefined
      || signatureView === undefined
      || now === undefined
      || now >= challenge.issuedAt + CHALLENGE_TTL_MS) {
      if (challenge !== undefined && now !== undefined && now >= challenge.issuedAt + CHALLENGE_TTL_MS) {
        this.clearChallenge()
      }
      return { ok: false }
    }
    if (!fixedEqual(challenge.pairingId, pairingIdView)
      || !fixedEqual(challenge.clientNonce, clientNonceView)
      || !fixedEqual(challenge.connectionGeneration, generationView)) {
      return { ok: false }
    }
    const record = this.readActiveRecord(pairingIdView)
    if (record === undefined || !sameRecord(challenge.record, record)) {
      this.clearChallenge()
      return { ok: false }
    }
    const mobilePublicKeyRaw = decodeCanonical(record.mobilePublicKeyRaw, SERVER_PIN_BYTES)
    if (mobilePublicKeyRaw === undefined) {
      this.clearChallenge()
      return { ok: false }
    }
    let verified = false
    try {
      const transcript = deriveAuthTranscript({
        pairingId: challenge.pairingId,
        storedServerPin: this.storedServerPin,
        clientNonce: challenge.clientNonce,
        serverChallenge: challenge.serverChallenge,
        connectionGeneration: challenge.connectionGeneration,
      })
      try {
        const publicKey = createPublicKey({
          key: { kty: 'OKP', crv: 'Ed25519', x: mobilePublicKeyRaw.toString('base64url') },
          format: 'jwk',
        })
        verified = verifySignature(null, transcript, publicKey, signatureView)
      } finally {
        transcript.fill(0)
      }
    } catch {
      verified = false
    } finally {
      mobilePublicKeyRaw.fill(0)
    }
    if (!verified) return { ok: false }
    const connectionToken = this.ownedRandom(CONNECTION_TOKEN_BYTES)
    if (connectionToken === undefined || this.disabled || this.challenge !== challenge) {
      connectionToken?.fill(0)
      return { ok: false }
    }
    this.clearAuthorization()
    this.clearChallenge()
    this.authorization = {
      record,
      connectionGeneration: Buffer.from(generationView),
      connectionToken,
    }
    try { challenge.onAuthenticated?.() } catch { /* Diagnostics cannot deny valid authentication. */ }
    return this.copyAuthorization(this.authorization)
  }

  authorize(authorization: unknown, connectionGeneration: unknown): boolean {
    return this.authorizePairing(authorization, connectionGeneration) !== undefined
  }

  authorizePairing(
    authorization: unknown,
    connectionGeneration: unknown,
  ): PairingAuthorizationBinding | undefined {
    const active = this.authorization
    if (this.disabled || active === undefined) return undefined
    const current = this.readActiveRecord(Buffer.from(active.record.pairingId, 'base64url'))
    if (this.disabled || this.authorization !== active
      || current === undefined || !sameRecord(active.record, current)) return undefined
    const token = this.decodeAuthorization(authorization)
    const generation = decodeCanonical(connectionGeneration, CONNECTION_GENERATION_BYTES)
    try {
      if (!fixedEqual(active.connectionToken, token)
        || !fixedEqual(active.connectionGeneration, generation)) return undefined
      return Object.freeze({
        pairingId: current.pairingId,
        mobilePublicKeyRaw: current.mobilePublicKeyRaw,
      })
    } finally {
      token?.fill(0)
      generation?.fill(0)
    }
  }

  invalidate(): void {
    if (this.disabled) return
    this.clearChallenge()
    this.clearAuthorization()
  }

  revoke(): void {
    if (this.disabled) return
    this.invalidate()
    this.disabled = true
    this.storedServerPin.fill(0)
  }

  dispose(): void {
    this.revoke()
  }

  private readActiveRecord(pairingId: Uint8Array): PairingTrustRecord | undefined {
    try {
      const record = this.trustStore.read()
      if (record?.pairingVersion !== 1 || record.status !== 'active') return undefined
      const storedPairingId = decodeCanonical(record.pairingId, PAIRING_ID_BYTES)
      const mobilePublicKeyRaw = decodeCanonical(record.mobilePublicKeyRaw, SERVER_PIN_BYTES)
      try {
        if (storedPairingId === undefined
          || mobilePublicKeyRaw === undefined
          || !fixedEqual(storedPairingId, pairingId)
          || !Number.isSafeInteger(record.createdAt)
          || !Number.isSafeInteger(record.updatedAt)
          || record.createdAt < 0
          || record.updatedAt < record.createdAt) {
          return undefined
        }
        return copyRecord(record)
      } finally {
        storedPairingId?.fill(0)
        mobilePublicKeyRaw?.fill(0)
      }
    } catch {
      return undefined
    }
  }

  private readNow(): number | undefined {
    try {
      const value = this.now()
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  private ownedRandom(size: number): Buffer | undefined {
    let generated: Uint8Array
    try {
      generated = this.randomBytes(size)
    } catch {
      return undefined
    }
    const value = generated instanceof Uint8Array && generated.byteLength === size
      ? Buffer.from(generated)
      : undefined
    if (generated instanceof Uint8Array) generated.fill(0)
    return value
  }

  private decodeAuthorization(value: unknown): Buffer | undefined {
    if (typeof value !== 'string' || !value.startsWith('DSHOSLinkV1 ')) return undefined
    return decodeCanonical(value.slice('DSHOSLinkV1 '.length), CONNECTION_TOKEN_BYTES)
  }

  private clearChallenge(): void {
    this.challenge?.pairingId.fill(0)
    this.challenge?.clientNonce.fill(0)
    this.challenge?.serverChallenge.fill(0)
    this.challenge?.connectionGeneration.fill(0)
    this.challenge = undefined
  }

  private clearAuthorization(): void {
    this.authorization?.connectionGeneration.fill(0)
    this.authorization?.connectionToken.fill(0)
    this.authorization = undefined
  }

  private copyChallenge(challenge: PendingChallenge): PairingAuthenticationStartResult {
    return {
      ok: true,
      pairingId: Buffer.from(challenge.pairingId),
      clientNonce: Buffer.from(challenge.clientNonce),
      serverChallenge: Buffer.from(challenge.serverChallenge),
      connectionGeneration: Buffer.from(challenge.connectionGeneration),
    }
  }

  private copyAuthorization(authorization: ActiveAuthorization): PairingAuthenticationResponseResult {
    return {
      ok: true,
      pairingId: Buffer.from(authorization.record.pairingId, 'base64url'),
      connectionGeneration: Buffer.from(authorization.connectionGeneration),
      connectionToken: Buffer.from(authorization.connectionToken),
    }
  }
}
