import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PairingAuthorizationBinding } from '../src/pairing-auth.js'
import type { PairingV1HttpRequest } from '../src/pairing-backend.js'
import type { PairingIdentityProtector } from '../src/pairing-identity-store.js'
import {
  createRelayConnectorCredentialRequestHandler,
  RELAY_CONNECTOR_CREDENTIAL_FILE_NAME,
  RELAY_CONNECTOR_CREDENTIAL_PATH,
  RELAY_CONNECTOR_TICKET_TTL_MS,
  RELAY_CONNECTOR_TICKET_URL,
  RelayConnectorCredentialStore,
} from '../src/relay-connector-credential.js'
import {
  createWindowsCurrentUserDataProtector,
  createWindowsRelayConnectorCredentialDataProtector,
  createWindowsRelayRootKeyDataProtector,
} from '../src/windows-dpapi.js'

const IDENTITY_ID = Buffer.alloc(32, 1).toString('base64url')
const PAIRING_ID = Buffer.alloc(16, 2).toString('base64url')
const MOBILE_PUBLIC_KEY_RAW = Buffer.alloc(32, 3).toString('base64url')
const AUTHORIZATION = 'DSHOSLinkV1 authorized-token'
const GENERATION = 'authorized-generation'
const CREDENTIAL = Buffer.alloc(32, 4)
const OTHER_CREDENTIAL = Buffer.alloc(32, 5)
const NOW = 2_000_000_000_000
const BINDING: PairingAuthorizationBinding = Object.freeze({
  pairingId: PAIRING_ID,
  mobilePublicKeyRaw: MOBILE_PUBLIC_KEY_RAW,
})

class TestProtector implements PairingIdentityProtector {
  protectCalls = 0
  unprotectCalls = 0
  readonly plaintexts: Buffer[] = []
  beforeProtect: (() => Promise<void>) | undefined

  async protect(plaintext: Buffer): Promise<Buffer> {
    this.protectCalls += 1
    this.plaintexts.push(Buffer.from(plaintext))
    await this.beforeProtect?.()
    return Buffer.concat([
      Buffer.from('relay-connector-test\0'),
      Buffer.from(plaintext.map(byte => byte ^ 0xa5)),
    ])
  }

  async unprotect(ciphertext: Buffer): Promise<Buffer> {
    this.unprotectCalls += 1
    const prefix = Buffer.from('relay-connector-test\0')
    if (ciphertext.byteLength <= prefix.byteLength
      || !ciphertext.subarray(0, prefix.byteLength).equals(prefix)) {
      throw new Error('invalid test ciphertext')
    }
    return Buffer.from(ciphertext.subarray(prefix.byteLength).map(byte => byte ^ 0xa5))
  }
}

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dshoslink-relay-connector-'))
}

function canonicalBody(credential = CREDENTIAL): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'relay_connector_credential',
    protocolVersion: 1,
    connectorCredential: credential.toString('base64url'),
  }), 'utf8')
}

function request(overrides: Partial<PairingV1HttpRequest> = {}): PairingV1HttpRequest {
  return {
    method: 'PUT',
    path: RELAY_CONNECTOR_CREDENTIAL_PATH,
    contentType: 'application/json',
    body: canonicalBody(),
    authorization: AUTHORIZATION,
    connectionGeneration: GENERATION,
    ...overrides,
  }
}

function authorizer(binding: () => PairingAuthorizationBinding | undefined) {
  return {
    authorizePairing(authorization?: string, generation?: string) {
      return authorization === AUTHORIZATION && generation === GENERATION
        ? binding()
        : undefined
    },
  }
}

function createStore(rootDirectory: string, protector: PairingIdentityProtector,
  currentBinding: () => PairingAuthorizationBinding | undefined = () => BINDING,
  options: Partial<ConstructorParameters<typeof RelayConnectorCredentialStore>[0]> = {}) {
  return new RelayConnectorCredentialStore({
    rootDirectory,
    identityId: IDENTITY_ID,
    currentBinding,
    protector,
    ...options,
  })
}

async function provision(
  store: RelayConnectorCredentialStore,
  credential = CREDENTIAL,
): Promise<void> {
  assert.equal(await store.provision(
    credential, BINDING, () => BINDING,
  ), 'stored')
}

function validTicket(expiresAtEpochMs: number): string {
  const payload = { version: 1, ticketId: Buffer.alloc(16, 7).toString('base64url'),
    routeId: Buffer.alloc(16, 8).toString('base64url'), role: 'connector',
    accountBindingHash: 'ab'.repeat(32), computerBindingHash: 'cd'.repeat(32),
    issuedAtEpochMs: expiresAtEpochMs - 60_000, expiresAtEpochMs }
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.alloc(32, 9).toString('base64url')}`
}
function validTicketResponse(expiresAtEpochMs = NOW + 59_000): Response {
  return new Response(JSON.stringify({ version: 1, routeId: Buffer.alloc(16, 8).toString('base64url'),
    ticket: validTicket(expiresAtEpochMs), expiresAtEpochMs }), {
    status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

test('cancelled ticket request aborts HTTP and preserves credential for a fresh claim', async () => {
  const root = temporaryRoot(), abort = new AbortController()
  let entered!: () => void
  const requested = new Promise<void>(resolve => { entered = resolve })
  let calls = 0, requestSignal: AbortSignal | undefined
  const store = createStore(root, new TestProtector(), () => BINDING, {
    now: () => NOW,
    fetch: async (_url, init) => {
      calls++
      if (calls > 1) return validTicketResponse()
      requestSignal = init!.signal as AbortSignal
      entered()
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    },
  })
  try {
    await provision(store)
    const original = readFileSync(join(root, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME))
    const operation = store.claimTicket(abort.signal)
    await requested; abort.abort(); await assert.rejects(operation)
    assert.equal(requestSignal!.aborted, true)
    assert.deepEqual(readFileSync(join(root, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)), original)
    assert.equal((await store.claimTicket()).status, 200)
    const already = new AbortController(); already.abort()
    await assert.rejects(store.claimTicket(already.signal)); assert.equal(calls, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('late refusal after cancelled ticket request cannot pause the current service gate', async () => {
  const root = temporaryRoot(), abort = new AbortController()
  let entered!: () => void, release!: (response: Response) => void
  const requested = new Promise<void>(resolve => { entered = resolve })
  const store = createStore(root, new TestProtector(), () => BINDING, {
    now: () => NOW, fetch: async () => { entered(); return new Promise<Response>(resolve => { release = resolve }) },
  })
  try {
    await provision(store)
    const operation = store.claimTicket(abort.signal); await requested; abort.abort()
    release(new Response(JSON.stringify({ error: 'service_access_restricted', access: {
      version: 1, revision: 1, mode: 'relay_paused', reason: 'account_security', caseId: 'synthetic', endsAt: NOW + 60000, serverTime: NOW,
    } }), { status: 403, headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
    await assert.rejects(operation)
    assert.equal(store.serviceAccess().blocked(), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('notification credential loan is cleared after handshake and does not lock later claims', async () => {
  const root = temporaryRoot(), protector = new TestProtector()
  let loan: Uint8Array | undefined
  let close = (_code: number): void => undefined
  const controller = new AbortController()
  const store = createStore(root, protector, () => BINDING, {
    now: () => NOW, fetch: async () => validTicketResponse(),
    async notificationTransport(credential, handlers) {
      loan = credential
      assert.deepEqual(Buffer.from(credential), CREDENTIAL)
      handlers.onMode('events')
      return { closed: new Promise<number>(resolve => { close = resolve }), dispose: () => close(1000) }
    },
  })
  try {
    assert.equal(await store.openNotifications({ signal: controller.signal, onMode() {}, onPending() {} }), undefined)
    await provision(store)
    const session = await store.openNotifications({ signal: controller.signal, onMode() {}, onPending() {} })
    assert.ok(session); assert.ok(loan); assert.deepEqual(Buffer.from(loan), Buffer.alloc(32))
    const decrypts = protector.unprotectCalls
    assert.equal((await store.claimTicket()).status, 200)
    assert.equal(protector.unprotectCalls, decrypts + 1)
    session.dispose(); await session.closed
  } finally { controller.abort(); rmSync(root, { recursive: true, force: true }) }
})

test('revocation during notification handshake suppresses late mode and hints and closes the old socket', async () => {
  const root = temporaryRoot(), protector = new TestProtector(), controller = new AbortController()
  let modes = 0, hints = 0, disposed = 0
  let enter = (): void => undefined, release = (): void => undefined
  const entered = new Promise<void>(resolve => { enter = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const store = createStore(root, protector, () => BINDING, { async notificationTransport(_credential, handlers) {
    enter(); await gate; handlers.onMode('events')
    handlers.onPending({ routeId: PAIRING_ID, expiresAtEpochMs: NOW + 60_000 })
    return { closed: Promise.resolve(1000), dispose() { disposed++ } }
  } })
  try {
    await provision(store)
    const opening = store.openNotifications({ signal: controller.signal, onMode() { modes++ }, onPending() { hints++ } })
    await entered; store.revoke(); release()
    assert.equal(await opening, undefined); assert.equal(modes, 0); assert.equal(hints, 0); assert.equal(disposed, 1)
  } finally { release(); controller.abort(); rmSync(root, { recursive: true, force: true }) }
})

test('accepts only the exact authenticated canonical credential request and clears bodies', async () => {
  const rootDirectory = temporaryRoot()
  try {
    const store = createStore(rootDirectory, new TestProtector())
    const handle = createRelayConnectorCredentialRequestHandler(authorizer(() => BINDING), store)
    const accepted = request()
    assert.deepEqual(await handle(accepted), { status: 204, body: '' })
    assert.deepEqual(accepted.body, Buffer.alloc(accepted.body.byteLength))

    const invalidBodies = [
      `{"protocolVersion":1,"type":"relay_connector_credential","connectorCredential":"${CREDENTIAL.toString('base64url')}"}`,
      `{"type":"relay_connector_credential", "protocolVersion":1,"connectorCredential":"${CREDENTIAL.toString('base64url')}"}`,
      `{"type":"relay_connector_credential","protocolVersion":1,"connectorCredential":"${CREDENTIAL.toString('base64url')}","extra":1}`,
      '{"type":"relay_connector_credential","protocolVersion":1,"connectorCredential":"AA"}',
    ]
    for (const text of invalidBodies) {
      assert.equal((await handle(request({ body: Buffer.from(text) }))).status, 400)
    }
    for (const candidate of [
      request({ authorization: undefined }),
      request({ connectionGeneration: undefined }),
    ]) assert.equal((await handle(candidate)).status, 401)
    assert.equal((await handle(request({ method: 'POST' }))).status, 405)
    assert.equal((await handle(request({ path: `${RELAY_CONNECTOR_CREDENTIAL_PATH}?x=1` }))).status, 400)
    assert.equal((await handle(request({ contentType: 'application/json; charset=utf-8' }))).status, 400)
    assert.equal((await handle(request({ body: Buffer.from([0xff]) }))).status, 400)
    assert.equal((await handle(request({ path: '/connection/v1/other' }))).status, 404)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('fails closed when AUTH or active binding changes around DPAPI and publication', async () => {
  const rootDirectory = temporaryRoot()
  const protector = new TestProtector()
  let active = true
  protector.beforeProtect = async () => { active = false }
  try {
    const store = createStore(rootDirectory, protector, () => active ? BINDING : undefined)
    const handle = createRelayConnectorCredentialRequestHandler(
      authorizer(() => active ? BINDING : undefined), store,
    )
    assert.equal((await handle(request())).status, 401)
    assert.equal(existsSync(join(rootDirectory, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)), false)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('removes its atomic publication when authorization changes immediately afterward', async () => {
  const rootDirectory = temporaryRoot()
  let checks = 0
  try {
    const store = createStore(rootDirectory, new TestProtector(), () => {
      checks += 1
      return checks < 6 ? BINDING : undefined
    })
    assert.equal(await store.provision(CREDENTIAL, BINDING, () => BINDING), 'unauthorized')
    assert.equal(existsSync(join(rootDirectory, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)), false)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('uses an independent Windows CurrentUser DPAPI entropy domain', {
  skip: process.platform !== 'win32',
}, async () => {
  const plaintext = Buffer.from('relay-connector-credential-dpapi-domain')
  const connector = createWindowsRelayConnectorCredentialDataProtector()
  const identity = createWindowsCurrentUserDataProtector()
  const relayRoot = createWindowsRelayRootKeyDataProtector()
  let ciphertext: Buffer | undefined
  let roundtrip: Buffer | undefined
  try {
    ciphertext = await connector.protect(plaintext)
    roundtrip = await connector.unprotect(ciphertext)
    assert.deepEqual(roundtrip, plaintext)
    await assert.rejects(identity.unprotect(ciphertext))
    await assert.rejects(relayRoot.unprotect(ciphertext))
  } finally {
    plaintext.fill(0)
    ciphertext?.fill(0)
    roundtrip?.fill(0)
  }
})

test('stores a bound DPAPI ciphertext, is idempotent, and atomically rotates', async () => {
  const rootDirectory = temporaryRoot()
  const protector = new TestProtector()
  try {
    const store = createStore(rootDirectory, protector)
    assert.equal(await store.provision(CREDENTIAL, BINDING, () => BINDING), 'stored')
    const path = join(rootDirectory, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)
    const first = readFileSync(path, 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(first)), ['storageVersion', 'protectedCredential'])
    assert.equal(first.includes(CREDENTIAL.toString('base64url')), false)
    assert.equal(first.includes(CREDENTIAL.toString('hex')), false)
    assert.equal(first.includes(createHash('sha256').update(CREDENTIAL).digest('base64url')), false)
    assert.equal(first.includes(IDENTITY_ID), false)
    assert.equal(first.includes(PAIRING_ID), false)
    assert.equal(first.includes(MOBILE_PUBLIC_KEY_RAW), false)
    assert.equal(protector.plaintexts[0]!.includes(Buffer.from(IDENTITY_ID, 'base64url')), true)
    assert.equal(protector.plaintexts[0]!.includes(Buffer.from(PAIRING_ID, 'base64url')), true)
    assert.equal(protector.plaintexts[0]!.includes(Buffer.from(MOBILE_PUBLIC_KEY_RAW, 'base64url')), true)
    assert.deepEqual(protector.plaintexts[0]!.subarray(-32), CREDENTIAL)

    assert.equal(await store.provision(CREDENTIAL, BINDING, () => BINDING), 'unchanged')
    assert.equal(protector.protectCalls, 1)
    assert.equal(await store.provision(OTHER_CREDENTIAL, BINDING, () => BINDING), 'stored')
    assert.notEqual(readFileSync(path, 'utf8'), first)
    assert.equal(protector.protectCalls, 2)
  } finally {
    for (const plaintext of protector.plaintexts) plaintext.fill(0)
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('serializes concurrent rotations so a slow older write cannot overwrite the newer value', async () => {
  const rootDirectory = temporaryRoot()
  const protector = new TestProtector()
  let release = (): void => undefined
  const blocked = new Promise<void>(resolve => { release = resolve })
  let first = true
  protector.beforeProtect = async () => {
    if (!first) return
    first = false
    await blocked
  }
  let authorizationHeader = ''
  try {
    const store = createStore(rootDirectory, protector, () => BINDING, {
      fetch: async (_input, init) => {
        authorizationHeader = new Headers(init?.headers).get('authorization') ?? ''
        return validTicketResponse()
      },
      now: () => NOW,
      timeoutSignal: () => new AbortController().signal,
    })
    const older = store.provision(CREDENTIAL, BINDING, () => BINDING)
    const newer = store.provision(OTHER_CREDENTIAL, BINDING, () => BINDING)
    release()
    assert.equal(await older, 'stored')
    assert.equal(await newer, 'stored')
    assert.equal((await store.claimTicket()).status, 200)
    assert.equal(authorizationHeader, `Bearer ${OTHER_CREDENTIAL.toString('base64url')}`)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('serializes ticket claims with credential rotation', async () => {
  const rootDirectory = temporaryRoot()
  let releaseFetch = (): void => undefined
  const fetchBlocked = new Promise<void>(resolve => { releaseFetch = resolve })
  let markFetchStarted = (): void => undefined
  const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve })
  const authorizationHeaders: string[] = []
  let fetchCalls = 0
  try {
    const store = createStore(rootDirectory, new TestProtector(), () => BINDING, {
      fetch: async (_input, init) => {
        fetchCalls += 1
        authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
        if (fetchCalls === 1) {
          markFetchStarted()
          await fetchBlocked
        }
        return validTicketResponse()
      },
      now: () => NOW,
      timeoutSignal: () => new AbortController().signal,
    })
    await provision(store)

    const claim = store.claimTicket()
    await fetchStarted
    let rotationCompleted = false
    const rotation = store.provision(OTHER_CREDENTIAL, BINDING, () => BINDING)
      .then(result => {
        rotationCompleted = true
        return result
      })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(rotationCompleted, false)

    releaseFetch()
    assert.equal((await claim).status, 200)
    assert.equal(await rotation, 'stored')
    assert.equal(rotationCompleted, true)
    assert.equal((await store.claimTicket()).status, 200)
    assert.deepEqual(authorizationHeaders, [
      `Bearer ${CREDENTIAL.toString('base64url')}`,
      `Bearer ${OTHER_CREDENTIAL.toString('base64url')}`,
    ])
  } finally {
    releaseFetch()
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('rejects identity or pairing binding mismatch without sending a ticket request', async () => {
  const rootDirectory = temporaryRoot()
  const protector = new TestProtector()
  let fetchCalls = 0
  try {
    await provision(createStore(rootDirectory, protector))
    const wrongBinding = Object.freeze({
      pairingId: Buffer.alloc(16, 22).toString('base64url'),
      mobilePublicKeyRaw: MOBILE_PUBLIC_KEY_RAW,
    })
    const mismatched = new RelayConnectorCredentialStore({
      rootDirectory,
      identityId: Buffer.alloc(32, 23).toString('base64url'),
      currentBinding: () => wrongBinding,
      protector,
      fetch: async () => { fetchCalls += 1; return validTicketResponse() },
    })
    await assert.rejects(mismatched.claimTicket(), /ticket request failed/)
    assert.equal(fetchCalls, 0)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('DPAPI and atomic publication failures leave no authoritative credential', async () => {
  const rootDirectory = temporaryRoot()
  const failingRoot = join(rootDirectory, 'not-a-directory')
  writeFileSync(failingRoot, 'occupied')
  try {
    const dpapiFailure = createStore(join(rootDirectory, 'dpapi'), {
      protect: async () => { throw new Error('sentinel') },
      unprotect: async () => { throw new Error('sentinel') },
    })
    await assert.rejects(dpapiFailure.provision(CREDENTIAL, BINDING, () => BINDING))
    assert.equal(existsSync(join(rootDirectory, 'dpapi', RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)), false)

    const publishFailure = createStore(failingRoot, new TestProtector())
    await assert.rejects(publishFailure.provision(CREDENTIAL, BINDING, () => BINDING))
    assert.equal(existsSync(join(failingRoot, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)), false)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('claims one strict connector ticket with a credential-only no-body request', async () => {
  const rootDirectory = temporaryRoot()
  const protector = new TestProtector()
  let timeoutMs = 0
  try {
    const store = createStore(rootDirectory, protector, () => BINDING, {
      fetch: async (input, init) => {
        assert.equal(input, RELAY_CONNECTOR_TICKET_URL)
        assert.equal(init?.method, 'POST')
        assert.equal(init?.body, undefined)
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('authorization'), `Bearer ${CREDENTIAL.toString('base64url')}`)
        assert.equal(headers.has('content-type'), false)
        assert.equal(init?.cache, 'no-store')
        assert.equal(init?.redirect, 'error')
        return validTicketResponse()
      },
      now: () => NOW,
      timeoutSignal: value => {
        timeoutMs = value
        return new AbortController().signal
      },
    })
    await provision(store)
    const result = await store.claimTicket()
    assert.deepEqual(result, {
      status: 200,
      routeId: Buffer.alloc(16, 8).toString('base64url'),
      ticket: validTicket(NOW + 59_000),
      expiresAtEpochMs: NOW + 59_000,
    })
    assert.equal(timeoutMs, 8_000)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('preserves non-success HTTP status without retrying', async () => {
  for (const status of [401, 409, 429]) {
    const rootDirectory = temporaryRoot()
    let calls = 0
    try {
      const store = createStore(rootDirectory, new TestProtector(), () => BINDING, {
        fetch: async () => {
          calls += 1
          return new Response('', { status })
        },
        timeoutSignal: () => new AbortController().signal,
      })
      await provision(store)
      assert.deepEqual(await store.claimTicket(), { status })
      assert.equal(calls, 1)
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true })
    }
  }
})

test('only a bounded integer Retry-After on 429 supplies a recovery delay, with no automatic retry', async () => {
  for (const [status, header, delay] of [
    [429, '1', 1000], [429, '7', 7000], [429, '60', 60000],
    [429, '0', undefined], [429, '-1', undefined], [429, '61', undefined],
    [429, '1.5', undefined], [429, '1e1', undefined], [429, '2, 3', undefined],
    [401, '7', undefined], [409, '7', undefined],
  ] as const) {
    const rootDirectory = temporaryRoot()
    let calls = 0
    try {
      const store = createStore(rootDirectory, new TestProtector(), () => BINDING, {
        fetch: async () => { calls++; return new Response('', {status, headers:{'rEtRy-AfTeR':header}}) },
        timeoutSignal: () => new AbortController().signal,
      })
      await provision(store)
      assert.deepEqual(await store.claimTicket(), delay === undefined ? {status} : {status,retryAfterMs:delay})
      assert.equal(calls,1)
    } finally { rmSync(rootDirectory, {recursive:true,force:true}) }
  }
})

test('fails closed on timeout, oversized, or malformed ticket responses', async () => {
  const cases: Array<() => Promise<Response>> = [
    async () => { throw new DOMException('timed out', 'AbortError') },
    async () => new Response(Buffer.alloc(4_097), { status: 200 }),
    async () => new Response('{', {
      status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    async () => new Response(JSON.stringify({
      routeId: Buffer.alloc(16, 8).toString('base64url'),
      version: 1,
      ticket: 'AA.BB',
      expiresAtEpochMs: NOW + 1_000,
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }),
    async () => validTicketResponse(NOW),
    async () => validTicketResponse(NOW + RELAY_CONNECTOR_TICKET_TTL_MS + 1001),
  ]
  for (const fetchCase of cases) {
    const rootDirectory = temporaryRoot()
    try {
      const store = createStore(rootDirectory, new TestProtector(), () => BINDING, {
        fetch: fetchCase,
        now: () => NOW,
        timeoutSignal: () => new AbortController().signal,
      })
      await provision(store)
      await assert.rejects(store.claimTicket(), /ticket request failed/)
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true })
    }
  }
})

test('revoke invalidates in-flight work, deletes storage, and blocks ticket pickup', async () => {
  const rootDirectory = temporaryRoot()
  const protector = new TestProtector()
  let release = (): void => undefined
  const blocked = new Promise<void>(resolve => { release = resolve })
  let markStarted = (): void => undefined
  const started = new Promise<void>(resolve => { markStarted = resolve })
  protector.beforeProtect = async () => {
    markStarted()
    await blocked
  }
  try {
    const store = createStore(rootDirectory, protector)
    const pending = store.provision(CREDENTIAL, BINDING, () => BINDING)
    await started
    store.revoke()
    release()
    assert.equal(await pending, 'unauthorized')
    assert.equal(existsSync(join(rootDirectory, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)), false)
    await assert.rejects(store.claimTicket(), /ticket request failed/)
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true })
  }
})

test('recovery revision changes only after new credential publication or revocation', async () => {
  const root = temporaryRoot()
  try {
    const store = createStore(root, new TestProtector())
    assert.equal(store.recoveryRevision, 0)
    assert.equal(await store.provision(CREDENTIAL, BINDING, () => undefined), 'unauthorized')
    assert.equal(store.recoveryRevision, 0)
    await provision(store)
    assert.equal(store.recoveryRevision, 1)
    assert.equal(await store.provision(CREDENTIAL, BINDING, () => BINDING), 'unchanged')
    assert.equal(store.recoveryRevision, 1)
    await provision(store, OTHER_CREDENTIAL)
    assert.equal(store.recoveryRevision, 2)
    store.revoke()
    assert.equal(store.recoveryRevision, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('connector ticket accepts bounded clock skew and preserves its original expiration', async () => {
  for (const remaining of [60_040, 61_000]) {
    const rootDirectory = temporaryRoot()
    try {
      const store = createStore(rootDirectory, new TestProtector(), () => BINDING, {
        fetch: async () => validTicketResponse(NOW + remaining), now: () => NOW,
        timeoutSignal: () => new AbortController().signal,
      })
      await provision(store)
      const result = await store.claimTicket()
      assert.equal(result.status, 200)
      assert.ok('expiresAtEpochMs' in result)
      assert.equal(result.expiresAtEpochMs, NOW + remaining)
    } finally { rmSync(rootDirectory, { recursive: true, force: true }) }
  }
})
