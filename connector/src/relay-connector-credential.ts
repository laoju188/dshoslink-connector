import { randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startupStorageError } from './startup-observation.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { ServiceAccessGate, ServiceAccessFailure, parseServiceAccess, parseServiceAccessFailure, type ServiceAccessView } from './service-access.js'
import { openRelayNotifications, type RelayNotificationHandlers, type RelayNotificationSession } from './relay-notification-client.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { PairingIdentityProtector } from './pairing-identity-store.js'
import { createWindowsRelayConnectorCredentialDataProtector } from './windows-dpapi.js'
import { relayResponseClock } from './relay-response-clock.js'

export const RELAY_CONNECTOR_CREDENTIAL_PATH = '/connection/v1/relay-connector-credential'
export const RELAY_CONNECTOR_CREDENTIAL_FILE_NAME = `relay-connector-credential${SERVICE_ENDPOINTS.credentialSuffix}-v1.json`
export const RELAY_CONNECTOR_TICKET_URL = `${SERVICE_ENDPOINTS.baseUrl}/v1/relay/tickets/connector`
export const RELAY_CONNECTOR_TICKET_TTL_MS = 60_000
export const RELAY_CONNECTOR_TICKET_ISSUANCE_SKEW_MS = 1_000

const CREDENTIAL_BYTES = 32
const IDENTITY_ID_BYTES = 32
const PAIRING_ID_BYTES = 16
const MOBILE_PUBLIC_KEY_BYTES = 32
const MAX_PROTECTED_CREDENTIAL_BYTES = 4_096
const MAX_TICKET_RESPONSE_BYTES = 4_096
const TICKET_REQUEST_TIMEOUT_MS = 8_000
const DOMAIN = Buffer.from('DSHOS-LINK/RELAY-CONNECTOR-CREDENTIAL/V1\0', 'utf8')
const PLAINTEXT_BYTES = DOMAIN.byteLength
  + IDENTITY_ID_BYTES
  + PAIRING_ID_BYTES
  + MOBILE_PUBLIC_KEY_BYTES
  + CREDENTIAL_BYTES
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const TICKET_PATTERN = /^([A-Za-z0-9_-]{1,3072})\.([A-Za-z0-9_-]{43})$/

export type RelayConnectorCredentialProvisionResult =
  | 'stored'
  | 'unchanged'
  | 'unauthorized'

export type RelayConnectorTicketResult =
  | {
    readonly status: 200
    readonly routeId: string
    readonly ticket: string
    readonly expiresAtEpochMs: number
    readonly remainingMs?: () => number
  }
  | { readonly status: number; readonly retryAfterMs?: number }

export interface RelayConnectorCredentialAuthorizer {
  authorizePairing(
    authorization?: string,
    connectionGeneration?: string,
  ): PairingAuthorizationBinding | undefined
}

export interface RelayConnectorCredentialStoreOptions {
  readonly notificationTransport?: typeof openRelayNotifications
  readonly rootDirectory: string
  readonly identityId: string
  readonly currentBinding: () => PairingAuthorizationBinding | undefined
  readonly protector?: PairingIdentityProtector
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly monotonic?: () => number
  readonly timeoutSignal?: (timeoutMs: number) => AbortSignal
}

function storageFailure(error?: unknown): never {
  throw startupStorageError('Relay connector credential storage failed', error)
}

function ticketFailure(): never {
  throw new Error('Relay connector ticket request failed')
}

function decodeCanonical(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === length && decoded.toString('base64url') === value
    ? decoded
    : undefined
}

function validBinding(value: PairingAuthorizationBinding): PairingAuthorizationBinding {
  const pairingId = decodeCanonical(value.pairingId, PAIRING_ID_BYTES)
  const mobilePublicKeyRaw = decodeCanonical(value.mobilePublicKeyRaw, MOBILE_PUBLIC_KEY_BYTES)
  try {
    if (pairingId === undefined || mobilePublicKeyRaw === undefined) storageFailure()
    return Object.freeze({
      pairingId: value.pairingId,
      mobilePublicKeyRaw: value.mobilePublicKeyRaw,
    })
  } finally {
    pairingId?.fill(0)
    mobilePublicKeyRaw?.fill(0)
  }
}

function sameBinding(
  expected: PairingAuthorizationBinding,
  actual: PairingAuthorizationBinding | undefined,
): boolean {
  return actual !== undefined
    && expected.pairingId === actual.pairingId
    && expected.mobilePublicKeyRaw === actual.mobilePublicKeyRaw
}

function equalSecret(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && timingSafeEqual(
      Buffer.from(left.buffer, left.byteOffset, left.byteLength),
      Buffer.from(right.buffer, right.byteOffset, right.byteLength),
    )
}

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

function parseCredential(body: Uint8Array): Buffer | undefined {
  if (!(body instanceof Uint8Array) || body.byteLength === 0
    || body.byteLength > MAX_TICKET_RESPONSE_BYTES) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).join(',') !== 'type,protocolVersion,connectorCredential'
      || (value as Record<string, unknown>).type !== 'relay_connector_credential'
      || (value as Record<string, unknown>).protocolVersion !== 1
      || JSON.stringify(value) !== text) return undefined
    return decodeCanonical(
      (value as Record<string, unknown>).connectorCredential,
      CREDENTIAL_BYTES,
    )
  } catch {
    return undefined
  }
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_TICKET_RESPONSE_BYTES)) {
    ticketFailure()
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      const chunk = Buffer.from(item.value)
      item.value.fill(0)
      total += chunk.byteLength
      if (total > MAX_TICKET_RESPONSE_BYTES) {
        chunk.fill(0)
        await reader.cancel().catch(() => undefined)
        ticketFailure()
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
  } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
}

function parseTicketResponse(body: Buffer, nowEpochMs: number): RelayConnectorTicketResult {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).join(',') !== 'version,routeId,ticket,expiresAtEpochMs'
      || (value as Record<string, unknown>).version !== 1
      || JSON.stringify(value) !== text) ticketFailure()
    const record = value as Record<string, unknown>
    const routeId = decodeCanonical(record.routeId, 16)
    const ticket = record.ticket
    const expiresAtEpochMs = record.expiresAtEpochMs
    const match = typeof ticket === 'string' ? TICKET_PATTERN.exec(ticket) : null
    const payload = match === null ? undefined : decodeCanonical(
      match[1], Buffer.from(match[1], 'base64url').byteLength,
    )
    const signature = match === null ? undefined : decodeCanonical(match[2], 32)
    try {
      if (routeId === undefined || payload === undefined || payload.byteLength === 0
        || signature === undefined
        || !Number.isSafeInteger(expiresAtEpochMs)
        || (expiresAtEpochMs as number) <= nowEpochMs
        || (expiresAtEpochMs as number) - nowEpochMs > RELAY_CONNECTOR_TICKET_TTL_MS + RELAY_CONNECTOR_TICKET_ISSUANCE_SKEW_MS) {
        ticketFailure()
      }
      // This is a semantic precheck, not signature verification. The relay
      // alone holds the HMAC key and verifies it before accepting the route.
      const claimsText = new TextDecoder('utf-8', { fatal: true }).decode(payload)
      const claims = JSON.parse(claimsText)
      if (!claims || typeof claims !== 'object' || Array.isArray(claims)
        || Object.keys(claims).join(',') !== 'version,ticketId,routeId,role,accountBindingHash,computerBindingHash,issuedAtEpochMs,expiresAtEpochMs'
        || JSON.stringify(claims) !== claimsText || claims.version !== 1 || claims.role !== 'connector'
        || claims.routeId !== record.routeId || claims.expiresAtEpochMs !== expiresAtEpochMs
        || !decodeCanonical(claims.ticketId, 16)
        || typeof claims.accountBindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(claims.accountBindingHash)
        || typeof claims.computerBindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(claims.computerBindingHash)
        || !Number.isSafeInteger(claims.issuedAtEpochMs) || claims.issuedAtEpochMs < 0
        || claims.issuedAtEpochMs > nowEpochMs + RELAY_CONNECTOR_TICKET_ISSUANCE_SKEW_MS
        || claims.expiresAtEpochMs <= claims.issuedAtEpochMs
        || claims.expiresAtEpochMs - claims.issuedAtEpochMs > RELAY_CONNECTOR_TICKET_TTL_MS) ticketFailure()
      return {
        status: 200,
        routeId: record.routeId as string,
        ticket: ticket as string,
        expiresAtEpochMs: expiresAtEpochMs as number,
      }
    } finally {
      routeId?.fill(0)
      payload?.fill(0)
      signature?.fill(0)
    }
  } catch {
    return ticketFailure()
  }
}

export class RelayConnectorCredentialStore {
  private readonly path: string
  private readonly identityId: Buffer
  private revision = 0
  private mutation = Promise.resolve()
  private recoveryGeneration = 0
  private accessBinding = ''
  private access = new ServiceAccessGate(() => performance.now())

  serviceAccess(): ServiceAccessGate {
    const binding = this.options.currentBinding()
    const key = binding ? JSON.stringify(binding) : ''
    if (key !== this.accessBinding) { this.accessBinding = key; this.access = new ServiceAccessGate(() => performance.now()) }
    return this.access
  }

  async refreshServiceAccess(manual = false, signal?: AbortSignal): Promise<ServiceAccessView> {
    const gate = this.serviceAccess(), revision = this.revision, binding = this.readCurrentBinding()
    const guard = (): void => { signal?.throwIfAborted(); if (!this.isCurrent(revision,binding) || this.serviceAccess() !== gate) ticketFailure() }
    const restored = await gate.check(() => this.serialized(async () => {
      guard(); const credential = await this.load(binding); guard()
      if (!credential) ticketFailure()
      try {
        const timeout=(this.options.timeoutSignal ?? AbortSignal.timeout)(TICKET_REQUEST_TIMEOUT_MS)
        const response = await (this.options.fetch ?? fetch)(`${SERVICE_ENDPOINTS.baseUrl}/v1/service-access/connector`, {
          method:'GET',headers:{Authorization:`Bearer ${credential.toString('base64url')}`},cache:'no-store',redirect:'error',
          signal:signal?AbortSignal.any([signal,timeout]):timeout })
        const body=await readBoundedResponse(response)
        try { guard(); if (response.status !== 200 || response.headers.get('content-type') !== 'application/json; charset=utf-8') ticketFailure()
          return parseServiceAccess(new TextDecoder('utf-8',{fatal:true}).decode(body))
        } finally { body.fill(0) }
      } finally { credential.fill(0) }
    }),manual,guard)
    guard(); if(restored)this.recoveryGeneration++
    return gate.view()
  }

  get recoveryRevision(): number { return this.recoveryGeneration }

  constructor(private readonly options: RelayConnectorCredentialStoreOptions) {
    if (typeof options.rootDirectory !== 'string' || options.rootDirectory.length === 0
      || typeof options.currentBinding !== 'function') storageFailure()
    const identityId = decodeCanonical(options.identityId, IDENTITY_ID_BYTES)
    if (identityId === undefined) storageFailure()
    this.identityId = Buffer.from(identityId)
    identityId.fill(0)
    this.path = join(options.rootDirectory, RELAY_CONNECTOR_CREDENTIAL_FILE_NAME)
  }

  async provision(
    credential: Uint8Array,
    requestedBinding: PairingAuthorizationBinding,
    reauthorize: () => PairingAuthorizationBinding | undefined,
    initialOnly = false,
  ): Promise<RelayConnectorCredentialProvisionResult> {
    if (!(credential instanceof Uint8Array) || credential.byteLength !== CREDENTIAL_BYTES) {
      storageFailure()
    }
    const binding = validBinding(requestedBinding)
    const ownedCredential = Buffer.from(credential)
    return this.serialized(async () => {
      const revision = this.revision
      const authorized = (): boolean => {
        if (this.revision !== revision) return false
        try {
          return sameBinding(binding, reauthorize())
            && sameBinding(binding, this.options.currentBinding())
        } catch {
          return false
        }
      }
      try {
        if (!authorized()) return 'unauthorized'
        const existing = await this.load(binding)
        if (!authorized()) return 'unauthorized'
        if (existing !== undefined) {
          try {
            if (equalSecret(existing, ownedCredential)) return 'unchanged'
            // A delayed first-pairing delivery must never replace credentials
            // already changed through the authenticated business connection.
            if (initialOnly) return 'unauthorized'
          } finally {
            existing.fill(0)
          }
        }
        if (!authorized()) return 'unauthorized'
        const plaintext = this.plaintext(binding, ownedCredential)
        let protectedCredential: Buffer | undefined
        try {
          protectedCredential = await this.protector().protect(plaintext)
          if (!(protectedCredential instanceof Buffer)
            || protectedCredential.byteLength === 0
            || protectedCredential.byteLength > MAX_PROTECTED_CREDENTIAL_BYTES) storageFailure()
          if (!authorized()) return 'unauthorized'
          const result = await this.publish(protectedCredential, authorized)
          if (result === 'stored') this.recoveryGeneration += 1
          return result
        } finally {
          plaintext.fill(0)
          protectedCredential?.fill(0)
        }
      } finally {
        ownedCredential.fill(0)
      }
    })
  }

  revoke(): void {
    this.revision += 1
    this.recoveryGeneration += 1
    try {
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure(error)
    }
  }

  async claimTicket(signal?: AbortSignal): Promise<RelayConnectorTicketResult> {
    return this.serialized(async () => {
      signal?.throwIfAborted()
      const access = this.serviceAccess(); access.assert()
      const revision = this.revision
      const binding = this.readCurrentBinding()
      let credential: Buffer | undefined
      try {
        credential = await this.load(binding)
      } catch {
        ticketFailure()
      }
      if (credential === undefined || !this.isCurrent(revision, binding)) ticketFailure()
      try {
        signal?.throwIfAborted()
        const timeout = (this.options.timeoutSignal ?? AbortSignal.timeout)(TICKET_REQUEST_TIMEOUT_MS)
        const requestStarted = (this.options.monotonic ?? (() => performance.now()))()
        const response = await (this.options.fetch ?? fetch)(RELAY_CONNECTOR_TICKET_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${credential.toString('base64url')}` },
          cache: 'no-store',
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
        let serviceNow: (() => number) | undefined
        try {
          if (response.status === 200) serviceNow = relayResponseClock(response.headers.get('date'), requestStarted, this.options)
        } catch (error) {
          await response.body?.cancel().catch(() => undefined)
          throw error
        }
        const body = await readBoundedResponse(response)
        try {
          signal?.throwIfAborted()
          if (!this.isCurrent(revision, binding)) ticketFailure()
          if (response.status !== 200) {
            if (response.headers.get('content-type') === 'application/json; charset=utf-8') {
              const failure=parseServiceAccessFailure(response.status,body.toString('utf8'))
              if(failure){access.observe(failure);throw failure}
            }
            const retry = response.headers.get('retry-after')
            if (response.status === 429 && retry !== null && /^(?:[1-9]|[1-5][0-9]|60)$/.test(retry)) {
              return { status: response.status, retryAfterMs: Number(retry) * 1000 }
            }
            return { status: response.status }
          }
          if (response.headers.get('content-type') !== 'application/json; charset=utf-8') {
            ticketFailure()
          }
          const nowEpochMs = serviceNow!()
          if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) ticketFailure()
          const ticket = parseTicketResponse(body, nowEpochMs)
          return response.headers.has('date') && ticket.status === 200 && 'expiresAtEpochMs' in ticket
            ? { ...ticket, remainingMs: () => ticket.expiresAtEpochMs - serviceNow!() } : ticket
        } finally {
          body.fill(0)
        }
      } catch (error) {
        if(error instanceof ServiceAccessFailure)throw error
        return ticketFailure()
      } finally {
        credential.fill(0)
      }
    })
  }

  async openNotifications(handlers: RelayNotificationHandlers): Promise<RelayNotificationSession | undefined> {
    // Serialize only credential load and the bounded handshake, never the life
    // of the control socket. Ticket claims and credential updates stay usable.
    return this.serialized(async () => {
      const access=this.serviceAccess();access.assert()
      const revision = this.revision
      const binding = this.readCurrentBinding()
      const credential = await this.load(binding)
      if (!credential) return undefined
      try {
        if (handlers.signal.aborted || !this.isCurrent(revision, binding)) return undefined
        const session = await (this.options.notificationTransport ?? openRelayNotifications)(credential, {
          signal: handlers.signal,
          onMode: mode => { if (this.isCurrent(revision, binding)) handlers.onMode(mode) },
          onPending: route => { if (this.isCurrent(revision, binding)) handlers.onPending(route) },
          ...(handlers.onRegistrationState ? { onRegistrationState: (healthy: boolean) => {
            if (this.isCurrent(revision, binding)) handlers.onRegistrationState?.(healthy)
          } } : {}),
        }, { now: this.options.now, monotonic: this.options.monotonic })
        if (!this.isCurrent(revision, binding) || handlers.signal.aborted) { session.dispose(); return undefined }
        return session
      } catch(error) { if(this.isCurrent(revision,binding))access.observe(error as Object);throw error }
      finally { credential.fill(0) }
    })
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation
    let release = (): void => undefined
    this.mutation = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private readCurrentBinding(): PairingAuthorizationBinding {
    try {
      const binding = this.options.currentBinding()
      if (binding === undefined) ticketFailure()
      return validBinding(binding)
    } catch {
      return ticketFailure()
    }
  }

  private isCurrent(revision: number, binding: PairingAuthorizationBinding): boolean {
    if (this.revision !== revision) return false
    try {
      return sameBinding(binding, this.options.currentBinding())
    } catch {
      return false
    }
  }

  private async load(binding: PairingAuthorizationBinding): Promise<Buffer | undefined> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      storageFailure()
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      storageFailure()
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).join(',') !== 'storageVersion,protectedCredential'
      || (value as Record<string, unknown>).storageVersion !== 1
      || typeof (value as Record<string, unknown>).protectedCredential !== 'string'
      || JSON.stringify(value) !== text) storageFailure()
    const encoded = (value as { readonly protectedCredential: string }).protectedCredential
    const protectedCredential = decodeCanonical(
      encoded, Buffer.from(encoded, 'base64url').byteLength,
    )
    if (protectedCredential === undefined || protectedCredential.byteLength === 0
      || protectedCredential.byteLength > MAX_PROTECTED_CREDENTIAL_BYTES) storageFailure()
    let plaintext: Buffer | undefined
    try {
      plaintext = await this.protector().unprotect(protectedCredential)
      if (!(plaintext instanceof Buffer) || plaintext.byteLength !== PLAINTEXT_BYTES) storageFailure()
      let offset = 0
      if (!plaintext.subarray(offset, offset + DOMAIN.byteLength).equals(DOMAIN)) storageFailure()
      offset += DOMAIN.byteLength
      if (!plaintext.subarray(offset, offset + IDENTITY_ID_BYTES).equals(this.identityId)) {
        storageFailure()
      }
      offset += IDENTITY_ID_BYTES
      const pairingId = Buffer.from(binding.pairingId, 'base64url')
      const mobilePublicKeyRaw = Buffer.from(binding.mobilePublicKeyRaw, 'base64url')
      try {
        if (!plaintext.subarray(offset, offset + PAIRING_ID_BYTES).equals(pairingId)) {
          storageFailure()
        }
        offset += PAIRING_ID_BYTES
        if (!plaintext.subarray(offset, offset + MOBILE_PUBLIC_KEY_BYTES)
          .equals(mobilePublicKeyRaw)) storageFailure()
      } finally {
        pairingId.fill(0)
        mobilePublicKeyRaw.fill(0)
      }
      offset += MOBILE_PUBLIC_KEY_BYTES
      return Buffer.from(plaintext.subarray(offset, offset + CREDENTIAL_BYTES))
    } finally {
      protectedCredential.fill(0)
      plaintext?.fill(0)
    }
  }

  private plaintext(binding: PairingAuthorizationBinding, credential: Buffer): Buffer {
    const pairingId = Buffer.from(binding.pairingId, 'base64url')
    const mobilePublicKeyRaw = Buffer.from(binding.mobilePublicKeyRaw, 'base64url')
    try {
      return Buffer.concat([
        DOMAIN,
        this.identityId,
        pairingId,
        mobilePublicKeyRaw,
        credential,
      ], PLAINTEXT_BYTES)
    } finally {
      pairingId.fill(0)
      mobilePublicKeyRaw.fill(0)
    }
  }

  private async publish(
    protectedCredential: Buffer,
    authorized: () => boolean,
  ): Promise<RelayConnectorCredentialProvisionResult> {
    const temporary = join(
      this.options.rootDirectory,
      `.${RELAY_CONNECTOR_CREDENTIAL_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    )
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let published = false
    try {
      await mkdir(this.options.rootDirectory, { recursive: true })
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({
        storageVersion: 1,
        protectedCredential: protectedCredential.toString('base64url'),
      }), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (!authorized()) return 'unauthorized'
      await rename(temporary, this.path)
      published = true
      if (!authorized()) {
        this.removePublished()
        published = false
        return 'unauthorized'
      }
      return 'stored'
    } finally {
      await handle?.close().catch(() => undefined)
      if (published && !authorized()) this.removePublished()
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private removePublished(): void {
    try {
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure()
    }
  }

  private protector(): PairingIdentityProtector {
    return this.options.protector ?? createWindowsRelayConnectorCredentialDataProtector()
  }
}

export function createRelayConnectorCredentialRequestHandler(
  authorizer: RelayConnectorCredentialAuthorizer,
  store: RelayConnectorCredentialStore,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    try {
      const barePath = request.path.split(/[?#]/, 1)[0]!
      if (barePath !== RELAY_CONNECTOR_CREDENTIAL_PATH) return emptyResponse(404)
      if (request.method !== 'PUT') return emptyResponse(405)
      if (request.path !== barePath || request.contentType !== 'application/json') {
        return emptyResponse(400)
      }
      const credential = parseCredential(request.body)
      if (credential === undefined) return emptyResponse(400)
      try {
        const binding = authorizer.authorizePairing(
          request.authorization, request.connectionGeneration,
        )
        if (binding === undefined || request.signal?.aborted) return emptyResponse(401)
        try {
          const result = await store.provision(credential, binding, () => {
            if (request.signal?.aborted) return undefined
            return authorizer.authorizePairing(
              request.authorization, request.connectionGeneration,
            )
          })
          return result === 'stored' || result === 'unchanged'
            ? emptyResponse(204)
            : emptyResponse(401)
        } catch {
          return emptyResponse(503)
        }
      } finally {
        credential.fill(0)
      }
    } finally {
      if (request.body instanceof Uint8Array) {
        try {
          request.body.fill(0)
        } catch {
          // Best effort: caller-owned views may be non-writable.
        }
      }
    }
  }
}
