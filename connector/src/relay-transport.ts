import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'

export const RELAY_PROTOCOL_VERSION = 1
export const RELAY_FRAME_MAX_PLAINTEXT_BYTES = 256 * 1024
export const RELAY_DIRECTION_MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024
export const RELAY_FRAME_MAX_WIRE_BYTES = 360_000

const RELAY_ROOT_KEY_BYTES = 32
const RELAY_ROUTE_ID_BYTES = 16
const RELAY_NONCE_BYTES = 32
const RELAY_PUBLIC_KEY_DER_BYTES = 44
const RELAY_PROOF_BYTES = 32
const RELAY_SESSION_ID_BYTES = 16
const RELAY_AUTH_TAG_BYTES = 16
const RELAY_CLOSE_MAX_PLAINTEXT_BYTES = 256
const RELAY_MAX_SEQUENCE = 0xffff_ffff
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const HELLO_PATTERN = /^\{"type":"relay_hello","protocolVersion":1,"role":"(mobile|connector)","routeId":"([A-Za-z0-9_-]+)","ephemeralPublicKey":"([A-Za-z0-9_-]+)","nonce":"([A-Za-z0-9_-]+)","proof":"([A-Za-z0-9_-]+)"\}$/
const FRAME_PATTERN = /^\{"type":"relay_frame","protocolVersion":1,"sessionId":"([A-Za-z0-9_-]+)","direction":"(mobile_to_connector|connector_to_mobile)","sequence":(0|[1-9][0-9]*),"kind":"(data|close)","ciphertext":"([A-Za-z0-9_-]+)","authTag":"([A-Za-z0-9_-]+)"\}$/

export type RelayRole = 'mobile' | 'connector'
export type RelayDirection = 'mobile_to_connector' | 'connector_to_mobile'
export type RelayFrameKind = 'data' | 'close'

export interface RelayEphemeralKeyPair {
  readonly privateKey: KeyObject
  readonly publicKeyDer: Uint8Array
}

export interface RelayHelloState {
  readonly role: RelayRole
  readonly routeId: Uint8Array
  readonly nonce: Uint8Array
  readonly publicKeyDer: Uint8Array
  readonly privateKey: KeyObject
  readonly text: string
}

export interface RelaySessionSecrets {
  readonly sessionId: Uint8Array
  readonly mobileToConnectorKey: Uint8Array
  readonly connectorToMobileKey: Uint8Array
}

interface ParsedRelayHello {
  readonly role: RelayRole
  readonly routeId: Uint8Array
  readonly publicKeyDer: Uint8Array
  readonly nonce: Uint8Array
  readonly proof: Uint8Array
  readonly text: string
}

export class RelayProtocolError extends Error {}

function invalid(message: string = 'Invalid Relay Transport V1 input'): never {
  throw new RelayProtocolError(message)
}

function requireBytes(value: Uint8Array, expectedLength: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    invalid()
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value: string, expectedLength: number): Uint8Array {
  if (!BASE64URL_PATTERN.test(value)) {
    invalid()
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== expectedLength || decoded.toString('base64url') !== value) {
    invalid()
  }
  return new Uint8Array(decoded)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

function helloProofInput(role: RelayRole, routeId: Uint8Array,
  publicKeyDer: Uint8Array, nonce: Uint8Array): Buffer {
  return Buffer.from(
    `DSHOS-LINK/RELAY-V1/HELLO\0${role}\0${encodeBase64Url(routeId)}\0` +
    `${encodeBase64Url(publicKeyDer)}\0${encodeBase64Url(nonce)}`,
    'utf8',
  )
}

function createHelloProof(rootKey: Uint8Array, role: RelayRole, routeId: Uint8Array,
  publicKeyDer: Uint8Array, nonce: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', rootKey)
    .update(helloProofInput(role, routeId, publicKeyDer, nonce))
    .digest())
}

function canonicalHello(role: RelayRole, routeId: Uint8Array,
  publicKeyDer: Uint8Array, nonce: Uint8Array, proof: Uint8Array): string {
  return JSON.stringify({
    type: 'relay_hello',
    protocolVersion: RELAY_PROTOCOL_VERSION,
    role,
    routeId: encodeBase64Url(routeId),
    ephemeralPublicKey: encodeBase64Url(publicKeyDer),
    nonce: encodeBase64Url(nonce),
    proof: encodeBase64Url(proof),
  })
}

export function generateRelayEphemeralKeyPair(): RelayEphemeralKeyPair {
  const generated = generateKeyPairSync('x25519')
  return {
    privateKey: generated.privateKey,
    publicKeyDer: new Uint8Array(generated.publicKey.export({ type: 'spki', format: 'der' })),
  }
}

export function importRelayPrivateKey(privateKeyDer: Uint8Array): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(privateKeyDer), type: 'pkcs8', format: 'der' })
  if (key.asymmetricKeyType !== 'x25519') {
    invalid()
  }
  return key
}

export function createRelayHello(role: RelayRole, rootKey: Uint8Array,
  routeId: Uint8Array, keyPair: RelayEphemeralKeyPair = generateRelayEphemeralKeyPair(),
  nonce: Uint8Array = randomBytes(RELAY_NONCE_BYTES)): RelayHelloState {
  requireBytes(rootKey, RELAY_ROOT_KEY_BYTES)
  requireBytes(routeId, RELAY_ROUTE_ID_BYTES)
  requireBytes(keyPair.publicKeyDer, RELAY_PUBLIC_KEY_DER_BYTES)
  requireBytes(nonce, RELAY_NONCE_BYTES)
  if (role !== 'mobile' && role !== 'connector') {
    invalid()
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.from(keyPair.publicKeyDer), type: 'spki', format: 'der',
    })
    const derivedPublicKey = createPublicKey(keyPair.privateKey)
      .export({ type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'x25519'
      || keyPair.privateKey.asymmetricKeyType !== 'x25519'
      || !sameBytes(keyPair.publicKeyDer, derivedPublicKey)) {
      invalid()
    }
  } catch {
    invalid()
  }
  const proof = createHelloProof(rootKey, role, routeId, keyPair.publicKeyDer, nonce)
  return Object.freeze({
    role,
    routeId: new Uint8Array(routeId),
    nonce: new Uint8Array(nonce),
    publicKeyDer: new Uint8Array(keyPair.publicKeyDer),
    privateKey: keyPair.privateKey,
    text: canonicalHello(role, routeId, keyPair.publicKeyDer, nonce, proof),
  })
}

function parseRelayHello(text: string): ParsedRelayHello {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024) {
    invalid()
  }
  const match = HELLO_PATTERN.exec(text)
  if (match === null) {
    invalid()
  }
  const role = match[1] as RelayRole
  const routeId = decodeBase64Url(match[2], RELAY_ROUTE_ID_BYTES)
  const publicKeyDer = decodeBase64Url(match[3], RELAY_PUBLIC_KEY_DER_BYTES)
  const nonce = decodeBase64Url(match[4], RELAY_NONCE_BYTES)
  const proof = decodeBase64Url(match[5], RELAY_PROOF_BYTES)
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyDer), type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'x25519') {
      invalid()
    }
  } catch {
    invalid()
  }
  if (canonicalHello(role, routeId, publicKeyDer, nonce, proof) !== text) {
    invalid()
  }
  return { role, routeId, publicKeyDer, nonce, proof, text }
}

export function verifyRelayHello(text: string, expectedRole: RelayRole, rootKey: Uint8Array,
  expectedRouteId: Uint8Array): void {
  requireBytes(rootKey, RELAY_ROOT_KEY_BYTES)
  requireBytes(expectedRouteId, RELAY_ROUTE_ID_BYTES)
  const parsed = parseRelayHello(text)
  const expectedProof = createHelloProof(rootKey, parsed.role, parsed.routeId,
    parsed.publicKeyDer, parsed.nonce)
  if (parsed.role !== expectedRole || !sameBytes(parsed.routeId, expectedRouteId)
    || !sameBytes(parsed.proof, expectedProof)) {
    invalid()
  }
}

export function deriveRelaySessionSecrets(local: RelayHelloState, peerText: string,
  rootKey: Uint8Array): RelaySessionSecrets {
  requireBytes(rootKey, RELAY_ROOT_KEY_BYTES)
  const expectedPeerRole: RelayRole = local.role === 'mobile' ? 'connector' : 'mobile'
  verifyRelayHello(peerText, expectedPeerRole, rootKey, local.routeId)
  const peer = parseRelayHello(peerText)
  const mobileHello = local.role === 'mobile' ? local.text : peer.text
  const connectorHello = local.role === 'connector' ? local.text : peer.text
  const salt = createHmac('sha256', rootKey)
    .update('DSHOS-LINK/RELAY-V1/TRANSCRIPT\0', 'utf8')
    .update(mobileHello, 'utf8')
    .update('\0', 'utf8')
    .update(connectorHello, 'utf8')
    .digest()
  let sharedSecret: Buffer
  try {
    const peerPublicKey = createPublicKey({
      key: Buffer.from(peer.publicKeyDer),
      type: 'spki',
      format: 'der',
    })
    sharedSecret = diffieHellman({ privateKey: local.privateKey, publicKey: peerPublicKey })
  } catch {
    invalid()
  }
  try {
    const material = Buffer.from(hkdfSync('sha256', sharedSecret, salt,
      Buffer.from('DSHOS-LINK/RELAY-V1/TRAFFIC\0', 'utf8'), 64))
    const sessionId = createHash('sha256')
      .update('DSHOS-LINK/RELAY-V1/SESSION-ID\0', 'utf8')
      .update(salt)
      .digest()
      .subarray(0, RELAY_SESSION_ID_BYTES)
    const result: RelaySessionSecrets = {
      sessionId: new Uint8Array(sessionId),
      mobileToConnectorKey: new Uint8Array(material.subarray(0, 32)),
      connectorToMobileKey: new Uint8Array(material.subarray(32, 64)),
    }
    material.fill(0)
    return result
  } finally {
    sharedSecret.fill(0)
    salt.fill(0)
  }
}

function oppositeDirection(direction: RelayDirection): RelayDirection {
  return direction === 'mobile_to_connector' ? 'connector_to_mobile' : 'mobile_to_connector'
}

function frameNonce(direction: RelayDirection, sequence: number): Buffer {
  const nonce = Buffer.alloc(12)
  nonce[0] = 0x44
  nonce[1] = 0x53
  nonce[2] = 0x48
  nonce[3] = direction === 'mobile_to_connector' ? 0x4d : 0x43
  nonce.writeBigUInt64BE(BigInt(sequence), 4)
  return nonce
}

function frameAad(sessionId: Uint8Array, direction: RelayDirection, sequence: number,
  kind: RelayFrameKind): Buffer {
  return Buffer.from(
    `DSHOS-LINK/RELAY-V1/FRAME\0${encodeBase64Url(sessionId)}\0${direction}\0${sequence}\0${kind}`,
    'utf8',
  )
}

function assertPlaintextLength(kind: RelayFrameKind, length: number): void {
  const maximum = kind === 'data' ? RELAY_FRAME_MAX_PLAINTEXT_BYTES : RELAY_CLOSE_MAX_PLAINTEXT_BYTES
  if (!Number.isInteger(length) || length < 1 || length > maximum) {
    invalid()
  }
}

export class RelayCipherState {
  private readonly sessionId: Uint8Array
  private readonly sendKey: Buffer
  private readonly receiveKey: Buffer
  private readonly sendDirection: RelayDirection
  private sendSequence = 0
  private receiveSequence = 0
  private sentBytes = 0
  private receivedBytes = 0
  private sendClosed = false
  private receiveClosed = false
  private disposed = false

  constructor(sessionId: Uint8Array, sendKey: Uint8Array, receiveKey: Uint8Array,
    sendDirection: RelayDirection) {
    requireBytes(sessionId, RELAY_SESSION_ID_BYTES)
    requireBytes(sendKey, 32)
    requireBytes(receiveKey, 32)
    if (sendDirection !== 'mobile_to_connector' && sendDirection !== 'connector_to_mobile') {
      invalid()
    }
    this.sessionId = new Uint8Array(sessionId)
    this.sendKey = Buffer.from(sendKey)
    this.receiveKey = Buffer.from(receiveKey)
    this.sendDirection = sendDirection
  }

  encrypt(plaintext: Uint8Array, kind: RelayFrameKind = 'data'): string {
    if (this.disposed || this.sendClosed || !(plaintext instanceof Uint8Array)
      || this.sendSequence > RELAY_MAX_SEQUENCE || (kind !== 'data' && kind !== 'close')) {
      invalid()
    }
    assertPlaintextLength(kind, plaintext.byteLength)
    if (this.sentBytes + plaintext.byteLength > RELAY_DIRECTION_MAX_PLAINTEXT_BYTES) {
      invalid()
    }
    const sequence = this.sendSequence
    const cipher = createCipheriv('aes-256-gcm', this.sendKey,
      frameNonce(this.sendDirection, sequence), { authTagLength: RELAY_AUTH_TAG_BYTES })
    cipher.setAAD(frameAad(this.sessionId, this.sendDirection, sequence, kind))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    const frame = JSON.stringify({
      type: 'relay_frame',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      sessionId: encodeBase64Url(this.sessionId),
      direction: this.sendDirection,
      sequence,
      kind,
      ciphertext: ciphertext.toString('base64url'),
      authTag: authTag.toString('base64url'),
    })
    if (Buffer.byteLength(frame, 'utf8') > RELAY_FRAME_MAX_WIRE_BYTES) {
      invalid()
    }
    this.sendSequence++
    this.sentBytes += plaintext.byteLength
    this.sendClosed = kind === 'close'
    return frame
  }

  decrypt(frame: string): { readonly kind: RelayFrameKind; readonly plaintext: Uint8Array } {
    if (this.disposed || this.receiveClosed || typeof frame !== 'string'
      || Buffer.byteLength(frame, 'utf8') > RELAY_FRAME_MAX_WIRE_BYTES) {
      invalid()
    }
    const match = FRAME_PATTERN.exec(frame)
    if (match === null) {
      invalid()
    }
    const sessionId = decodeBase64Url(match[1], RELAY_SESSION_ID_BYTES)
    const direction = match[2] as RelayDirection
    const sequence = Number(match[3])
    const kind = match[4] as RelayFrameKind
    if (!Number.isSafeInteger(sequence) || sequence > RELAY_MAX_SEQUENCE
      || sequence !== this.receiveSequence || direction !== oppositeDirection(this.sendDirection)
      || !sameBytes(sessionId, this.sessionId)) {
      invalid()
    }
    const ciphertext = decodeBase64Url(match[5], Buffer.from(match[5], 'base64url').byteLength)
    const authTag = decodeBase64Url(match[6], RELAY_AUTH_TAG_BYTES)
    assertPlaintextLength(kind, ciphertext.byteLength)
    if (this.receivedBytes + ciphertext.byteLength > RELAY_DIRECTION_MAX_PLAINTEXT_BYTES) {
      invalid()
    }
    let plaintext: Buffer
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.receiveKey,
        frameNonce(direction, sequence), { authTagLength: RELAY_AUTH_TAG_BYTES })
      decipher.setAAD(frameAad(this.sessionId, direction, sequence, kind))
      decipher.setAuthTag(authTag)
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      invalid()
    }
    this.receiveSequence++
    this.receivedBytes += plaintext.byteLength
    this.receiveClosed = kind === 'close'
    return { kind, plaintext: new Uint8Array(plaintext) }
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true
      this.sendKey.fill(0)
      this.receiveKey.fill(0)
      this.sessionId.fill(0)
    }
  }
}

export function createRelayCipherState(role: RelayRole,
  secrets: RelaySessionSecrets): RelayCipherState {
  if (role === 'mobile') {
    return new RelayCipherState(secrets.sessionId, secrets.mobileToConnectorKey,
      secrets.connectorToMobileKey, 'mobile_to_connector')
  }
  if (role === 'connector') {
    return new RelayCipherState(secrets.sessionId, secrets.connectorToMobileKey,
      secrets.mobileToConnectorKey, 'connector_to_mobile')
  }
  return invalid()
}
