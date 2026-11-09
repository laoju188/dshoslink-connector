import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import {
  InMemoryPairingAuthentication,
} from '../src/pairing-auth.js'
import { deriveAuthTranscript } from '../src/pairing-transcript.js'
import {
  InMemoryPairingTrustStore,
  type PairingTrustRecord,
  type PairingTrustStore,
} from '../src/pairing-trust-store.js'

const NOW = 1_700_000_000_000
const PAIRING_ID = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const CLIENT_NONCE = Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex')
const STORED_SERVER_PIN = Buffer.alloc(32, 2)
const FIRST_CHALLENGE = Buffer.alloc(32, 3)
const FIRST_GENERATION = Buffer.alloc(16, 4)
const FIRST_TOKEN = Buffer.alloc(32, 5)
const SECOND_CHALLENGE = Buffer.alloc(32, 6)
const SECOND_GENERATION = Buffer.alloc(16, 7)
const SECOND_TOKEN = Buffer.alloc(32, 8)
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const MOBILE_PUBLIC_KEY_RAW = Buffer.from((publicKey.export({ format: 'jwk' }) as JsonWebKey).x!, 'base64url')

function activeRecord(status: PairingTrustRecord['status'] = 'active'): PairingTrustRecord {
  return {
    pairingVersion: 1,
    pairingId: PAIRING_ID.toString('base64url'),
    mobilePublicKeyRaw: MOBILE_PUBLIC_KEY_RAW.toString('base64url'),
    createdAt: NOW,
    updatedAt: NOW,
    status,
  }
}

function createAuthentication(
  store: PairingTrustStore = new InMemoryPairingTrustStore(activeRecord()),
  now: () => number = () => NOW,
  values: readonly Uint8Array[] = [
    FIRST_CHALLENGE, FIRST_GENERATION, FIRST_TOKEN,
    SECOND_CHALLENGE, SECOND_GENERATION, SECOND_TOKEN,
  ],
) {
  const available = values.map(value => Buffer.from(value))
  return new InMemoryPairingAuthentication(store, STORED_SERVER_PIN, {
    now,
    randomBytes(size) {
      const value = available.shift()
      if (value === undefined || value.byteLength !== size) throw new Error('unexpected random size')
      return value
    },
  })
}

function signedResponse(challenge: {
  pairingId: Buffer
  clientNonce: Buffer
  serverChallenge: Buffer
  connectionGeneration: Buffer
}): Buffer {
  return sign(null, deriveAuthTranscript({
    pairingId: challenge.pairingId,
    storedServerPin: STORED_SERVER_PIN,
    clientNonce: challenge.clientNonce,
    serverChallenge: challenge.serverChallenge,
    connectionGeneration: challenge.connectionGeneration,
  }), privateKey)
}

function authorization(result: { connectionToken: Buffer }): string {
  return `DSHOSLinkV1 ${result.connectionToken.toString('base64url')}`
}

test('observation callback runs only after valid authentication and cannot block authorization', () => {
  const calls: string[] = []
  const authentication = new InMemoryPairingAuthentication(new InMemoryPairingTrustStore(activeRecord()), STORED_SERVER_PIN, {
    now: () => NOW, observeChallenge: pairingId => () => { calls.push(pairingId); throw Error('diagnostics unavailable') },
  })
  try {
    const challenge = authentication.start(PAIRING_ID, CLIENT_NONCE)
    assert.equal(challenge.ok, true); if (!challenge.ok) return
    const bad = authentication.respond(challenge.pairingId, challenge.clientNonce,
      challenge.connectionGeneration, Buffer.alloc(64))
    assert.equal(bad.ok, false); assert.equal(calls.length, 0)
    const result = authentication.respond(challenge.pairingId, challenge.clientNonce,
      challenge.connectionGeneration, signedResponse(challenge))
    assert.equal(result.ok, true); assert.deepEqual(calls, [PAIRING_ID.toString('base64url')])
    if (result.ok) assert.equal(authentication.authorize(authorization(result), result.connectionGeneration.toString('base64url')), true)
  } finally { authentication.dispose() }
})

test('authenticates an active Ed25519 mobile key and returns only independent copies', () => {
  const authentication = createAuthentication()
  const challenge = authentication.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(challenge.ok, true)
  if (!challenge.ok) return
  const originalChallenge = {
    pairingId: Buffer.from(challenge.pairingId),
    clientNonce: Buffer.from(challenge.clientNonce),
    serverChallenge: Buffer.from(challenge.serverChallenge),
    connectionGeneration: Buffer.from(challenge.connectionGeneration),
  }
  challenge.serverChallenge.fill(0)
  const result = authentication.respond(
    originalChallenge.pairingId,
    originalChallenge.clientNonce,
    originalChallenge.connectionGeneration,
    signedResponse(originalChallenge),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(authentication.authorize(
    authorization(result), result.connectionGeneration.toString('base64url'),
  ), true)
  assert.deepEqual(authentication.authorizePairing(
    authorization(result), result.connectionGeneration.toString('base64url'),
  ), {
    pairingId: PAIRING_ID.toString('base64url'),
    mobilePublicKeyRaw: MOBILE_PUBLIC_KEY_RAW.toString('base64url'),
  })
  result.connectionToken.fill(0)
  result.connectionGeneration.fill(0)
  assert.equal(authentication.authorize(
    `DSHOSLinkV1 ${FIRST_TOKEN.toString('base64url')}`,
    FIRST_GENERATION.toString('base64url'),
  ), true)
  assert.equal(authentication.authorize(`DSHOSLinkV1 ${FIRST_TOKEN.toString('base64url')}`, undefined), false)
  assert.equal(authentication.authorize(`Bearer ${FIRST_TOKEN.toString('base64url')}`,
    FIRST_GENERATION.toString('base64url')), false)
  assert.equal(authentication.authorize(`DSHOSLinkV1 ${Buffer.alloc(32).toString('base64url')}`,
    FIRST_GENERATION.toString('base64url')), false)
  assert.equal(authentication.authorize(`DSHOSLinkV1 ${FIRST_TOKEN.toString('base64url')}`,
    Buffer.alloc(16, 9).toString('base64url')), false)
  assert.equal(authentication.authorizePairing(
    `DSHOSLinkV1 ${Buffer.alloc(32).toString('base64url')}`,
    FIRST_GENERATION.toString('base64url'),
  ), undefined)
})

test('R51 challenge captures its observer and diagnostic factory failures never deny valid auth', () => {
  const calls: string[] = []
  let current = 'A'
  const auth = new InMemoryPairingAuthentication(new InMemoryPairingTrustStore(activeRecord()), STORED_SERVER_PIN, {
    now: () => NOW, observeChallenge: () => {
      if (current === 'broken') throw Error('diagnostic storage unavailable')
      const owner = current
      return () => { calls.push(owner) }
    },
  })
  try {
    const a = auth.start(PAIRING_ID, CLIENT_NONCE); assert.equal(a.ok, true); if (!a.ok) return
    current = 'B'
    assert.equal(auth.respond(a.pairingId, a.clientNonce, a.connectionGeneration, signedResponse(a)).ok, true)
    assert.deepEqual(calls, ['A'])
    current = 'broken'
    const c = auth.start(PAIRING_ID, CLIENT_NONCE); assert.equal(c.ok, true); if (!c.ok) return
    assert.equal(auth.respond(c.pairingId, c.clientNonce, c.connectionGeneration, signedResponse(c)).ok, true)
    assert.deepEqual(calls, ['A'])
  } finally { auth.dispose() }
})

test('R51 expired or superseded challenges never run their diagnostic completion', () => {
  let now = NOW, observed = 0
  const auth = new InMemoryPairingAuthentication(new InMemoryPairingTrustStore(activeRecord()), STORED_SERVER_PIN, {
    now: () => now, observeChallenge: () => () => { observed++ },
  })
  try {
    const old = auth.start(PAIRING_ID, CLIENT_NONCE), fresh = auth.start(PAIRING_ID, CLIENT_NONCE)
    assert.equal(old.ok, true); assert.equal(fresh.ok, true); if (!old.ok || !fresh.ok) return
    assert.equal(auth.respond(old.pairingId, old.clientNonce, old.connectionGeneration, signedResponse(old)).ok, false)
    now += 30001
    assert.equal(auth.respond(fresh.pairingId, fresh.clientNonce, fresh.connectionGeneration, signedResponse(fresh)).ok, false)
    assert.equal(observed, 0)
    now = NOW
    const valid = auth.start(PAIRING_ID, CLIENT_NONCE); assert.equal(valid.ok, true); if (!valid.ok) return
    assert.equal(auth.respond(valid.pairingId, valid.clientNonce, valid.connectionGeneration, signedResponse(valid)).ok, true)
    assert.equal(observed, 1)
  } finally { auth.dispose() }
})

test('fails closed for non-active, mismatched, changed, expired, or unreadable trust records', () => {
  for (const status of ['pending', 'revoked'] as const) {
    assert.deepEqual(createAuthentication(new InMemoryPairingTrustStore(activeRecord(status)))
      .start(PAIRING_ID, CLIENT_NONCE), { ok: false })
  }
  const changedStore = new InMemoryPairingTrustStore(activeRecord())
  const changed = createAuthentication(changedStore)
  const challenge = changed.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(challenge.ok, true)
  if (challenge.ok) {
    changedStore.replace({ ...activeRecord(), updatedAt: NOW + 1 })
    assert.deepEqual(changed.respond(PAIRING_ID, CLIENT_NONCE, challenge.connectionGeneration,
      signedResponse(challenge)), { ok: false })
  }
  const unreadable: PairingTrustStore = {
    read() { throw new Error('sentinel') }, replace() {}, deletePending() {},
  }
  assert.deepEqual(createAuthentication(unreadable).start(PAIRING_ID, CLIENT_NONCE), { ok: false })
  const inner = new InMemoryPairingTrustStore(activeRecord())
  let failRead = false
  const failingResponseStore: PairingTrustStore = {
    read() {
      if (failRead) throw new Error('sentinel')
      return inner.read()
    },
    replace: record => inner.replace(record),
    deletePending: pairingId => inner.deletePending(pairingId),
  }
  const failingResponse = createAuthentication(failingResponseStore)
  const failingChallenge = failingResponse.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(failingChallenge.ok, true)
  if (failingChallenge.ok) {
    failRead = true
    assert.deepEqual(failingResponse.respond(PAIRING_ID, CLIENT_NONCE,
      failingChallenge.connectionGeneration, signedResponse(failingChallenge)), { ok: false })
  }
  assert.deepEqual(createAuthentication().start(Buffer.alloc(16, 9), CLIENT_NONCE), { ok: false })
})

test('uses a half-open 30 second challenge deadline and clears at the exact boundary', () => {
  let now = NOW
  const beforeBoundary = createAuthentication(new InMemoryPairingTrustStore(activeRecord()), () => now)
  const validChallenge = beforeBoundary.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(validChallenge.ok, true)
  if (validChallenge.ok) {
    now = NOW + 29_999
    assert.equal(beforeBoundary.respond(PAIRING_ID, CLIENT_NONCE, validChallenge.connectionGeneration,
      signedResponse(validChallenge)).ok, true)
  }

  now = NOW
  const atBoundary = createAuthentication(new InMemoryPairingTrustStore(activeRecord()), () => now)
  const expiredChallenge = atBoundary.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(expiredChallenge.ok, true)
  if (expiredChallenge.ok) {
    now = NOW + 30_000
    assert.deepEqual(atBoundary.respond(PAIRING_ID, CLIENT_NONCE, expiredChallenge.connectionGeneration,
      signedResponse(expiredChallenge)), { ok: false })
    now = NOW + 29_999
    assert.deepEqual(atBoundary.respond(PAIRING_ID, CLIENT_NONCE, expiredChallenge.connectionGeneration,
      signedResponse(expiredChallenge)), { ok: false })
  }
})

test('rejects bad response values and consumes each challenge only after one success', () => {
  const authentication = createAuthentication()
  const challenge = authentication.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(challenge.ok, true)
  if (!challenge.ok) return
  assert.deepEqual(authentication.respond(PAIRING_ID, Buffer.alloc(16), challenge.connectionGeneration,
    signedResponse(challenge)), { ok: false })
  assert.deepEqual(authentication.respond(PAIRING_ID, CLIENT_NONCE, Buffer.alloc(16),
    signedResponse(challenge)), { ok: false })
  assert.deepEqual(authentication.respond(PAIRING_ID, CLIENT_NONCE, challenge.connectionGeneration,
    Buffer.alloc(64)), { ok: false })
  const result = authentication.respond(PAIRING_ID, CLIENT_NONCE, challenge.connectionGeneration,
    signedResponse(challenge))
  assert.equal(result.ok, true)
  assert.deepEqual(authentication.respond(PAIRING_ID, CLIENT_NONCE, challenge.connectionGeneration,
    signedResponse(challenge)), { ok: false })
})

test('only a new successful authentication replaces an existing token', () => {
  const authentication = createAuthentication()
  const first = authentication.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const firstResult = authentication.respond(PAIRING_ID, CLIENT_NONCE, first.connectionGeneration,
    signedResponse(first))
  assert.equal(firstResult.ok, true)
  if (!firstResult.ok) return
  const second = authentication.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.deepEqual(authentication.respond(PAIRING_ID, CLIENT_NONCE, second.connectionGeneration,
    Buffer.alloc(64, 1)), { ok: false })
  assert.equal(authentication.authorize(authorization(firstResult),
    firstResult.connectionGeneration.toString('base64url')), true)
  const secondResult = authentication.respond(PAIRING_ID, CLIENT_NONCE, second.connectionGeneration,
    signedResponse(second))
  assert.equal(secondResult.ok, true)
  if (!secondResult.ok) return
  assert.equal(authentication.authorize(authorization(firstResult),
    firstResult.connectionGeneration.toString('base64url')), false)
  assert.equal(authentication.authorize(authorization(firstResult),
    secondResult.connectionGeneration.toString('base64url')), false)
  assert.equal(authentication.authorize(authorization(secondResult),
    firstResult.connectionGeneration.toString('base64url')), false)
  assert.equal(authentication.authorize(authorization(secondResult),
    secondResult.connectionGeneration.toString('base64url')), true)
})

test('supersedes an unconsumed challenge without affecting the replacement', () => {
  const authentication = createAuthentication(undefined, () => NOW, [
    FIRST_CHALLENGE, FIRST_GENERATION, SECOND_CHALLENGE, SECOND_GENERATION, SECOND_TOKEN,
  ])
  const first = authentication.start(PAIRING_ID, CLIENT_NONCE)
  const second = authentication.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  assert.deepEqual(authentication.respond(PAIRING_ID, CLIENT_NONCE, first.connectionGeneration,
    signedResponse(first)), { ok: false })
  assert.equal(authentication.respond(PAIRING_ID, CLIENT_NONCE, second.connectionGeneration,
    signedResponse(second)).ok, true)
})

test('fails authorization after trust record changes, store read failures, or local revocation', () => {
  const changedStore = new InMemoryPairingTrustStore(activeRecord())
  const changed = createAuthentication(changedStore)
  const changedChallenge = changed.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(changedChallenge.ok, true)
  if (changedChallenge.ok) {
    const result = changed.respond(PAIRING_ID, CLIENT_NONCE, changedChallenge.connectionGeneration,
      signedResponse(changedChallenge))
    assert.equal(result.ok, true)
    if (result.ok) {
      changedStore.replace({ ...activeRecord(), updatedAt: NOW + 1 })
      assert.equal(changed.authorize(authorization(result), result.connectionGeneration.toString('base64url')), false)
    }
  }

  const inner = new InMemoryPairingTrustStore(activeRecord())
  let failRead = false
  const failingStore: PairingTrustStore = {
    read: () => {
      if (failRead) throw new Error('sentinel')
      return inner.read()
    },
    replace: record => inner.replace(record),
    deletePending: pairingId => inner.deletePending(pairingId),
  }
  const failing = createAuthentication(failingStore)
  const failingChallenge = failing.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(failingChallenge.ok, true)
  if (failingChallenge.ok) {
    const result = failing.respond(PAIRING_ID, CLIENT_NONCE, failingChallenge.connectionGeneration,
      signedResponse(failingChallenge))
    assert.equal(result.ok, true)
    if (result.ok) {
      failRead = true
      assert.equal(failing.authorize(authorization(result), result.connectionGeneration.toString('base64url')), false)
      failRead = false
      failing.revoke()
      assert.equal(failing.authorize(authorization(result), result.connectionGeneration.toString('base64url')), false)
    }
  }
})

test('clears active material on dispose or revoke and fails closed on invalid random input', () => {
  const authentication = createAuthentication()
  const challenge = authentication.start(PAIRING_ID, CLIENT_NONCE)
  assert.equal(challenge.ok, true)
  if (!challenge.ok) return
  const result = authentication.respond(PAIRING_ID, CLIENT_NONCE, challenge.connectionGeneration,
    signedResponse(challenge))
  assert.equal(result.ok, true)
  if (!result.ok) return
  authentication.revoke()
  assert.equal(authentication.authorize(authorization(result), result.connectionGeneration.toString('base64url')), false)
  assert.deepEqual(authentication.start(PAIRING_ID, CLIENT_NONCE), { ok: false })

  const disposed = createAuthentication()
  disposed.dispose()
  assert.deepEqual(disposed.start(PAIRING_ID, CLIENT_NONCE), { ok: false })

  const invalidRandom = new InMemoryPairingAuthentication(
    new InMemoryPairingTrustStore(activeRecord()), STORED_SERVER_PIN,
    { randomBytes: () => Buffer.alloc(31) },
  )
  assert.deepEqual(invalidRandom.start(PAIRING_ID, CLIENT_NONCE), { ok: false })
  const throwingRandom = new InMemoryPairingAuthentication(
    new InMemoryPairingTrustStore(activeRecord()), STORED_SERVER_PIN,
    { randomBytes: () => { throw new Error('sentinel') } },
  )
  assert.deepEqual(throwingRandom.start(PAIRING_ID, CLIENT_NONCE), { ok: false })
  assert.throws(() => new InMemoryPairingAuthentication(
    new InMemoryPairingTrustStore(activeRecord()), Buffer.alloc(31),
  ), /Invalid Pairing V1 authentication input/)
})
