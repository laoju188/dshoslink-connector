import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { PairingV1HttpRequest } from '../src/pairing-backend.js'
import { sessionContentResponse } from '../src/session-content.js'
import { createSessionDetailRequestHandler, SESSION_DETAIL_PATH } from '../src/session-detail.js'
import { SESSION_VIDEO_PATH, VIDEO_CHUNK_BYTES } from '../src/session-media-contract.js'
import { isSessionRequestPath } from '../src/session-request-router.js'
import { SessionVideoService } from '../src/session-video.js'

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const digest = createHash('sha256').update(gif).digest('hex')
const videoId = 'a'.repeat(64)
const large = 5 * 1024 ** 3 + 32
const sessionId = 'media-session'
const log = () => ({
  session: { id: sessionId },
  events: [
    { seq: 0, time: 0, type: 'assistant/message', data: { message: { role: 'assistant', content: [
      { type: 'text', text: 'A published animation and video.' },
      { type: 'file', attachment: { attachmentId: 'sha256:' + digest, name: 'sample.gif', bytes: gif.length } },
      { type: 'file', attachment: { attachmentId: 'sha256:' + videoId, name: 'demo.mp4', bytes: large } },
      { type: 'file', attachment: { attachmentId: 'sha256:' + videoId, name: '../private.mp4', bytes: large } },
    ] } } },
    { seq: 1, time: 0, type: 'user/message', data: { source: { kind: 'user' }, content: [
      { type: 'file', attachment: { attachmentId: 'sha256:' + videoId, name: 'user.mp4', bytes: large } },
    ] } },
  ],
})
const request = (path: string, value: unknown, fields: Partial<PairingV1HttpRequest> = {}): PairingV1HttpRequest => ({
  path, method: 'POST', contentType: 'application/json', authorization: 'auth', connectionGeneration: 'generation',
  body: Buffer.from(JSON.stringify(value)), ...fields,
})

test('media is visible in V7 and absent from the original V6 page and relay route table', () => {
  const page = { direction: 'before', anchor: null, limit: 64 } as const
  const modern = JSON.parse(sessionContentResponse(log(), { sessionId, page, protocolVersion: 7 }))
  assert.equal(modern.page.contract, 'dshos-content-page-result-v4')
  assert.deepEqual(modern.page.items.map((item: { kind: string }) => item.kind), ['text', 'media', 'media'])
  assert.equal(modern.page.items[1].media.name, 'sample.gif')
  assert.equal(modern.page.items[2].media.bytes, large)
  assert(!JSON.stringify(modern).includes('private.mp4'))
  const old = JSON.parse(sessionContentResponse(log(), { sessionId, page, protocolVersion: 6 }))
  assert.deepEqual(old.page.items.map((item: { kind: string }) => item.kind), ['text'])
  assert(!('media' in old.page.items[0]))
  assert(!isSessionRequestPath(SESSION_VIDEO_PATH))
})

test('GIF bytes are authenticated, digest-checked, and served over the existing session detail contract', async () => {
  let reads = 0
  const handle = createSessionDetailRequestHandler({ authorize: auth => auth === 'auth' }, {
    readSession: async () => log(),
    readSurface: async () => undefined,
    readGif: async () => { reads++; return Uint8Array.from(gif) },
  })
  const body = { type: 'session_gif_request', protocolVersion: 1, sessionId, seq: 0, blockIndex: 1, id: digest, offset: 0, sha256: null }
  try {
    assert.equal((await handle(request(SESSION_DETAIL_PATH, body, { authorization: 'wrong' }))).status, 401)
    assert.equal((await handle(request(SESSION_DETAIL_PATH, { ...body, id: videoId, blockIndex: 2 }))).status, 415)
    assert.equal(reads, 0)
    const response = await handle(request(SESSION_DETAIL_PATH, body))
    assert.equal(response.status, 200)
    const chunk = JSON.parse(response.body)
    assert.equal(chunk.type, 'session_gif_chunk')
    assert.equal(chunk.sha256, digest)
    assert.deepEqual(Buffer.from(chunk.data, 'base64url'), gif)
  } finally { handle.dispose() }
})

test('LAN video reads only the requested bytes even beyond 4 GiB and closes on session change', async () => {
  let current = log()
  let closed = 0, reads = 0, permitted = true
  const video = new SessionVideoService({ authorize: (auth, generation) => permitted && auth === 'auth' && generation === 'generation' }, {
    readSession: async () => current,
    openVideo: async () => ({
      bytes: large,
      revision: 'b'.repeat(64),
      async read(offset, length, check) {
        check()
        reads++
        const bytes = Buffer.alloc(length, offset ? 7 : 0)
        if (!offset) bytes.write('ftyp', 4)
        return bytes
      },
      async close() { closed++ },
    }),
  })
  const open = { type: 'open', sessionId, seq: 0, blockIndex: 2, id: videoId }
  try {
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, { ...open, path: 'C:/secrets' }))).status, 400)
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, { ...open, seq: 1 }))).status, 404)
    const info = await video.handle(request(SESSION_VIDEO_PATH, open))
    assert.equal(info.status, 200)
    const { token, bytes, revision } = JSON.parse(info.body.toString())
    assert.equal(bytes, large)
    assert.equal(revision, 'b'.repeat(64))
    const range = { type: 'read', token, offset: large - 32, length: 32 }
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, range, { connectionGeneration: 'other' }))).status, 401)
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, { ...range, token: 'e'.repeat(64) }))).status, 404)
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, { ...range, offset: 0, length: VIDEO_CHUNK_BYTES + 1 }))).status, 416)
    assert.equal(reads, 1)
    const data = await video.handle(request(SESSION_VIDEO_PATH, range))
    assert.equal(data.contentType, 'application/octet-stream')
    assert.deepEqual(data.body, Buffer.alloc(32, 7))
    assert.equal(reads, 2)
    permitted = false
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, range))).status, 401)
    permitted = true
    current = { session: { id: sessionId }, events: [] }
    assert.equal((await video.handle(request(SESSION_VIDEO_PATH, range))).status, 409)
    assert.equal(closed, 1)
  } finally { await video.dispose() }
})
