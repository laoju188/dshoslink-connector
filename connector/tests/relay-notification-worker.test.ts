import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { RelayBusinessWorker } from '../src/relay-business-worker.js'
import { RelayNotificationError, RelayNotificationStandby, type RelayNotificationHandlers } from '../src/relay-notification-client.js'
import { RelayConnectorTicketError, type RelayConnectorWebSocketSession } from '../src/relay-websocket-client.js'

const binding = { pairingId: Buffer.alloc(16, 1).toString('base64url'), mobilePublicKeyRaw: Buffer.alloc(32, 2).toString('base64url') }
const route = (n: number) => ({ routeId: Buffer.alloc(16, n).toString('base64url'), expiresAtEpochMs: Date.now() + 60_000 })
const drain = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('free credential arrival resumes paused standby and later Pro credential replaces it without ticket polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2_000_000_000_000 })
  let free = false, pro = false, freeRevision = 0, proRevision = 0, freeOpens = 0, proOpens = 0, claims = 0, live = 0
  const session = (h: RelayNotificationHandlers) => {
    live++; h.onMode('events'); let close = (_code: number): void => undefined, closed = false
    return { closed: new Promise<number>(resolve => { close = resolve }), dispose() { if (!closed) { closed = true; live--; close(1000) } } }
  }
  const worker = new RelayBusinessWorker({ currentBinding: () => binding,
    credentialStore: { get recoveryRevision() { return proRevision }, async openNotifications(h) { proOpens++; return pro ? session(h) : undefined },
      async claimTicket() { claims++; throw Error('must not poll') } },
    registrationNotificationProvider: { get recoveryRevision() { return freeRevision }, async openNotifications(h) { freeOpens++; return free ? session(h) : undefined } },
    rootKeyStore: { async withRootKey() { throw Error('unused') } }, onRegistrationState() {} })
  const step = async (ms: number) => { t.mock.timers.tick(ms); await drain(); await drain() }
  worker.start()
  try {
    await step(0); assert.equal(live, 0)
    await step(60_000); assert.equal(proOpens, 1); assert.equal(freeOpens, 1)
    free = true; freeRevision++; await step(1000); assert.equal(live, 1); assert.equal(freeOpens, 2)
    pro = true; proRevision++; await step(1000); assert.equal(live, 1); assert.equal(freeOpens, 2)
    await step(86_400_000); assert.equal(claims, 0); assert.equal(live, 1)
  } finally { await worker.stop(); assert.equal(live, 0) }
})

test('relay denial cannot fall back to a different identity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'], now: Date.now() })
  let freeOpens = 0, claims = 0
  const worker = new RelayBusinessWorker({ currentBinding: () => binding,
    credentialStore: { async openNotifications() { throw new RelayNotificationError(401) }, async claimTicket() { claims++; throw Error('unused') } },
    registrationNotificationProvider: { async openNotifications() { freeOpens++; return undefined } },
    rootKeyStore: { async withRootKey() { throw Error('unused') } } })
  worker.start()
  try { await drain(); t.mock.timers.tick(86_400_000); await drain(); assert.equal(freeOpens, 0); assert.equal(claims, 0) }
  finally { await worker.stop() }
})
function fixture(t: TestContext, fail?: () => unknown, firstOpen?: Promise<void>, firstClaim?: Promise<void>) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2_000_000_000_000 })
  let handlers: RelayNotificationHandlers | undefined, opens = 0, claims = 0, revision = 0
  let ticket = route(1), controlClose = (_code: number): void => undefined, businessDispose = (): void => undefined
  let businessCloses = 0
  const worker = new RelayBusinessWorker({ currentBinding: () => binding, now: () => Date.now(),
    credentialStore: {
      get recoveryRevision() { return revision },
      async openNotifications(h) {
        opens++; handlers = h; h.onMode('events')
        return { closed: new Promise<number>(resolve => { controlClose = resolve }), dispose: () => controlClose(1000) }
      },
      async claimTicket() {
        claims++
        if (claims === 1 && firstClaim) await firstClaim
        if (fail) throw fail()
        return { status: 200, ...ticket, ticket: 'synthetic' }
      },
    }, rootKeyStore: { async withRootKey() { throw Error('unused') } },
    async openSession(options) {
      await options.credentialStore.claimTicket()
      if (claims === 1 && firstOpen) await firstOpen
      let close = (): void => undefined, rejectReceive = (_error: Error): void => undefined
      const session: RelayConnectorWebSocketSession = {
        closed: new Promise<void>(resolve => { close = resolve }),
        async send() {}, receive: () => new Promise((_resolve, reject) => { rejectReceive = reject }),
        dispose: () => { businessCloses++; close(); rejectReceive(new Error('closed')) },
      }
      businessDispose = () => session.dispose(); return session
    },
  })
  return { worker, claims: () => claims, opens: () => opens, businessCloses: () => businessCloses,
    refresh: () => { revision++ }, finish: () => businessDispose(), disconnect: (code: number) => controlClose(code),
    pending(n = 1) { ticket = route(n); assert.ok(handlers); handlers.onPending(ticket) },
    selectTicket(n: number) { ticket = route(n) },
    expired() { assert.ok(handlers); handlers.onPending({ ...route(9), expiresAtEpochMs: Date.now() - 1 }) },
    mode(mode: 'events' | 'legacy') { handlers!.onMode(mode) },
    async step(ms = 0) { t.mock.timers.tick(ms); await drain(); t.mock.timers.tick(0); await drain() },
  }
}

test('events standby for a simulated day makes zero idle ticket requests', async t => {
  const f = fixture(t); f.worker.start()
  try { await f.step(); for (let i = 0; i < 24; i++) await f.step(3_600_000); assert.equal(f.claims(), 0); assert.equal(f.opens(), 1) }
  finally { await f.worker.stop() }
})

test('phone hint starts one claim, duplicate and consumed route never start another', async t => {
  const f = fixture(t); f.worker.start()
  try {
    await f.step(); f.pending(); f.pending(); await f.step(); assert.equal(f.claims(), 1)
    f.pending(); await f.step(5000); assert.equal(f.claims(), 1)
    f.finish(); await f.step(); f.pending(); await f.step(30_000); assert.equal(f.claims(), 1)
    f.pending(2); await f.step(); assert.equal(f.claims(), 2)
  } finally { await f.worker.stop() }
})

test('pending next route retires a half-open business channel and only newest is claimed', async t => {
  const f = fixture(t); f.worker.start()
  try {
    await f.step(); f.pending(); await f.step(); f.pending(2); f.pending(3); await f.step()
    assert.equal(f.claims(), 2); assert.ok(f.businessCloses() >= 1)
  } finally { await f.worker.stop() }
})

test('a newer hint arriving during handshake retires the just-opened old channel', async t => {
  let release = (): void => undefined
  const firstOpen = new Promise<void>(resolve => { release = resolve })
  const f = fixture(t, undefined, firstOpen); f.worker.start()
  try {
    await f.step(); f.pending(); await f.step()
    assert.equal(f.claims(), 1); assert.equal(f.businessCloses(), 0)
    f.pending(2); await f.step()
    assert.equal(f.claims(), 1, 'do not run concurrent claim loops')
    release(); await f.step(); await f.step()
    assert.equal(f.claims(), 2); assert.equal(f.businessCloses(), 1)
    await f.step(86_400_000)
    assert.equal(f.claims(), 2, 'handshake replacement must not restart idle polling')
  } finally { release(); await f.worker.stop() }
})

test('a stale wakeup cannot close the current route returned by the ticket service', async t => {
  const f = fixture(t)
  f.worker.start()
  try {
    await f.step()
    f.pending(1)
    f.selectTicket(2)
    await f.step()
    assert.equal(f.claims(), 1)
    assert.equal(f.businessCloses(), 0)
    f.pending(2)
    await f.step()
    assert.equal(f.claims(), 1)
    assert.equal(f.businessCloses(), 0)
  } finally { await f.worker.stop() }
})

test('a late route-not-ready reply cannot discard a newer wakeup', async t => {
  let rejectClaim = (_error: Error): void => undefined
  const firstClaim = new Promise<void>((_resolve, reject) => { rejectClaim = reject })
  const f = fixture(t, undefined, undefined, firstClaim)
  f.worker.start()
  try {
    await f.step()
    f.pending(1)
    await f.step()
    assert.equal(f.claims(), 1)
    f.pending(2)
    rejectClaim(new RelayConnectorTicketError(409))
    await f.step()
    await f.step()
    assert.equal(f.claims(), 2)
    assert.equal(f.businessCloses(), 0)
  } finally { await f.worker.stop() }
})

test('control disconnect preserves established business and reconnect is delayed', async t => {
  const f = fixture(t); f.worker.start()
  try {
    await f.step(); f.pending(); await f.step(); f.disconnect(1006); await f.step()
    assert.equal(f.businessCloses(), 0); assert.equal(f.opens(), 1)
    await f.step(1000); assert.equal(f.opens(), 2); assert.equal(f.claims(), 1)
  } finally { await f.worker.stop() }
})

test('temporary verification failure retries the same identity only after 30 seconds', async t => {
  const f=fixture(t);f.worker.start()
  try {
    await f.step();f.pending();await f.step();f.disconnect(1013);await f.step()
    await f.step(29999);assert.equal(f.opens(),1);assert.equal(f.businessCloses(),0)
    await f.step(15001);assert.equal(f.opens(),2);assert.equal(f.claims(),1)
  } finally {await f.worker.stop()}
})

for (const code of [4001, 4009]) test(`control close ${code} pauses until local identity change`, async t => {
  const f = fixture(t); f.worker.start()
  try {
    await f.step(); f.disconnect(code); await f.step(); await f.step(3_600_000)
    assert.equal(f.opens(), 1); f.refresh(); await f.step(1000); assert.equal(f.opens(), 2)
  } finally { await f.worker.stop() }
})

test('expired notification causes no claim and stop cancels queued wakeup', async t => {
  const f = fixture(t); f.worker.start()
  try { await f.step(); f.expired(); await f.step(); assert.equal(f.claims(), 0); f.pending(); await f.worker.stop(); await f.step(30_000); assert.equal(f.claims(), 0) }
  finally { await f.worker.stop() }
})

test('route-not-ready is a single completed wakeup instead of a new polling loop', async t => {
  const f = fixture(t, () => new RelayConnectorTicketError(409)); f.worker.start()
  try { await f.step(); f.pending(); await f.step(); await f.step(3_600_000); assert.equal(f.claims(), 1) }
  finally { await f.worker.stop() }
})

test('server cooldown is not bypassed by another notification', async t => {
  const f = fixture(t, () => new RelayConnectorTicketError(429, 30_000)); f.worker.start()
  try {
    await f.step(); f.pending(); await f.step(); assert.equal(f.claims(), 1)
    f.pending(2); await f.step(29_000); assert.equal(f.claims(), 1)
    await f.step(1000); assert.equal(f.claims(), 2)
  } finally { await f.worker.stop() }
})

test('missing notification implementation cannot silently enable legacy polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0
  const worker = new RelayBusinessWorker({ currentBinding: () => binding,
    credentialStore: { async claimTicket() { calls++; return { status: 409 } } },
    rootKeyStore: { async withRootKey() { throw Error('unused') } } })
  worker.start(); t.mock.timers.tick(3_600_000); await drain(); await worker.stop(); assert.equal(calls, 0)
})

for (const status of [401, 403, 404, 429, 503, 0]) test(`notification HTTP ${status} never switches to legacy`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let opens = 0, modeCalls = 0
  const standby = new RelayNotificationStandby({ context: () => 'one', random: () => 1, onIdentityChange() {}, onMode() { modeCalls++ }, onPending() {},
    provider: { async openNotifications() { opens++; throw new RelayNotificationError(status, status === 429 ? 30_000 : undefined) } } })
  standby.start(); await drain()
  t.mock.timers.tick(1000); await drain(); assert.equal(modeCalls, 0)
  assert.equal(opens, status === 401 || status === 403 || status === 429 ? 1 : 2)
  await standby.stop()
})

test('credential absence waits locally; restart and provision recover without an empty claim', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let opens = 0, context = 'one'
  const standby = new RelayNotificationStandby({ context: () => context, onIdentityChange() {}, onMode() {}, onPending() {},
    provider: { async openNotifications() { opens++; return undefined } } })
  standby.start(); await drain(); t.mock.timers.tick(86_400_000); await drain(); assert.equal(opens, 1)
  context = 'two'; t.mock.timers.tick(1000); await drain(); assert.equal(opens, 2)
  await standby.stop()
})

test('authenticated legacy rollback is re-negotiated after five minutes without permanent downgrade', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let opens = 0, close = (_code: number): void => undefined
  const modes: string[] = []
  const standby = new RelayNotificationStandby({ context: () => 'one', random: () => 1, onIdentityChange() {},
    onMode: mode => modes.push(mode), onPending() {}, provider: { async openNotifications(h) {
      opens++; h.onMode(opens === 1 ? 'legacy' : 'events')
      return { closed: new Promise<number>(resolve => { close = resolve }), dispose: () => close(1000) }
    } } })
  standby.start(); await drain(); close(4010); await drain()
  t.mock.timers.tick(299_999); await drain(); assert.equal(opens, 1)
  t.mock.timers.tick(30001); await drain(); assert.equal(opens, 2); assert.deepEqual(modes, ['legacy', 'events'])
  await standby.stop()
})
