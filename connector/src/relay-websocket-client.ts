import { observeConnection, type ConnectionObserver } from './connection-observations.js'
import { ServiceAccessHint } from './service-access.js'
import { relayRemainingMs } from './relay-response-clock.js'
import WebSocket from 'ws'
import { performance } from 'node:perf_hooks'
import type { RawData } from 'ws'
import {
  RELAY_CONNECTOR_TICKET_TTL_MS,
  RELAY_CONNECTOR_TICKET_ISSUANCE_SKEW_MS,
  type RelayConnectorTicketResult,
} from './relay-connector-credential.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import {
  createRelayCipherState,
  createRelayHello,
  deriveRelaySessionSecrets,
  RELAY_FRAME_MAX_WIRE_BYTES,
  type RelayCipherState,
  type RelayFrameKind,
  type RelayHelloState,
} from './relay-transport.js'

export const RELAY_WEBSOCKET_PATH = '/v1/relay/connect'
export const RELAY_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 8_000
export const RELAY_WEBSOCKET_PEER_WAIT_TIMEOUT_MS = 45_000
const RELAY_WEBSOCKET_CLOSE_TIMEOUT_MS = 2_000
export const RELAY_WEBSOCKET_MAX_BUFFERED_BYTES = 1024 * 1024

const READY_PATTERN = /^\{"type":"relay_ready","protocolVersion":1,"routeId":"([A-Za-z0-9_-]+)"\}$/
const TICKET_PATTERN = /^[A-Za-z0-9_-]{1,3072}\.[A-Za-z0-9_-]{43}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export interface RelayConnectorWebSocketOptions {
  readonly signal?: AbortSignal
  readonly observeConnection?: ConnectionObserver
  readonly url: string
  readonly ticket: RelayConnectorTicketResult
  readonly rootKey: Uint8Array
  readonly ca?: string | Buffer
  readonly now?: () => number
  readonly timeoutMs?: number
}

export interface RelayReceivedFrame {
  readonly kind: RelayFrameKind
  readonly plaintext: Uint8Array
}

export interface RelayConnectorWebSocketSession {
  readonly closed: Promise<void>
  send(plaintext: Uint8Array): Promise<void>
  receive(timeoutMs?: number): Promise<RelayReceivedFrame>
  dispose(): void | Promise<void>
}

export interface RelayConnectorWebSocketClaimOptions {
  readonly signal?: AbortSignal
  readonly observeConnection?: ConnectionObserver
  readonly url: string
  readonly credentialStore: RelayConnectorTicketClaimer
  readonly rootKeyStore: RelayConnectorRootKeyProvider
  readonly binding: PairingAuthorizationBinding
  readonly ca?: string | Buffer
  readonly now?: () => number
  readonly timeoutMs?: number
}

export class RelayConnectorTicketError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) { super('Relay connector ticket unavailable') }
}

export interface RelayConnectorTicketClaimer {
  readonly recoveryRevision?: number
  claimTicket(signal?: AbortSignal): Promise<RelayConnectorTicketResult>
}

export interface RelayConnectorRootKeyProvider {
  withRootKey<T>(binding: PairingAuthorizationBinding,
    operation: (rootKey: Uint8Array) => Promise<T>): Promise<T>
}

interface QueueWaiter {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

function failure(): Error {
  return new Error('Relay WSS connection failed')
}

// Storage may finish after cancellation. Observe its result for cleanup, but
// never make a stopped opening wait for it or adopt its late session.
function openingStep<T>(operation: Promise<T>, signal?: AbortSignal,
  discard?: (value: T) => void | Promise<void>): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    let settled = false
    const cancel = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      reject(failure())
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    void operation.then(value => {
      signal.removeEventListener('abort', cancel)
      if (settled) {
        if (discard) void Promise.resolve().then(() => discard(value)).catch(() => undefined)
        return
      }
      settled = true
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', cancel)
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

function decodeRouteId(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === 16 && decoded.toString('base64url') === value
    ? decoded
    : undefined
}

function validUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw failure()
  }
  const sandbox = value === 'wss://dshoslink.cn/sandbox/v1/relay/connect'
  if (parsed.protocol !== 'wss:' || (!sandbox && parsed.pathname !== RELAY_WEBSOCKET_PATH)
    || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '') throw failure()
  return parsed
}

class RelayReadTimeout extends Error {}

class RelayTextQueue {
  private readonly values: string[] = []
  private readonly waiters: QueueWaiter[] = []
  private queuedBytes = 0
  private failed: Error | undefined
  private resolveClosed!: () => void
  readonly closed: Promise<void>
  private resolveTransportClosed!: () => void
  private readonly transportClosed: Promise<void>
  private transportFinished = false
  private closing = false
  private terminated = false
  private closeTimer: NodeJS.Timeout | undefined

  constructor(private readonly socket: WebSocket) {
    this.closed = new Promise<void>(resolve => { this.resolveClosed = resolve })
    this.transportClosed = new Promise<void>(resolve => { this.resolveTransportClosed = resolve })
    socket.on('message', (data, isBinary) => {
      if (this.failed !== undefined) return
      if (isBinary) {
        this.fail()
        return
      }
      const value = rawText(data)
      const bytes = Buffer.byteLength(value, 'utf8')
      if (bytes < 1 || bytes > RELAY_FRAME_MAX_WIRE_BYTES
        || this.queuedBytes + bytes > RELAY_WEBSOCKET_MAX_BUFFERED_BYTES) {
        this.fail()
        return
      }
      const waiter = this.waiters.shift()
      if (waiter === undefined) {
        this.values.push(value)
        this.queuedBytes += bytes
      }
      else {
        clearTimeout(waiter.timer)
        waiter.resolve(value)
      }
    })
    socket.once('close', code => { this.finishTransportClose(); this.fail(false,code===4403?new ServiceAccessHint():undefined) })
    socket.once('error', () => this.fail())
  }

  next(timeoutMs: number): Promise<string> {
    const value = this.values.shift()
    if (value !== undefined) {
      this.queuedBytes -= Buffer.byteLength(value, 'utf8')
      return Promise.resolve(value)
    }
    if (this.failed !== undefined) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => {
      const waiter: QueueWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new RelayReadTimeout())
        }, timeoutMs),
      }
      waiter.timer.unref()
      this.waiters.push(waiter)
    })
  }

  dispose(graceful = false): Promise<void> {
    this.fail(graceful)
    return this.transportClosed
  }

  private fail(graceful = false, reason?:Error): void {
    if (this.failed === undefined) {
      this.failed = reason ?? failure()
      // Business cancellation is immediate; only transport cleanup may wait.
      this.resolveClosed()
      this.values.length = 0
      this.queuedBytes = 0
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(this.failed)
      }
    }
    if (this.transportFinished) return
    if (this.socket.readyState === WebSocket.CLOSED) { this.finishTransportClose(); return }
    if (this.closing) {
      if (!graceful) this.forceClose()
      return
    }
    this.closing = true
    this.closeTimer = setTimeout(() => {
      this.forceClose()
      this.finishTransportClose()
    }, RELAY_WEBSOCKET_CLOSE_TIMEOUT_MS)
    if (graceful && this.socket.readyState === WebSocket.OPEN) {
      try { this.socket.close(1000) } catch { this.forceClose() }
    } else this.forceClose()
  }

  private forceClose(): void {
    if (this.transportFinished || this.terminated) return
    this.terminated = true
    try { this.socket.terminate() } catch { this.finishTransportClose() }
  }

  private finishTransportClose(): void {
    if (this.transportFinished) return
    this.transportFinished = true
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer)
      this.closeTimer = undefined
    }
    this.resolveTransportClosed()
  }
}

function waitForOpen(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(failure()), timeoutMs)
    timer.unref()
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('error', onError)
      socket.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve()
      else reject(error)
    }
    const onOpen = (): void => finish()
    const onError = (): void => finish(failure())
    const onClose = (): void => finish(failure())
    const onAbort = (): void => finish(failure())
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function sendText(socket: WebSocket, value: string): Promise<void> {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (socket.readyState !== WebSocket.OPEN
    || socket.bufferedAmount + bytes > RELAY_WEBSOCKET_MAX_BUFFERED_BYTES) {
    return Promise.reject(failure())
  }
  return new Promise((resolve, reject) => {
    try {
      socket.send(value, { binary: false, compress: false }, error => {
        if (error) reject(failure())
        else resolve()
      })
    } catch {
      reject(failure())
    }
  })
}

class EstablishedRelayConnectorSession implements RelayConnectorWebSocketSession {
  private disposed = false
  readonly closed: Promise<void>

  constructor(private readonly socket: WebSocket,
    private readonly queue: RelayTextQueue,
    private readonly cipher: RelayCipherState,
    private readonly timeoutMs: number) {
    this.closed = queue.closed
  }

  async send(plaintext: Uint8Array): Promise<void> {
    if (this.disposed || !(plaintext instanceof Uint8Array)) throw failure()
    try {
      await sendText(this.socket, this.cipher.encrypt(plaintext))
    } catch {
      void this.close(false)
      throw failure()
    }
  }

  async receive(timeoutMs: number = this.timeoutMs): Promise<RelayReceivedFrame> {
    if (this.disposed) throw failure()
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw failure()
    try {
      return this.cipher.decrypt(await this.queue.next(timeoutMs))
    } catch (error) {
      // Only an established channel's idle deadline is a normal close. Protocol,
      // cryptographic and network failures retain their forced-close behavior.
      void this.close(error instanceof RelayReadTimeout)
      if(error instanceof ServiceAccessHint)throw error
      throw failure()
    }
  }

  dispose(): Promise<void> { return this.close(true) }

  private close(graceful: boolean): Promise<void> {
    // A reader rejected by an intentional cancellation must not turn that
    // cancellation into a forced termination while the close frame is in flight.
    if (this.disposed) return this.queue.dispose(true)
    this.disposed = true
    this.cipher.dispose()
    return this.queue.dispose(graceful)
  }
}

export async function openRelayConnectorWebSocketSession(
  options: RelayConnectorWebSocketOptions,
): Promise<RelayConnectorWebSocketSession> {
  options.signal?.throwIfAborted()
  const now = options.now ?? Date.now
  const nowEpochMs = now()
  const timeoutMs = options.timeoutMs ?? RELAY_WEBSOCKET_HANDSHAKE_TIMEOUT_MS
  const ticket = options.ticket
  const remaining = ticket.status === 200 && 'expiresAtEpochMs' in ticket ? relayRemainingMs(ticket, now) : NaN
  const usesResponseClock = ticket.status === 200 && 'remainingMs' in ticket && ticket.remainingMs !== undefined
  if ((!usesResponseClock && (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 1))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || timeoutMs > RELAY_WEBSOCKET_HANDSHAKE_TIMEOUT_MS
    || !(options.rootKey instanceof Uint8Array) || options.rootKey.byteLength !== 32
    || ticket.status !== 200 || !('ticket' in ticket)
    || !TICKET_PATTERN.test(ticket.ticket)
    || !Number.isSafeInteger(ticket.expiresAtEpochMs)
    || !Number.isFinite(remaining) || remaining <= 0
    || remaining > RELAY_CONNECTOR_TICKET_TTL_MS + RELAY_CONNECTOR_TICKET_ISSUANCE_SKEW_MS) {
    throw failure()
  }
  const routeId = decodeRouteId(ticket.routeId)
  if (routeId === undefined) throw failure()
  const url = validUrl(options.url)
  const rootKey = Buffer.from(options.rootKey)
  const started = performance.now()
  const budget = (maximum: number, reserve = 0): number => {
    options.signal?.throwIfAborted()
    const left = Math.min(remaining - Math.max(0, performance.now() - started), relayRemainingMs(ticket, now)) - reserve
    if (!Number.isFinite(left) || left < 1) throw new RelayReadTimeout()
    return Math.max(1, Math.floor(Math.min(maximum, left)))
  }
  let socket: WebSocket | undefined
  let queue: RelayTextQueue | undefined
  let hello: RelayHelloState | undefined
  let cipher: RelayCipherState | undefined
  let stage: 'relay_socket' | 'relay_peer' | 'relay_handshake' = 'relay_socket'
  const cancel = (): void => { void queue?.dispose() }
  try {
    socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${ticket.ticket}` },
      handshakeTimeout: budget(timeoutMs),
      maxPayload: RELAY_FRAME_MAX_WIRE_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: true,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    })
    queue = new RelayTextQueue(socket)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    await waitForOpen(socket, budget(timeoutMs), options.signal)
    options.signal?.throwIfAborted()
    observeConnection(options.observeConnection, stage, 'ok', ticket.routeId)
    stage = 'relay_peer'
    observeConnection(options.observeConnection, stage, 'waiting', ticket.routeId)
    // Peer arrival and cryptographic negotiation have separate budgets. Never
    // wait beyond the original ticket lifetime; leave room for authentication.
    const ready = READY_PATTERN.exec(await queue.next(budget(RELAY_WEBSOCKET_PEER_WAIT_TIMEOUT_MS, timeoutMs)))
    options.signal?.throwIfAborted()
    if (ready === null || ready[1] !== ticket.routeId) throw failure()
    observeConnection(options.observeConnection, stage, 'ok', ticket.routeId)
    stage = 'relay_handshake'
    budget(timeoutMs)
    hello = createRelayHello('connector', rootKey, routeId)
    await openingStep(sendText(socket, hello.text), options.signal)
    const secrets = deriveRelaySessionSecrets(hello, await queue.next(budget(timeoutMs)), rootKey)
    try {
      cipher = createRelayCipherState('connector', secrets)
    } finally {
      secrets.sessionId.fill(0)
      secrets.mobileToConnectorKey.fill(0)
      secrets.connectorToMobileKey.fill(0)
    }
    budget(timeoutMs)
    observeConnection(options.observeConnection, stage, 'ok', ticket.routeId)
    options.signal?.throwIfAborted()
    const session = new EstablishedRelayConnectorSession(socket, queue, cipher, timeoutMs)
    socket = undefined
    queue = undefined
    cipher = undefined
    return session
  } catch (error) {
    if (!options.signal?.aborted) observeConnection(options.observeConnection, stage, error instanceof RelayReadTimeout ? 'timeout' : 'failed', ticket.routeId)
    cipher?.dispose()
    if (queue !== undefined) await queue.dispose(error instanceof RelayReadTimeout)
    else if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate()
    if(error instanceof ServiceAccessHint)throw error
    throw failure()
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    hello?.routeId.fill(0)
    hello?.nonce.fill(0)
    hello?.publicKeyDer.fill(0)
    routeId.fill(0)
    rootKey.fill(0)
  }
}

export async function claimAndOpenRelayConnectorWebSocketSession(
  options: RelayConnectorWebSocketClaimOptions,
): Promise<RelayConnectorWebSocketSession> {
  options.signal?.throwIfAborted()
  const observeTicket = (status: number, routeId?: string): void => {
    if (options.signal?.aborted) return
    observeConnection(options.observeConnection, 'relay_ticket', status === 200 ? 'ok'
      : status === 409 ? 'waiting' : status === 429 ? 'rate_limited'
      : status === 401 || status === 403 ? 'unauthorized' : 'unavailable', routeId)
  }
  let ticket: RelayConnectorTicketResult
  try {
    ticket = await openingStep(options.credentialStore.claimTicket(options.signal), options.signal)
    options.signal?.throwIfAborted()
  }
  catch (error) {
    // The worker also uses 409 for a route whose one-use ticket was already claimed.
    observeTicket(error instanceof RelayConnectorTicketError && error.status !== 200 ? error.status : 0)
    throw error
  }
  const routeId = ticket.status === 200 && 'routeId' in ticket ? ticket.routeId : undefined
  observeTicket(ticket.status, routeId)
  if (ticket.status !== 200) throw new RelayConnectorTicketError(ticket.status,
    'retryAfterMs' in ticket ? ticket.retryAfterMs : undefined)
  let keyLoaded = false
  try {
    options.signal?.throwIfAborted()
    return await openingStep(options.rootKeyStore.withRootKey(options.binding, rootKey => {
      options.signal?.throwIfAborted()
      keyLoaded = true
      observeConnection(options.observeConnection, 'relay_key', 'ok', routeId)
      return openRelayConnectorWebSocketSession({
        url: options.url, ticket, rootKey, ca: options.ca, now: options.now,
        timeoutMs: options.timeoutMs, observeConnection: options.observeConnection, signal: options.signal,
      })
    }), options.signal, session => session.dispose())
  } catch (error) {
    if (!keyLoaded && !options.signal?.aborted) observeConnection(options.observeConnection, 'relay_key', 'unavailable', routeId)
    throw error
  }
}
