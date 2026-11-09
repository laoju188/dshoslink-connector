import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PairingAuthorizationBinding } from '../src/pairing-auth.js'
import {
  decodeRelayBusinessResponsePart,
  encodeRelayBusinessRequest,
  RELAY_BUSINESS_FILE_CHUNK_BYTES,
} from '../src/relay-business.js'
import { RelayBusinessWorker } from '../src/relay-business-worker.js'
import type {
  RelayConnectorWebSocketSession,
  RelayReceivedFrame,
} from '../src/relay-websocket-client.js'
import { SESSION_FILE_START_PATH } from '../src/session-file.js'
import { SESSION_LIST_PATH } from '../src/session-list.js'
import { SESSION_STATE_PATH } from '../src/session-control.js'
import {
  SESSION_QUESTION_RESPONSE_PATH,
  type SessionQuestionAnswerItem,
} from '../src/session-question.js'
import { SESSION_STREAM_PATH } from '../src/session-stream.js'

const BINDING: PairingAuthorizationBinding = {
  pairingId: Buffer.alloc(16, 1).toString('base64url'),
  mobilePublicKeyRaw: Buffer.alloc(32, 2).toString('base64url'),
}

test('relay probe observations match the encrypted request ID without bypassing the diagnostic router', async () => {
  const events:unknown[]=[]
  const session=new FakeRelaySession([encodeRelayBusinessRequest({requestId:'A'.repeat(22),method:'POST',path:SESSION_STATE_PATH,
    contentType:'application/json',body:Buffer.from('{"type":"diagnostic_report_request","protocolVersion":1}')})])
  const active=worker(session,()=>BINDING,{
    credentialStore:{async claimTicket(){throw Error('unused')}},rootKeyStore:{async withRootKey(){throw Error('unused')}},currentBinding:()=>BINDING,
    observeAuthenticationTrace:(...args)=>{events.push(args)},
    // Missing source remains an ordinary 503. Observations must never make it successful.
  })
  active.start();try{await session.sentOne;await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,[['A'.repeat(22),'probe_received','started'],['A'.repeat(22),'probe_written','rejected']])
  }finally{await active.stop()}
})

class FakeRelaySession implements RelayConnectorWebSocketSession {
  readonly sent: Uint8Array[] = []
  readonly closed: Promise<void>
  private readonly incoming: RelayReceivedFrame[]
  private waitingReject: ((error: Error) => void) | undefined
  private disposed = false
  private sentResolve: (() => void) | undefined
  private closedResolve: (() => void) | undefined
  readonly sentOne: Promise<void>

  constructor(requests: readonly Uint8Array[]) {
    this.incoming = requests.map(plaintext => ({ kind: 'data', plaintext }))
    this.sentOne = new Promise<void>(resolve => { this.sentResolve = resolve })
    this.closed = new Promise<void>(resolve => { this.closedResolve = resolve })
  }

  async send(plaintext: Uint8Array): Promise<void> {
    if (this.disposed) throw new Error('disposed')
    this.sent.push(new Uint8Array(plaintext))
    this.sentResolve?.()
  }

  receive(): Promise<RelayReceivedFrame> {
    if (this.disposed) return Promise.reject(new Error('disposed'))
    const next = this.incoming.shift()
    if (next !== undefined) return Promise.resolve(next)
    return new Promise<RelayReceivedFrame>((_resolve, reject) => {
      this.waitingReject = reject
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closedResolve?.()
    this.waitingReject?.(new Error('disposed'))
    this.waitingReject = undefined
  }
}

function worker(session: FakeRelaySession, binding: () => PairingAuthorizationBinding | undefined,
  extras: ConstructorParameters<typeof RelayBusinessWorker>[0] = {
    credentialStore: { async claimTicket() { throw new Error('unused') } },
    rootKeyStore: { async withRootKey() { throw new Error('unused') } },
    currentBinding: binding,
  }): RelayBusinessWorker {
  return new RelayBusinessWorker({ standbyMode: 'legacy',
    ...extras,
    credentialStore: extras.credentialStore,
    rootKeyStore: extras.rootKeyStore,
    currentBinding: binding,
    pollMs: 60_000,
    async openSession() { return session },
  })
}

test('routes the fixed session surface through one encrypted relay route', async () => {
  let authenticated=0,business=0
  const session = new FakeRelaySession([encodeRelayBusinessRequest({
    requestId: 'A'.repeat(22),
    method: 'GET',
    path: SESSION_LIST_PATH,
    body: new Uint8Array(),
  })])
  const active = worker(session, () => BINDING, {
    credentialStore: { async claimTicket() { throw new Error('unused') } },
    rootKeyStore: { async withRootKey() { throw new Error('unused') } },
    currentBinding: () => BINDING,
    observeAuthentication: pairingId=>{assert.equal(pairingId,BINDING.pairingId);return ()=>{authenticated++}},
    observeBusinessRequest: ()=>()=>{business++},
    sessionListSource: {
      async listSessions() {
        return [{ header: { id: 'session-1', createdAt: 1 }, live: true, persisted: true }]
      },
      async readTitleSnapshots() {
        return [{ sessionId: 'session-1', status: 'fulfilled', value: { title: { title: '测试会话' } } }]
      },
    },
  })
  active.start()
  try {
    await session.sentOne
    const part = decodeRelayBusinessResponsePart(session.sent[0]!)
    assert.equal(part.status, 200)
    assert.equal(authenticated,1)
    assert.equal(business,1)
    assert.deepEqual(JSON.parse(Buffer.from(part.body).toString('utf8')), {
      type: 'session_list',
      protocolVersion: 1,
      truncated: false,
      sessions: [{
        sessionId: 'session-1', createdAt: 1, live: true, persisted: true, title: '测试会话',
      }],
    })
  } finally {
    await active.stop()
  }
})

test('normalizes custom question answers through the encrypted relay route', async () => {
  const body = Buffer.from(JSON.stringify({
    type: 'session_question_answer_request',
    protocolVersion: 1,
    sessionId: 'session-1',
    questionRpcId: 'question-rpc-1',
    answers: [{ id: 'choice', selected: [], custom: '  中继自定义答案  ' }],
  }))
  const session = new FakeRelaySession([encodeRelayBusinessRequest({
    requestId: 'Q'.repeat(22),
    method: 'POST',
    path: SESSION_QUESTION_RESPONSE_PATH,
    contentType: 'application/json',
    body,
  })])
  let received: readonly SessionQuestionAnswerItem[] | undefined
  const active = worker(session, () => BINDING, {
    credentialStore: { async claimTicket() { throw new Error('unused') } },
    rootKeyStore: { async withRootKey() { throw new Error('unused') } },
    currentBinding: () => BINDING,
    sessionQuestionSource: {
      list() { return { requests: [], truncated: false } },
      async answer(_sessionId, _questionRpcId, answers) {
        received = answers
        return 'accepted'
      },
      async cancel() { return 'accepted' },
    },
  })
  active.start()
  try {
    await session.sentOne
    const part = decodeRelayBusinessResponsePart(session.sent[0]!)
    assert.equal(part.status, 200)
    assert.deepEqual(JSON.parse(Buffer.from(part.body).toString('utf8')), {
      type: 'session_question_response_accepted',
      protocolVersion: 1,
      accepted: true,
    })
    assert.deepEqual(received, [
      { id: 'choice', selected: [], custom: '中继自定义答案' },
    ])
  } finally {
    await active.stop()
  }
})

test('uses relay-sized file chunks and tears down temporary state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshos-link-relay-file-test-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const body = Buffer.from(JSON.stringify({
    type: 'session_file_upload_start',
    protocolVersion: 1,
    sessionId: 'session-1',
    fileName: 'relay.bin',
    size: 1,
  }))
  const session = new FakeRelaySession([encodeRelayBusinessRequest({
    requestId: 'B'.repeat(22),
    method: 'POST',
    path: SESSION_FILE_START_PATH,
    contentType: 'application/json',
    body,
  })])
  const active = worker(session, () => BINDING, {
    credentialStore: { async claimTicket() { throw new Error('unused') } },
    rootKeyStore: { async withRootKey() { throw new Error('unused') } },
    currentBinding: () => BINDING,
    sessionFileSource: {
      async readSurface(sessionId: string) {
        return { session: { id: sessionId, cwd: workspace }, capturedThroughSeq: null, events: [] }
      },
    },
  })
  active.start()
  try {
    await session.sentOne
    const part = decodeRelayBusinessResponsePart(session.sent[0]!)
    const payload = JSON.parse(Buffer.from(part.body).toString('utf8')) as { chunkSize: number }
    assert.equal(payload.chunkSize, RELAY_BUSINESS_FILE_CHUNK_BYTES)
  } finally {
    await active.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('fails closed when the current pairing binding is revoked', async () => {
  let current: PairingAuthorizationBinding | undefined = BINDING
  let sourceCalls = 0
  const request = encodeRelayBusinessRequest({
    requestId: 'C'.repeat(22),
    method: 'GET',
    path: SESSION_LIST_PATH,
    body: new Uint8Array(),
  })
  class RevokingSession extends FakeRelaySession {
    override receive(): Promise<RelayReceivedFrame> {
      current = undefined
      return Promise.resolve({ kind: 'data', plaintext: request })
    }
  }
  const session = new RevokingSession([])
  const active = worker(session, () => current, {
    credentialStore: { async claimTicket() { throw new Error('unused') } },
    rootKeyStore: { async withRootKey() { throw new Error('unused') } },
    currentBinding: () => current,
    sessionListSource: {
      async listSessions() { sourceCalls += 1; return [] },
      async readTitleSnapshots() { sourceCalls += 1; return [] },
    },
  })
  active.start()
  await new Promise(resolve => setTimeout(resolve, 30))
  await active.stop()
  assert.equal(sourceCalls, 0)
  assert.equal(session.sent.length, 0)
})

test('closes the encrypted route for an invalid Session Control V1 envelope', async () => {
  const invalidRequest = Buffer.from(JSON.stringify({
    type: 'relay_business_request',
    protocolVersion: 1,
    requestId: 'E'.repeat(22),
    method: 'GET',
    path: SESSION_STATE_PATH,
    contentType: '',
    body: '',
  }))
  let current: PairingAuthorizationBinding | undefined = BINDING
  const session = new FakeRelaySession([invalidRequest])
  void session.closed.then(() => { current = undefined })
  const active = worker(session, () => current)
  active.start()
  try {
    await Promise.race([
      session.closed,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('relay route stayed open')), 250)
      }),
    ])
    assert.equal(session.sent.length, 0)
  } finally {
    await active.stop()
  }
})

test('aborts an in-flight stream wait when the encrypted route closes', async () => {
  const body = Buffer.from(JSON.stringify({
    type: 'session_stream_request',
    protocolVersion: 1,
    sessionId: 'session-1',
    afterSeq: 8,
    partialSeq: null,
  }))
  const session = new FakeRelaySession([encodeRelayBusinessRequest({
    requestId: 'D'.repeat(22),
    method: 'POST',
    path: SESSION_STREAM_PATH,
    contentType: 'application/json',
    body,
  })])
  let waitStartedResolve: (() => void) | undefined
  let waitAbortedResolve: (() => void) | undefined
  const waitStarted = new Promise<void>(resolve => { waitStartedResolve = resolve })
  const waitAborted = new Promise<void>(resolve => { waitAbortedResolve = resolve })
  const active = worker(session, () => BINDING, {
    credentialStore: { async claimTicket() { throw new Error('unused') } },
    rootKeyStore: { async withRootKey() { throw new Error('unused') } },
    currentBinding: () => BINDING,
    sessionStreamSource: {
      wait(_sessionId, _afterSeq, _partialSeq, signal) {
        waitStartedResolve?.()
        return new Promise((_resolve, reject) => {
          const abort = (): void => {
            waitAbortedResolve?.()
            reject(new Error('aborted'))
          }
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      },
    },
  })
  active.start()
  try {
    await waitStarted
    session.dispose()
    await waitAborted
    assert.equal(session.sent.length, 0)
  } finally {
    await active.stop()
  }
})
