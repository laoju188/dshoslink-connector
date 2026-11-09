import WebSocket from 'ws'
import { cloudTransportCause } from './cloud-pairing-progress.js'
import type { NotificationDetail, ConnectionEvent } from './pairing-support-contract.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { ServiceAccessGate, ServiceAccessFailure, ServiceAccessHint, parseServiceAccessFailure } from './service-access.js'
import { observeConnection, type ConnectionObserver } from './connection-observations.js'
import { RegistrationNotificationWatch } from './registration-notification-watch.js'
import { relayResponseClock, type RelayClockOptions, type RelayLifetime } from './relay-response-clock.js'

export const RELAY_NOTIFICATION_URL = `${SERVICE_ENDPOINTS.baseUrl.replace(/^https:/, 'wss:')}/v1/relay/connector/events`
export const REGISTRATION_NOTIFICATION_URL = `${SERVICE_ENDPOINTS.baseUrl.replace(/^https:/, 'wss:')}/v1/registration/connector/events`
const RELAY_NOTIFICATION_PATH = new URL(RELAY_NOTIFICATION_URL).pathname
export const RELAY_NOTIFICATION_PROTOCOL = 'dsh-relay-events.v1'
export interface RelayPendingNotification extends RelayLifetime {
  readonly routeId: string
  readonly expiresAtEpochMs: number
}
export interface RelayNotificationHandlers {
  readonly signal: AbortSignal
  readonly onMode: (mode: 'events' | 'legacy') => void
  readonly onPending: (pending: RelayPendingNotification) => void
  readonly onRegistrationState?: (healthy: boolean) => void
}
export interface RelayNotificationSession {
  readonly closed: Promise<number>
  closeReason?(): NotificationDetail['cause']
  dispose(): void
}
export class RelayNotificationError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number, readonly category: NotificationDetail['cause']='unknown') { super('Relay notification unavailable') }
}

export function openRelayNotifications(credential: Uint8Array, handlers: RelayNotificationHandlers,
  options: RelayClockOptions & { url?: string; ca?: string | Buffer } = {}): Promise<RelayNotificationSession> {
  return openNotifications(credential, handlers, options, false)
}

export function openRegistrationNotifications(credential: Uint8Array, handlers: RelayNotificationHandlers,
  options: RelayClockOptions & { url?: string; ca?: string | Buffer } = {}): Promise<RelayNotificationSession> {
  if (!handlers.onRegistrationState) return Promise.reject(new RelayNotificationError(0))
  return openNotifications(credential, handlers, options, true)
}

function openNotifications(credential: Uint8Array, handlers: RelayNotificationHandlers,
  options: RelayClockOptions & { url?: string; ca?: string | Buffer }, registrationOnly: boolean): Promise<RelayNotificationSession> {
  const url = new URL(options.url ?? (registrationOnly ? REGISTRATION_NOTIFICATION_URL : RELAY_NOTIFICATION_URL))
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash
    || url.pathname !== (registrationOnly ? new URL(REGISTRATION_NOTIFICATION_URL).pathname : RELAY_NOTIFICATION_PATH)
    || credential.byteLength !== 32) return Promise.reject(new RelayNotificationError(0))
  if (handlers.signal.aborted) return Promise.reject(new RelayNotificationError(0))
  return new Promise((resolve, reject) => {
    const requestStarted = (options.monotonic ?? (() => performance.now()))()
    let serviceNow = options.now ?? Date.now
    const socket = new WebSocket(url, RELAY_NOTIFICATION_PROTOCOL, { followRedirects: false,
      perMessageDeflate: false, maxPayload: 512, handshakeTimeout: 8000, ca: options.ca,
      headers: { Authorization: `Bearer ${Buffer.from(credential.buffer, credential.byteOffset, credential.byteLength).toString('base64url')}`,
        ...(handlers.onRegistrationState ? { 'X-DSH-Registration-Watch': '1' } : {}) } })
    let closeReason: NotificationDetail['cause']='unknown'
    let generation: string | undefined
    let mode: 'events' | 'legacy' | undefined
    let settled = false
    let closeResolve!: (code: number) => void
    const closed = new Promise<number>(done => { closeResolve = done })
    let watchdog: NodeJS.Timeout | undefined
    let registrationWatch: RegistrationNotificationWatch | undefined
    const initial = setTimeout(() => fail(new RelayNotificationError(0,undefined,'timeout')), 8000); initial.unref()
    const arm = (): void => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {closeReason='heartbeat_lost';socket.terminate()}, 35_000); watchdog.unref()
    }
    const fail = (error: Error): void => {
      if(error instanceof RelayNotificationError)closeReason=error.category
      registrationWatch?.stop()
      if (!settled) { settled = true; reject(error) }
      socket.terminate()
    }
    const abort = (): void => fail(new RelayNotificationError(0,undefined,'cancelled'))
    handlers.signal.addEventListener('abort', abort, { once: true })
    socket.on('upgrade', response => {
      if (registrationOnly) return // This channel has no relay expiry prechecks.
      try { serviceNow = relayResponseClock(response.headers.date, requestStarted, options) }
      catch { fail(new RelayNotificationError(0, undefined, 'protocol_invalid')) }
    })
    socket.on('unexpected-response', (_request, response) => {
      const seconds = response.headers['retry-after']
      const retry = typeof seconds === 'string' && /^(?:[1-9]|[1-5][0-9]|60)$/.test(seconds) ? Number(seconds) * 1000 : undefined
      const fallback = new RelayNotificationError(response.statusCode ?? 0,
        registrationOnly && (response.statusCode === 404 || response.statusCode === 400) ? 300_000 : retry)
      if ((response.statusCode===403||response.statusCode===503) && /^application\/json(?:;|$)/i.test(response.headers['content-type']??'')) {
        const chunks:Buffer[]=[];let size=0
        response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2048){response.destroy();fail(fallback)}else chunks.push(chunk)})
        response.once('end',()=>fail(parseServiceAccessFailure(response.statusCode!,Buffer.concat(chunks).toString('utf8'))??fallback))
        response.once('error',()=>fail(fallback));return
      }
      response.destroy();fail(fallback)
    })
    socket.on('error', error => {if(closeReason==='unknown')fail(new RelayNotificationError(0,undefined,cloudTransportCause(error)));else socket.terminate()})
    socket.on('ping', arm) // ws supplies the matching Pong; no second heartbeat loop.
    socket.on('message', (data, binary) => {
      try {
        if (binary || socket.protocol !== RELAY_NOTIFICATION_PROTOCOL) throw new Error()
        const parsed: unknown = JSON.parse(data.toString())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
        const frame = parsed as Record<string, unknown>
        if (generation === undefined) {
          const watch = frame.registrationWatch === 1 && !!handlers.onRegistrationState && frame.mode === 'events'
          if (registrationOnly && !watch) throw new Error()
          if (Object.keys(frame).sort().join(',') !== (watch ? 'generation,mode,registrationWatch,type,version' : 'generation,mode,type,version') || frame.type !== 'ready' || frame.version !== 1
            || typeof frame.generation !== 'string' || !canonical(frame.generation) || (frame.mode !== 'events' && frame.mode !== 'legacy')) throw new Error()
          generation = frame.generation
          mode = frame.mode
          clearTimeout(initial); arm()
          handlers.onMode(frame.mode)
          if (handlers.signal.aborted) throw new Error()
          settled = true
          resolve({ closed, closeReason:()=>closeReason, dispose: () => {closeReason='host_stopped';socket.terminate()} })
          if (watch) {
            registrationWatch = new RegistrationNotificationWatch(nonce => {
              if (socket.bufferedAmount > 4096) throw new Error()
              socket.send(JSON.stringify({ type: 'registration-check', version: 1, generation, nonce }),
                error => { if (error) fail(new RelayNotificationError(0)) })
            }, healthy => handlers.onRegistrationState?.(healthy), () => {closeReason='heartbeat_lost';socket.terminate()})
            registrationWatch.start()
          }
          return
        }
        if (registrationWatch && frame.type === 'registration-check') {
          if (Object.keys(frame).sort().join(',') !== 'generation,nonce,type,version' || frame.version !== 1
            || frame.generation !== generation || typeof frame.nonce !== 'string' || !canonical(frame.nonce)) throw new Error()
          // Delayed replies cannot renew health; nor should they disconnect a
          // still-useful business notification channel after a probe timeout.
          if (registrationWatch.accept(frame.nonce)) arm()
          return
        }
        if (registrationOnly || mode !== 'events' || Object.keys(frame).sort().join(',') !== 'expiresAtEpochMs,generation,routeId,type,version'
          || frame.type !== 'pending' || frame.version !== 1 || frame.generation !== generation
          || typeof frame.routeId !== 'string' || !canonical(frame.routeId) || !Number.isSafeInteger(frame.expiresAtEpochMs)) throw new Error()
        const now = serviceNow()
        const expires = frame.expiresAtEpochMs as number
        if (!Number.isSafeInteger(now) || now < 0) throw new Error()
        // Expired hints can occur during network recovery. Never act on them.
        if (expires <= now) return
        if (expires > now + 61_000 || socket.bufferedAmount > 4096) throw new Error()
        arm()
        socket.send(JSON.stringify({ type: 'ack', version: 1, generation, routeId: frame.routeId }))
        handlers.onPending({ routeId: frame.routeId, expiresAtEpochMs: expires, remainingMs: () => expires - serviceNow() })
      } catch { fail(new RelayNotificationError(0,undefined,'protocol_invalid')) }
    })
    socket.once('close', code => {
      if(closeReason==='unknown')closeReason='peer_closed'
      registrationWatch?.stop()
      clearTimeout(initial); if (watchdog) clearTimeout(watchdog)
      handlers.signal.removeEventListener('abort', abort)
      if (!settled) { settled = true; reject(code===4403?new ServiceAccessHint():new RelayNotificationError(0)) }
      closeResolve(code)
    })
  })
}

function canonical(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value
}

export interface RelayNotificationProvider {
  readonly recoveryRevision?: number
  openNotifications(handlers: RelayNotificationHandlers): Promise<RelayNotificationSession | undefined>
  serviceAccess?(): ServiceAccessGate | undefined
  refreshServiceAccess?(manual?:boolean,signal?:AbortSignal):Promise<unknown>
}

/** Local identity checks do not read credentials or send requests. */
export class RelayNotificationStandby {
  private stopped = true
  private context: string | undefined
  private epoch = 0
  private failures = 0
  private paused = false
  private watching?: NodeJS.Timeout
  private retry?: NodeJS.Timeout
  private opening?: Promise<void>
  private abort?: AbortController
  private session?: RelayNotificationSession
  private policyCheck?: Promise<unknown>
  private policyAbort?: AbortController
  private policyStopped = false

  constructor(private readonly options: {
    provider: RelayNotificationProvider
    context: () => string | undefined
    onMode: RelayNotificationHandlers['onMode']
    onPending: RelayNotificationHandlers['onPending']
    onIdentityChange: () => void
    onRegistrationState?: (healthy: boolean) => void
    observe?: ConnectionObserver
    random?: () => number
  }) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false; this.check()
    this.watching = setInterval(() => this.check(), 1000); this.watching.unref()
  }

  async stop(): Promise<void> {
    if(!this.stopped)observeConnection(this.options.observe,'relay_notify','closed',undefined,{cause:'host_stopped',recovery:'stopped'})
    this.stopped = true; this.epoch++
    this.options.onRegistrationState?.(false)
    if (this.watching) clearInterval(this.watching)
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined; this.context = undefined
    this.abort?.abort(); this.session?.dispose(); this.session = undefined
    this.policyAbort?.abort()
    await this.opening
  }

  private check(): void {
    if (this.stopped) return
    let context: string | undefined
    try { context = this.options.context() } catch { context = undefined }
    if (context !== this.context) {
      if(this.context)observeConnection(this.options.observe,'relay_notify','closed',undefined,{cause:'identity_changed',recovery:context?'connecting':'wait_identity'})
      this.options.onRegistrationState?.(false)
      this.context = context; this.epoch++; this.failures = 0; this.paused = false
      if (this.retry) clearTimeout(this.retry)
      this.retry = undefined
      this.abort?.abort(); this.session?.dispose(); this.session = undefined
      this.options.onIdentityChange()
      this.policyAbort?.abort();this.policyStopped=false
    }
    const access=this.options.provider.serviceAccess?.()
    if(this.context&&access?.blocked()){
      this.options.onRegistrationState?.(false)
      if(!this.policyStopped){observeConnection(this.options.observe,'relay_notify','paused',undefined,{cause:'service_restricted',recovery:'wait_policy'});this.policyStopped=true;this.paused=true;this.epoch++;this.abort?.abort();this.session?.dispose();this.session=undefined
        if(this.retry)clearTimeout(this.retry);this.retry=undefined;this.options.onIdentityChange()}
      if(!this.policyCheck&&this.options.provider.refreshServiceAccess){
        const abort=new AbortController();this.policyAbort=abort
        const operation=this.options.provider.refreshServiceAccess(false,abort.signal).catch(()=>{})
        this.policyCheck=operation;void operation.finally(()=>{if(this.policyCheck===operation)this.policyCheck=undefined})
      }
      return
    }
    if(this.policyStopped){this.policyStopped=false;this.paused=false;this.failures=0}
    if (!this.context || this.paused || this.retry || this.opening || this.session) return
    const epoch = this.epoch
    const abort = new AbortController(); this.abort = abort
    const current = (): boolean => {
      if (this.stopped || this.epoch !== epoch || abort.signal.aborted) return false
      try { return this.options.context() === this.context } catch { return false }
    }
    const operation = (async () => {
      let legacy = false
      try {
        observeConnection(this.options.observe,'relay_notify','waiting',undefined,{cause:'unknown',recovery:'connecting'})
        const session = await this.options.provider.openNotifications({ signal: abort.signal,
          ...(this.options.onRegistrationState ? { onRegistrationState: (healthy: boolean) => {
            if (current()) this.options.onRegistrationState?.(healthy)
          } } : {}),
          onMode: mode => {
            if (!current()) return
            legacy = mode === 'legacy'
            observeConnection(this.options.observe,'relay_notify',legacy?'legacy':'ok',undefined,{cause:'unknown',recovery:'ready'})
            this.options.onMode(mode)
          }, onPending: route => { if (current()) {
            observeConnection(this.options.observe,'relay_notify_delivery','ok',route.routeId)
            this.options.onPending(route)
          } } })
        if (!current()) { session?.dispose(); return }
        if (!session) { this.paused = true; observeConnection(this.options.observe,'relay_notify','not_required',undefined,{cause:'credential_missing',recovery:'wait_identity'}); return }
        this.session = session
        const connectedAt = performance.now()
        void session.closed.then(code => {
          if (this.session === session) this.session = undefined
          if (!current() || this.paused) return
          this.options.onRegistrationState?.(false)
          // An authenticated rollback is cached, not permanent. Re-negotiate
          // infrequently so enabling events does not require a DSH restart.
          if (legacy && code === 4010) { this.backoff(300_000); return }
          if (code === 4001 || code === 4009) {
            this.paused = true
            observeConnection(this.options.observe,'relay_notify',code===4001?'unauthorized':'replaced',undefined,{cause:code===4001?'authorization_rejected':'replaced',recovery:'wait_identity'})
            return
          }
          if(code===4403){this.options.provider.serviceAccess?.()?.observe(new ServiceAccessHint());this.check();return}
          if (performance.now() - connectedAt >= 60_000) this.failures = 0
          this.backoff(code === 1013 ? 30_000 : undefined,code===1013?'server_busy':session.closeReason?.()??'peer_closed')
        })
      } catch (error) {
        if (!current()) return
        this.options.onRegistrationState?.(false)
        if(error instanceof ServiceAccessFailure||error instanceof ServiceAccessHint){
          this.options.provider.serviceAccess?.()?.observe(error)
          if(this.options.provider.serviceAccess?.()?.blocked()){observeConnection(this.options.observe,'relay_notify','paused');return}
        }
        const unauthorized=error instanceof RelayNotificationError&&(error.status===401||error.status===403)
        const limited=error instanceof RelayNotificationError&&error.status===429
        const cause:NotificationDetail['cause']=unauthorized?'authorization_rejected':limited?'server_busy':error instanceof RelayNotificationError?error.category:cloudTransportCause(error)??'unknown'
        if (unauthorized) {this.paused=true;observeConnection(this.options.observe,'relay_notify','unauthorized',undefined,{cause,recovery:'wait_identity'})}
        else this.backoff(error instanceof RelayNotificationError ? error.retryAfterMs : undefined,cause,limited?'rate_limited':'unavailable')
      }
    })()
    this.opening = operation
    void operation.finally(() => { if (this.opening === operation) this.opening = undefined })
  }

  private backoff(minimum?: number,cause:NotificationDetail['cause']='unknown',result:ConnectionEvent['result']='unavailable'): void {
    if (this.stopped || this.retry) return
    const base = Math.min(1000 * 2 ** Math.min(this.failures++, 5), 30_000)
    const jitter = Math.max(0, Math.min(1, (this.options.random ?? Math.random)()))
    // A server floor must not collapse every client onto the same deadline.
    const delay = minimum === undefined ? base * (0.5 + jitter / 2)
      : Math.max(minimum, base) + jitter * Math.min(30_000, Math.max(minimum, base) / 2)
    observeConnection(this.options.observe,'relay_notify',result,undefined,{cause,recovery:'retry_scheduled',retryInMs:Math.ceil(delay)})
    this.retry = setTimeout(() => { this.retry = undefined; this.check() }, delay)
    this.retry.unref()
  }
}
