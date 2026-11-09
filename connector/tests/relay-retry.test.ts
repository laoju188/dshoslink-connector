import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { RelayBusinessWorker } from '../src/relay-business-worker.js'
import { RelayConnectorTicketError, claimAndOpenRelayConnectorWebSocketSession,
  type RelayConnectorWebSocketSession } from '../src/relay-websocket-client.js'
import type { PairingAuthorizationBinding } from '../src/pairing-auth.js'

const BINDING: PairingAuthorizationBinding = {
  pairingId: Buffer.alloc(16, 1).toString('base64url'),
  mobilePublicKeyRaw: Buffer.alloc(32, 2).toString('base64url'),
}
const drain = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
function fixture(t: TestContext, failure: () => unknown) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  let revision = 0
  let binding: PairingAuthorizationBinding | undefined = BINDING
  const calls: number[] = []
  const active = new RelayBusinessWorker({ standbyMode: 'legacy',
    now: () => now, currentBinding: () => binding, pollMs: 3_000,
    credentialStore: { get recoveryRevision() { return revision }, async claimTicket() { throw Error('unused') } },
    rootKeyStore: { async withRootKey() { throw Error('unused') } },
    async openSession() { calls.push(now); throw failure() },
  })
  return { active, calls, refresh() { revision++ }, revoke() { binding = undefined },
    replace() { binding = { ...BINDING, pairingId: Buffer.alloc(16, 3).toString('base64url') } },
    async step(ms: number) { now += ms; t.mock.timers.tick(ms); await drain() },
  }
}

test('ticket failures preserve only the status and never borrow the pairing root', async () => {
  for (const status of [401, 403, 409, 429, 503]) {
    let borrowed = false
    await assert.rejects(claimAndOpenRelayConnectorWebSocketSession({
      url: 'wss://invalid.example', binding: BINDING,
      credentialStore: { async claimTicket() { return { status } } },
      rootKeyStore: { async withRootKey() { borrowed = true; throw Error('unused') } },
    }), error => error instanceof RelayConnectorTicketError && error.status === status
      && error.message === 'Relay connector ticket unavailable')
    assert.equal(borrowed, false)
  }
})

test('normal route-not-ready uses the configured cadence without failure backoff', async t => {
  const f = fixture(t, () => new RelayConnectorTicketError(409))
  f.active.start()
  try {
    await f.step(0)
    for (let i = 0; i < 5; i++) await f.step(3_000)
    assert.deepEqual(f.calls, [0, 3000, 6000, 9000, 12000, 15000])
  } finally { await f.active.stop() }
})

for (const status of [401, 403]) {
  test(`persistent ${status} is bounded over an hour and remains recoverable within ticket TTL`, async t => {
    const f = fixture(t, () => new RelayConnectorTicketError(status))
    f.active.start()
    try {
      await f.step(0)
      for (let i = 0; i < 1200; i++) await f.step(3_000)
      assert.deepEqual(f.calls.slice(0, 4), [0, 15000, 45000, 75000])
      assert.equal(f.calls.length, 121)
      assert.ok(f.calls.slice(1).every((at, i) => at - f.calls[i]! <= 30_000))
    } finally { await f.active.stop() }
  })
}

for (const kind of ['network', 'server']) {
  test(`${kind} failures back off to thirty seconds`, async t => {
    const f = fixture(t, () => kind === 'network' ? Error('connection failed')
      : new RelayConnectorTicketError(503))
    f.active.start()
    try {
      await f.step(0)
      for (let i = 0; i < 25; i++) await f.step(3_000)
      assert.deepEqual(f.calls, [0, 3000, 9000, 21000, 45000, 75000])
    } finally { await f.active.stop() }
  })
}

test('a rate limit without a safe server hint waits the full legacy window', async t => {
  const f = fixture(t, () => new RelayConnectorTicketError(429))
  f.active.start()
  try {
    await f.step(0)
    for (let i = 0; i < 25; i++) await f.step(3000)
    assert.deepEqual(f.calls, [0, 60000])
  } finally { await f.active.stop() }
})

for (const change of ['credential', 'binding']) {
  test(`new ${change} resumes on the next local tick without waiting for backoff`, async t => {
    const f = fixture(t, () => new RelayConnectorTicketError(401))
    f.active.start()
    try {
      await f.step(0)
      await f.step(3_000)
      assert.equal(f.calls.length, 1)
      if (change === 'credential') f.refresh(); else f.replace()
      await f.step(3_000)
      assert.deepEqual(f.calls, [0, 6000])
      f.revoke()
      for (let i = 0; i < 20; i++) await f.step(3_000)
      assert.equal(f.calls.length, 2)
    } finally { await f.active.stop() }
  })
}

test('a valid waiting route resets previous failures', async t => {
  let status = 401
  const f = fixture(t, () => new RelayConnectorTicketError(status))
  f.active.start()
  try {
    await f.step(0)
    status = 409
    for (let i = 0; i < 6; i++) await f.step(3_000)
    assert.deepEqual(f.calls, [0, 15000, 18000])
    status = 401
    await f.step(3_000)
    for (let i = 0; i < 5; i++) await f.step(3_000)
    assert.deepEqual(f.calls, [0, 15000, 18000, 21000, 36000])
  } finally { await f.active.stop() }
})

test('stop and restart during an outstanding open never create overlapping loops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: (value: RelayConnectorWebSocketSession) => void
  let opens = 0
  let disposed = 0
  let received = 0
  const active = new RelayBusinessWorker({ standbyMode: 'legacy',
    currentBinding: () => BINDING,
    credentialStore: { async claimTicket() { throw Error('unused') } },
    rootKeyStore: { async withRootKey() { throw Error('unused') } },
    async openSession() {
      opens++
      if (opens === 1) return new Promise(resolve => { release = resolve })
      throw new RelayConnectorTicketError(409)
    },
  })
  active.start(); t.mock.timers.tick(0); await drain()
  const stopping = active.stop()
  active.start()
  t.mock.timers.tick(5_000); await drain()
  assert.equal(opens, 1)
  release({ closed: Promise.resolve(), async send() {}, async receive() {
    received++; return { kind: 'close', plaintext: new Uint8Array() }
  }, dispose() { disposed++ } })
  await stopping; await drain()
  t.mock.timers.tick(0); await drain()
  assert.equal(opens, 2)
  assert.equal(disposed, 1)
  assert.equal(received, 0)
  t.mock.timers.tick(5_000); await drain()
  assert.equal(opens, 3)
  await active.stop()
  t.mock.timers.tick(60_000); await drain()
  assert.equal(opens, 3)
})

test('default ticket-claim path applies backoff without invoking root-key access', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0, claims = 0, borrowed = 0
  const active = new RelayBusinessWorker({ standbyMode: 'legacy',
    now: () => now, currentBinding: () => BINDING, pollMs: 3_000,
    credentialStore: { async claimTicket() { claims++; return { status: 401 } } },
    rootKeyStore: { async withRootKey() { borrowed++; throw Error('unused') } },
  })
  active.start()
  try {
    t.mock.timers.tick(0); await drain()
    for (let i = 0; i < 15; i++) {
      now += 3000; t.mock.timers.tick(3000); await drain()
    }
    assert.equal(claims, 3)
    assert.equal(borrowed, 0)
  } finally { await active.stop() }
})

test('default claim path never retries a consumed route, including after worker restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0, claims = 0, borrowed = 0
  let routeId = Buffer.alloc(16, 7).toString('base64url')
  const active = new RelayBusinessWorker({ standbyMode: 'legacy',
    now: () => now, currentBinding: () => BINDING,
    credentialStore: { async claimTicket() {
      claims++
      return { status: 200, routeId, ticket: 'opaque-ticket', expiresAtEpochMs: Date.now() + 30_000 }
    } },
    rootKeyStore: { async withRootKey() {
      borrowed++
      // A failed dial can already have consumed the ticket on the relay.
      throw Error('handshake disconnected')
    } },
  })
  const step = async () => { now += 5000; t.mock.timers.tick(5000); await drain() }
  try {
    active.start(); t.mock.timers.tick(0); await drain()
    await step(); await step()
    assert.equal(borrowed, 1)
    assert.equal(claims, 3, 'continue checking for a fresh phone route')
    await active.stop(); active.start(); t.mock.timers.tick(0); await drain()
    assert.equal(borrowed, 1, 'stop/start must not reuse the previous route')
    routeId = Buffer.alloc(16, 8).toString('base64url')
    await step()
    assert.equal(borrowed, 2, 'a fresh route remains immediately eligible')
  } finally { await active.stop() }
})

test('fresh authorized phone routes reset stale handshake backoff before the next 8s rendezvous', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0, claims = 0
  const active = new RelayBusinessWorker({ standbyMode: 'legacy',
    now: () => now, currentBinding: () => BINDING,
    credentialStore: { async claimTicket() {
      claims++
      return { status: 200, routeId: Buffer.alloc(16, claims).toString('base64url'), ticket: 'opaque-ticket', expiresAtEpochMs: Date.now() + 30_000 }
    } },
    rootKeyStore: { async withRootKey() { throw Error('peer left during handshake') } },
  })
  try {
    active.start(); t.mock.timers.tick(0); await drain()
    for (let i = 1; i <= 6; i++) {
      now += 5000; t.mock.timers.tick(5000); await drain()
      assert.equal(claims, i + 1, 'a new valid route must not inherit 30s failure backoff')
    }
  } finally { await active.stop() }
})
