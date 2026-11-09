import { observeConnection, type ConnectionObserver } from './connection-observations.js'
import { relayRemainingMs } from './relay-response-clock.js'
import { ServiceAccessFailure, ServiceAccessHint } from './service-access.js'
import { RelayNotificationStandby, type RelayNotificationProvider, type RelayPendingNotification } from './relay-notification-client.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import type { PairingV1HttpResponse } from './pairing-backend.js'
import {
  decodeRelayBusinessRequest,
  encodeRelayBusinessResponse,
  RELAY_BUSINESS_AUTHORIZATION,
  RELAY_BUSINESS_FILE_CHUNK_BYTES,
  RELAY_BUSINESS_GENERATION,
  relayBusinessHttpRequest,
} from './relay-business.js'
import {
  claimAndOpenRelayConnectorWebSocketSession,
  RelayConnectorTicketError,
  type RelayConnectorWebSocketClaimOptions,
  type RelayConnectorWebSocketSession,
} from './relay-websocket-client.js'
import { SESSION_FILE_START_PATH } from './session-file.js'
import {
  SessionRequestRouter,
  type SessionRequestRouterDependencies,
} from './session-request-router.js'

export const RELAY_BUSINESS_WEBSOCKET_URL = SERVICE_ENDPOINTS.relayUrl
// Authenticated legacy rollback only. Events mode never uses this to discover a route.
export const RELAY_BUSINESS_CONNECTOR_POLL_MS = 5_000
export const RELAY_BUSINESS_IDLE_TIMEOUT_MS = 120_000

export interface RelayBusinessWorkerOptions extends SessionRequestRouterDependencies {
  readonly observeAuthenticationTrace?: import('./authentication-observations.js').AuthenticationObserver
  readonly onRegistrationState?: (healthy: boolean) => void
  readonly observeConnection?: ConnectionObserver
  readonly observeAuthentication?:(pairingId:string)=>(()=>void)|undefined
  readonly url?: string
  readonly credentialStore: RelayConnectorWebSocketClaimOptions['credentialStore'] & Partial<RelayNotificationProvider>
  readonly registrationNotificationProvider?: RelayNotificationProvider
  /** Explicit old-protocol test/rollback; production defaults to authenticated notification negotiation. */
  readonly standbyMode?: 'legacy'
  readonly rootKeyStore: RelayConnectorWebSocketClaimOptions['rootKeyStore']
  readonly currentBinding: () => PairingAuthorizationBinding | undefined
  readonly pollMs?: number
  readonly now?: () => number
  readonly openSession?: (
    options: RelayConnectorWebSocketClaimOptions,
  ) => Promise<RelayConnectorWebSocketSession>
}

export interface RelayBusinessWorkerController {
  start(): void
  stop(): Promise<void>
}

function sameBinding(
  expected: PairingAuthorizationBinding,
  actual: PairingAuthorizationBinding | undefined,
): boolean {
  return actual !== undefined
    && expected.pairingId === actual.pairingId
    && expected.mobilePublicKeyRaw === actual.mobilePublicKeyRaw
}

function relayFileStartResponse(
  path: string,
  response: PairingV1HttpResponse,
): PairingV1HttpResponse {
  if (path !== SESSION_FILE_START_PATH || response.status !== 200
    || response.contentType !== 'application/json') return response
  try {
    const value: unknown = JSON.parse(response.body)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { status: 503, body: '' }
    const record = value as Record<string, unknown>
    if (record.type !== 'session_file_upload_started' || record.protocolVersion !== 1
      || typeof record.uploadId !== 'string' || !Number.isSafeInteger(record.chunkSize)) {
      return { status: 503, body: '' }
    }
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'session_file_upload_started',
        protocolVersion: 1,
        uploadId: record.uploadId,
        chunkSize: RELAY_BUSINESS_FILE_CHUNK_BYTES,
      }),
    }
  } catch {
    return { status: 503, body: '' }
  }
}

export class RelayBusinessWorker implements RelayBusinessWorkerController {
  private readonly url: string
  private readonly pollMs: number
  private readonly openSession: (
    options: RelayConnectorWebSocketClaimOptions,
  ) => Promise<RelayConnectorWebSocketSession>
  private stopped = true
  private epoch = 0
  private failures = 0
  private retryAt = 0
  private retryBinding: PairingAuthorizationBinding | undefined
  private retryRevision: number | undefined
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<boolean> | undefined
  private openingAbort: AbortController | undefined
  private activeSession: RelayConnectorWebSocketSession | undefined
  private lastClaimedRoute: string | undefined
  private standby: RelayNotificationStandby | undefined
  private mode: 'unknown' | 'events' | 'legacy' = 'unknown'
  private pending: RelayPendingNotification | undefined

  constructor(private readonly options: RelayBusinessWorkerOptions) {
    this.url = options.url ?? RELAY_BUSINESS_WEBSOCKET_URL
    this.pollMs = options.pollMs ?? RELAY_BUSINESS_CONNECTOR_POLL_MS
    this.openSession = options.openSession ?? claimAndOpenRelayConnectorWebSocketSession
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 1) {
      throw new Error('Relay business worker configuration failed')
    }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    const epoch = ++this.epoch
    this.failures = 0
    this.retryAt = 0
    const begin = (): void => {
      if (this.stopped || this.epoch !== epoch) return
      if (this.options.standbyMode === 'legacy') { this.mode = 'legacy'; this.schedule(0); return }
      const open = this.options.credentialStore.openNotifications
      if (!open) return // A missing capability is not permission to silently poll.
      let selected: Partial<RelayNotificationProvider> | undefined
      this.standby = new RelayNotificationStandby({
        onRegistrationState: this.options.onRegistrationState,
        observe: this.options.observeConnection,
        provider: {
          openNotifications: async handlers => {
            selected = this.options.credentialStore
            const session = await open.call(this.options.credentialStore, handlers)
            // Only a missing relay credential selects the existing free identity;
            // never hide a policy denial, network error or invalid credential.
            if (session || handlers.signal.aborted || !this.options.registrationNotificationProvider) return session
            selected = this.options.registrationNotificationProvider
            return this.options.registrationNotificationProvider.openNotifications(handlers)
          },
          serviceAccess: () => selected?.serviceAccess?.(),
          refreshServiceAccess: (manual,signal) => selected?.refreshServiceAccess?.(manual,signal) ?? Promise.resolve(),
        },
        context: () => {
          const binding = this.options.currentBinding()
          return binding ? `${binding.pairingId}:${binding.mobilePublicKeyRaw}:${this.options.credentialStore.recoveryRevision ?? 0}:${this.options.registrationNotificationProvider?.recoveryRevision ?? 0}` : undefined
        },
        onIdentityChange: () => {
          this.mode = 'unknown'; this.pending = undefined; this.failures = 0; this.retryAt = 0
          this.epoch++
          this.openingAbort?.abort()
          if (this.timer) clearTimeout(this.timer)
          this.timer = undefined
          void this.activeSession?.dispose()
        },
        onMode: mode => { this.mode = mode; if (mode === 'legacy') this.schedule(0) },
        onPending: route => {
          if (!(relayRemainingMs(route) > 0)
            || route.routeId === this.lastClaimedRoute || route.routeId === this.pending?.routeId) return
          this.pending = route
          // The authenticated phone requested a new transport. Retire only the
          // old channel; accepted host work belongs to the durable queue runtime.
          // Poll still waits for its teardown and rechecks binding/cooldown/ticket.
          void this.activeSession?.dispose()
          // Keep a server-specified cooldown even when a fresh phone request arrives.
          this.schedule(Math.max(0, this.retryAt - (this.options.now?.() ?? performance.now())))
        },
      })
      this.standby.start()
    }
    if (this.inFlight === undefined) begin()
    else void this.inFlight.then(begin, begin)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.epoch += 1
    this.pending = undefined
    const standby = this.standby
    this.standby = undefined
    // Capture this instance before awaiting teardown; a restart may begin while
    // the old stop is finishing. Never close the new instance's resources.
    const session = this.activeSession
    const inFlight = this.inFlight
    this.openingAbort?.abort()
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await standby?.stop()
    await session?.dispose()
    await inFlight?.catch(() => undefined)
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.inFlight || this.timer) return
    if(this.options.credentialStore.serviceAccess?.()?.blocked())return
    if (this.mode !== 'legacy' && !this.pending) return
    const epoch = this.epoch
    this.timer = setTimeout(() => {
      this.timer = undefined
      const current = this.poll(epoch)
      this.inFlight = current
      void current.then(hadSession => {
        if (this.inFlight === current) this.inFlight = undefined
        this.schedule(this.mode === 'legacy' ? (hadSession ? 0 : this.pollMs)
          : Math.max(0, this.retryAt - (this.options.now?.() ?? performance.now())))
      }, () => {
        if (this.inFlight === current) this.inFlight = undefined
        this.schedule(this.mode === 'legacy' ? this.pollMs : 30_000)
      })
    }, delayMs)
    this.timer.unref()
  }

  private async poll(epoch: number): Promise<boolean> {
    if (this.mode !== 'legacy') {
      if (!this.pending || this.pending.routeId === this.lastClaimedRoute || !(relayRemainingMs(this.pending) > 0)) {
        this.pending = undefined
        return false
      }
    }
    let binding: PairingAuthorizationBinding | undefined
    try {
      binding = this.options.currentBinding()
    } catch {
      observeConnection(this.options.observeConnection, 'relay_binding', 'unavailable')
      this.pending = undefined
      return false
    }
    if (binding === undefined || this.stopped || epoch !== this.epoch) {
      this.retryBinding = undefined
      this.pending = undefined
      return false
    }
    const revision = this.options.credentialStore.recoveryRevision
    if (this.retryBinding === undefined || !sameBinding(this.retryBinding, binding)
      || this.retryRevision !== revision) {
      this.failures = 0
      this.retryAt = 0
      this.retryBinding = { ...binding }
      this.retryRevision = revision
    }
    // Keep the local timer responsive to newly provisioned credentials without
    // contacting the service on every tick while failures are backed off.
    if ((this.options.now?.() ?? performance.now()) < this.retryAt) return false
    const wakingHint = this.pending
    let session: RelayConnectorWebSocketSession | undefined
    let claimedRoute: string | undefined
    let hadSession = false
    const opening = new AbortController()
    this.openingAbort = opening
    const owned = (): boolean => {
      if (this.stopped || opening.signal.aborted || epoch !== this.epoch
        || revision !== this.options.credentialStore.recoveryRevision) return false
      try {
        return sameBinding(binding!, this.options.currentBinding())
      } catch { return false }
    }
    const current = (): boolean => owned() && !this.options.credentialStore.serviceAccess?.()?.blocked()
    const guard = (): void => {
      if (!current()) opening.abort()
      opening.signal.throwIfAborted()
    }
    let authenticated:(()=>void)|undefined
    try{authenticated=this.options.observeAuthentication?.(binding.pairingId)}catch{ /* Diagnostics are optional. */ }
    try {
      session = await this.openSession({
        signal: opening.signal,
        url: this.url,
        observeConnection: (...args) => {
          if (!current()) { opening.abort(); return }
          this.options.observeConnection?.(...args)
        },
        credentialStore: {
          claimTicket: async signal => {
            guard()
            const ticket = await this.options.credentialStore.claimTicket(signal)
            guard()
            if (ticket.status === 200 && 'routeId' in ticket) {
              // The service returns its latest grant repeatedly. The relay accepts
              // that route's connector ticket once, even if the handshake then fails.
              if (ticket.routeId === this.lastClaimedRoute) throw new RelayConnectorTicketError(409)
              this.lastClaimedRoute = ticket.routeId
              claimedRoute = ticket.routeId
              // The claim response is authoritative for the hint that woke it.
              // Preserve a different hint that arrived while this claim was running.
              if (this.pending === wakingHint && wakingHint?.routeId !== ticket.routeId) this.pending = undefined
              // A newly authorized phone route is recovery evidence. Do not carry
              // old handshake failures into its next claim window (mobile waits 8s).
              this.failures = 0
              this.retryAt = 0
            }
            return ticket
          },
        },
        rootKeyStore: this.options.rootKeyStore,
        binding,
      })
      if (this.openingAbort === opening) this.openingAbort = undefined
      hadSession = true
      if (!current()) {
        await session.dispose()
        return true
      }
      this.failures = 0
      this.retryAt = 0
      observeConnection(this.options.observeConnection, 'relay_session', 'ok', claimedRoute)
      try{authenticated?.()}catch{ /* Diagnostic callbacks never grant or block business authority. */ }
      this.activeSession = session
      if (this.mode === 'events' && this.pending && this.pending.routeId !== claimedRoute) {
        // A newer request arrived while this channel was authenticating.
        await session.dispose()
        return true
      }
      await this.serve(session, binding)
      observeConnection(this.options.observeConnection, 'relay_session', 'closed', claimedRoute)
    } catch (error) {
      if (!owned()) {
        await session?.dispose()
        return hadSession
      }
      if(!this.stopped&&epoch===this.epoch&&(error instanceof ServiceAccessFailure||error instanceof ServiceAccessHint)){
        this.options.credentialStore.serviceAccess?.()?.observe(error)
        if(this.options.credentialStore.serviceAccess?.()?.blocked()){this.pending=undefined;observeConnection(this.options.observeConnection,'relay_session','paused',claimedRoute);return hadSession}
      }
      if (hadSession && !this.stopped) observeConnection(this.options.observeConnection, 'relay_session', 'closed', claimedRoute)
      await session?.dispose()
      if (!hadSession && !this.stopped && epoch === this.epoch) {
        if (error instanceof RelayConnectorTicketError && error.status === 409) {
          // A valid connector waiting for the phone's route is not a failure.
          this.failures = 0
          this.retryAt = 0
          if (this.pending === wakingHint) this.pending = undefined
        } else {
          this.failures = Math.min(this.failures + 1, 6)
          const denied = error instanceof RelayConnectorTicketError
            && (error.status === 401 || error.status === 403)
          const rateLimited = error instanceof RelayConnectorTicketError && error.status === 429
          const retry = error instanceof RelayConnectorTicketError ? error.retryAfterMs : undefined
          const delay = rateLimited
            ? (Number.isSafeInteger(retry) && retry! >= 1000 && retry! <= 60000 ? retry! : 60000)
            : Math.min((denied ? 15_000 : 3_000) * 2 ** (this.failures - 1), 30_000)
          this.retryAt = (this.options.now?.() ?? performance.now()) + delay
          if (denied) this.pending = undefined
        }
      }
    } finally {
      if (this.openingAbort === opening) this.openingAbort = undefined
      if (this.activeSession === session) this.activeSession = undefined
      if (epoch === this.epoch && this.pending?.routeId === this.lastClaimedRoute) this.pending = undefined
    }
    return hadSession
  }

  private async serve(
    session: RelayConnectorWebSocketSession,
    binding: PairingAuthorizationBinding,
  ): Promise<void> {
    const requestAbort = new AbortController()
    void session.closed.then(
      () => requestAbort.abort(),
      () => requestAbort.abort(),
    )
    const authorizer = {
      authorize: (authorization: unknown, connectionGeneration: unknown): boolean => (
        !this.stopped && !requestAbort.signal.aborted
        && authorization === RELAY_BUSINESS_AUTHORIZATION
        && connectionGeneration === RELAY_BUSINESS_GENERATION
        && sameBinding(binding, this.options.currentBinding())
      ),
    }
    const router = new SessionRequestRouter(authorizer, this.options)
    try {
      while (!this.stopped && sameBinding(binding, this.options.currentBinding())) {
        const frame = await session.receive(RELAY_BUSINESS_IDLE_TIMEOUT_MS)
        if (frame.kind !== 'data') return
        const request = decodeRelayBusinessRequest(frame.plaintext)
        const probe=request.method==='POST' && request.path==='/dshos/v1/session-state' && Buffer.from(request.body).toString('utf8')==='{"type":"diagnostic_report_request","protocolVersion":1}'
        const observe=(stage:string,result:string)=>{if(probe&&!this.stopped&&!requestAbort.signal.aborted&&sameBinding(binding,this.options.currentBinding())){try{this.options.observeAuthenticationTrace?.(request.requestId,stage,result)}catch{}}}
        observe('probe_received','started')
        let response = await router.handle(relayBusinessHttpRequest(request, requestAbort.signal))
        if (requestAbort.signal.aborted) return
        response = relayFileStartResponse(request.path, response)
        for (const part of encodeRelayBusinessResponse(request.requestId, response)) {
          if (this.stopped || !sameBinding(binding, this.options.currentBinding())) return
          await session.send(part)
        }
        observe('probe_written',response.status===200?'ok':'rejected')
      }
    } finally {
      requestAbort.abort()
      await router.dispose()
      await session.dispose()
    }
  }
}
