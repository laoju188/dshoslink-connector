import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import test from 'node:test'
import {
  createRelayCipherState,
  createRelayHello,
  deriveRelaySessionSecrets,
  importRelayPrivateKey,
  RELAY_FRAME_MAX_PLAINTEXT_BYTES,
  RelayProtocolError,
  type RelayEphemeralKeyPair,
} from '../src/relay-transport.js'

const ROOT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const ROUTE_ID = Uint8Array.from({ length: 16 }, (_, index) => 0x30 + index)
const MOBILE_NONCE = Uint8Array.from({ length: 32 }, (_, index) => 0x50 + index)
const CONNECTOR_NONCE = Uint8Array.from({ length: 32 }, (_, index) => 0x70 + index)
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const MOBILE_DATA_FRAME = '{"type":"relay_frame","protocolVersion":1,' +
  '"sessionId":"m7BxtF2t0u7V1iutEzaT8g","direction":"mobile_to_connector",' +
  '"sequence":0,"kind":"data","ciphertext":"dCwxr9eejdhtsfRt",' +
  '"authTag":"x40N_B5gNlVIjw9b_59FUA"}'

function fixedKeyPair(start: number): RelayEphemeralKeyPair {
  const raw = Buffer.from(Array.from({ length: 32 }, (_, index) => start + index))
  const privateKey = importRelayPrivateKey(Buffer.concat([X25519_PKCS8_PREFIX, raw]))
  return {
    privateKey,
    publicKeyDer: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })),
  }
}

function sessions() {
  const mobile = createRelayHello('mobile', ROOT_KEY, ROUTE_ID,
    fixedKeyPair(1), MOBILE_NONCE)
  const connector = createRelayHello('connector', ROOT_KEY, ROUTE_ID,
    fixedKeyPair(33), CONNECTOR_NONCE)
  const mobileSecrets = deriveRelaySessionSecrets(mobile, connector.text, ROOT_KEY)
  const connectorSecrets = deriveRelaySessionSecrets(connector, mobile.text, ROOT_KEY)
  return { mobile, connector, mobileSecrets, connectorSecrets }
}

test('derives identical pairing-bound Relay V1 traffic secrets', () => {
  const { mobile, connector, mobileSecrets, connectorSecrets } = sessions()

  assert.deepEqual(mobileSecrets, connectorSecrets)
  assert.equal(mobile.text, '{"type":"relay_hello","protocolVersion":1,"role":"mobile",' +
    '"routeId":"MDEyMzQ1Njc4OTo7PD0-Pw",' +
    '"ephemeralPublicKey":"MCowBQYDK2VuAyEAB6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw",' +
    '"nonce":"UFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm8",' +
    '"proof":"Z-1xO9j-ndKf2J17ay0Mkr65jAAiS0PHbZuNlbw6AR0"}')
  assert.equal(Buffer.from(mobileSecrets.sessionId).toString('hex'), '9bb071b45dadd2eed5d62bad133693f2')
  assert.equal(Buffer.from(mobileSecrets.mobileToConnectorKey).toString('hex'),
    '65193dcddbc80c0be298ef99496a74523372eb61258cfb9854ed5173d8445d81')
  assert.equal(Buffer.from(mobileSecrets.connectorToMobileKey).toString('hex'),
    '4f42777d2cf6bf25ffae13dfaa24d64d6903e70e527c4fdb4fda2c8eab307e7a')
})

test('encrypts both directions and keeps close details inside ciphertext', () => {
  const { mobileSecrets, connectorSecrets } = sessions()
  const mobile = createRelayCipherState('mobile', mobileSecrets)
  const connector = createRelayCipherState('connector', connectorSecrets)
  try {
    const outgoing = mobile.encrypt(Buffer.from('读取会话', 'utf8'))
    assert.equal(outgoing, MOBILE_DATA_FRAME)
    assert.equal(outgoing.includes('读取会话'), false)
    assert.equal(Buffer.from(connector.decrypt(outgoing).plaintext).toString('utf8'), '读取会话')

    const close = connector.encrypt(Buffer.from('电脑主动关闭', 'utf8'), 'close')
    const decoded = mobile.decrypt(close)
    assert.equal(decoded.kind, 'close')
    assert.equal(Buffer.from(decoded.plaintext).toString('utf8'), '电脑主动关闭')
    assert.throws(() => connector.encrypt(Uint8Array.of(1)), RelayProtocolError)
    assert.throws(() => mobile.decrypt(close), RelayProtocolError)
  } finally {
    mobile.dispose()
    connector.dispose()
  }
})

test('rejects wrong pairing roots, route replay and altered hello fields', () => {
  const { mobile, connector } = sessions()
  const wrongRoot = new Uint8Array(ROOT_KEY)
  wrongRoot[0] ^= 1
  assert.throws(() => deriveRelaySessionSecrets(mobile, connector.text, wrongRoot), RelayProtocolError)

  const wrongRoute = new Uint8Array(ROUTE_ID)
  wrongRoute[0] ^= 1
  const replayed = createRelayHello('connector', ROOT_KEY, wrongRoute,
    fixedKeyPair(33), CONNECTOR_NONCE)
  assert.throws(() => deriveRelaySessionSecrets(mobile, replayed.text, ROOT_KEY), RelayProtocolError)
  assert.throws(() => deriveRelaySessionSecrets(mobile,
    connector.text.replace('"role":"connector"', '"role":"mobile"'), ROOT_KEY), RelayProtocolError)
})

test('rejects replay, gaps and authenticated-frame tampering without advancing state', () => {
  const { mobileSecrets, connectorSecrets } = sessions()
  const mobile = createRelayCipherState('mobile', mobileSecrets)
  const connector = createRelayCipherState('connector', connectorSecrets)
  try {
    const first = mobile.encrypt(Uint8Array.of(1))
    assert.deepEqual(connector.decrypt(first).plaintext, Uint8Array.of(1))
    assert.throws(() => connector.decrypt(first), RelayProtocolError)

    const second = mobile.encrypt(Uint8Array.of(2))
    const tampered = second.replace(/"authTag":"./, '"authTag":"A')
    assert.throws(() => connector.decrypt(tampered), RelayProtocolError)
    assert.deepEqual(connector.decrypt(second).plaintext, Uint8Array.of(2))

    const fourth = mobile.encrypt(Uint8Array.of(3)).replace('"sequence":2', '"sequence":3')
    assert.throws(() => connector.decrypt(fourth), RelayProtocolError)
  } finally {
    mobile.dispose()
    connector.dispose()
  }
})

test('enforces frame limits and erases usable state on dispose', () => {
  const { mobileSecrets } = sessions()
  const mobile = createRelayCipherState('mobile', mobileSecrets)
  assert.throws(() => mobile.encrypt(new Uint8Array()), RelayProtocolError)
  assert.throws(() => mobile.encrypt(new Uint8Array(RELAY_FRAME_MAX_PLAINTEXT_BYTES + 1)),
    RelayProtocolError)
  mobile.dispose()
  assert.throws(() => mobile.encrypt(Uint8Array.of(1)), RelayProtocolError)
})
