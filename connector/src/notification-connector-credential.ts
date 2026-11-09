import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startupStorageError } from './startup-observation.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { PairingIdentityProtector } from './pairing-identity-store.js'
import {
  isCriticalNotificationType,
  type CriticalNotificationType,
} from './critical-notification.js'
import { createWindowsNotificationConnectorCredentialDataProtector } from './windows-dpapi.js'
import { parseDshRegistrationChallenge, registrationBytes, registrationTranscript, type RegistrationTrust } from './dsh-registration-contract.js'
import { openRegistrationNotifications, type RelayNotificationHandlers, type RelayNotificationSession } from './relay-notification-client.js'

export const NOTIFICATION_CONNECTOR_CREDENTIAL_PATH =
  '/connection/v1/notification-connector-credential'
export const NOTIFICATION_CONNECTOR_CREDENTIAL_FILE_NAME =
  `notification-connector-credential${SERVICE_ENDPOINTS.credentialSuffix}-v1.json`
export const CRITICAL_NOTIFICATION_SUBMIT_URL = `${SERVICE_ENDPOINTS.baseUrl}/v1/critical-notifications`

const CREDENTIAL_BYTES = 32
const IDENTITY_ID_BYTES = 32
const PAIRING_ID_BYTES = 16
const MOBILE_PUBLIC_KEY_BYTES = 32
const MAX_PROTECTED_CREDENTIAL_BYTES = 4_096
const MAX_RESPONSE_BYTES = 4_096
const REQUEST_TIMEOUT_MS = 8_000
const DOMAIN = Buffer.from('DSHOS-LINK/CRITICAL-NOTIFICATION-CREDENTIAL/V1\0', 'utf8')
const PLAINTEXT_BYTES = DOMAIN.byteLength
  + IDENTITY_ID_BYTES
  + PAIRING_ID_BYTES
  + MOBILE_PUBLIC_KEY_BYTES
  + CREDENTIAL_BYTES
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export type NotificationConnectorCredentialProvisionResult =
  | 'stored'
  | 'unchanged'
  | 'unauthorized'

export interface NotificationDeliveryContext { readonly revision: number; readonly binding: PairingAuthorizationBinding }

// Local termination is not an HTTP rejection and must never be retried.
export type NotificationSubmissionResult = number | 'stopped'

export interface CriticalNotificationSubmission {
  readonly completionAtMs?: number
  readonly eventId: string
  readonly eventType: CriticalNotificationType
}

export interface NotificationConnectorCredentialAuthorizer {
  authorizePairing(
    authorization?: string,
    connectionGeneration?: string,
  ): PairingAuthorizationBinding | undefined
}

export interface NotificationConnectorCredentialStoreOptions {
  readonly rootDirectory: string
  readonly identityId: string
  readonly currentBinding: () => PairingAuthorizationBinding | undefined
  readonly protector?: PairingIdentityProtector
  readonly fetch?: typeof fetch
  readonly timeoutSignal?: (timeoutMs: number) => AbortSignal
  readonly notificationTransport?: typeof openRegistrationNotifications
}

function storageFailure(error?: unknown): never {
  throw startupStorageError('Notification connector credential storage failed', error)
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

function sameBinding(expected: PairingAuthorizationBinding,
  actual: PairingAuthorizationBinding | undefined): boolean {
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
    || body.byteLength > MAX_RESPONSE_BYTES) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).join(',') !== 'type,protocolVersion,notificationConnectorCredential'
      || (value as Record<string, unknown>).type !== 'notification_connector_credential'
      || (value as Record<string, unknown>).protocolVersion !== 1
      || JSON.stringify(value) !== text) return undefined
    return decodeCanonical(
      (value as Record<string, unknown>).notificationConnectorCredential,
      CREDENTIAL_BYTES,
    )
  } catch {
    return undefined
  }
}

function validSubmission(value: CriticalNotificationSubmission): boolean {
  if (value.completionAtMs !== undefined && (value.eventType !== 'TASK_COMPLETED'
    || !Number.isSafeInteger(value.completionAtMs) || value.completionAtMs < 0)) return false
  if (!EVENT_ID_PATTERN.test(value.eventId) || !isCriticalNotificationType(value.eventType)) {
    return false
  }
  const eventId = Buffer.from(value.eventId, 'base64url')
  return eventId.byteLength === 16 && eventId.toString('base64url') === value.eventId
}

async function discardBoundedResponse(response: Response): Promise<boolean> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    return false
  }
  if (response.body === null) return true
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return true
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return false
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0)
    reader.releaseLock()
  }
}

export class NotificationConnectorCredentialStore {
  private readonly path: string
  private readonly identityId: Buffer
  private revision = 0
  private recoveryGeneration = 0
  private mutation = Promise.resolve()
  private lastBinding: PairingAuthorizationBinding | undefined
  private suspended = false
  private readonly activeRequests = new Set<AbortController>()

  get recoveryRevision(): number { return this.recoveryGeneration }

  constructor(private readonly options: NotificationConnectorCredentialStoreOptions) {
    if (typeof options.rootDirectory !== 'string' || options.rootDirectory.length === 0
      || typeof options.currentBinding !== 'function') storageFailure()
    const identityId = decodeCanonical(options.identityId, IDENTITY_ID_BYTES)
    if (identityId === undefined) storageFailure()
    this.identityId = Buffer.from(identityId)
    identityId.fill(0)
    this.path = join(options.rootDirectory, NOTIFICATION_CONNECTOR_CREDENTIAL_FILE_NAME)
    this.captureDeliveryContext()
  }

  async provision(credential: Uint8Array, requestedBinding: PairingAuthorizationBinding,
    reauthorize: () => PairingAuthorizationBinding | undefined,
  ): Promise<NotificationConnectorCredentialProvisionResult> {
    if (!(credential instanceof Uint8Array) || credential.byteLength !== CREDENTIAL_BYTES) {
      storageFailure()
    }
    const binding = validBinding(requestedBinding)
    const ownedCredential = Buffer.from(credential)
    return this.serialized(async () => {
      const revision = this.revision
      const authorized = (): boolean => {
        if (this.suspended || this.revision !== revision) return false
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
          } finally {
            existing.fill(0)
          }
        }
        const plaintext = this.plaintext(binding, ownedCredential)
        let protectedCredential: Buffer | undefined
        try {
          protectedCredential = await this.protector().protect(plaintext)
          if (!(protectedCredential instanceof Buffer)
            || protectedCredential.byteLength === 0
            || protectedCredential.byteLength > MAX_PROTECTED_CREDENTIAL_BYTES
            || !authorized()) return 'unauthorized'
          const result = await this.publish(protectedCredential, authorized)
          if (result === 'stored') this.recoveryGeneration++
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
    this.recoveryGeneration++
    this.lastBinding = undefined
    for (const request of this.activeRequests) request.abort()
    try {
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure(error)
    }
  }

  // Capture ownership when the event occurs, not when a retry eventually runs.
  captureDeliveryContext(): NotificationDeliveryContext | undefined {
    if (this.suspended) return undefined
    try {
      const value = this.options.currentBinding()
      this.lastBinding = value === undefined ? undefined : validBinding(value)
    } catch {
      // Only retain an already verified binding. An unknown owner is never guessed.
    }
    return this.lastBinding === undefined ? undefined
      : Object.freeze({ revision: this.revision, binding: Object.freeze({ ...this.lastBinding }) })
  }

  suspend(): void {
    this.suspended = true
    this.revision += 1
    this.recoveryGeneration++
    this.lastBinding = undefined
    for (const request of this.activeRequests) request.abort()
  }

  async openNotifications(handlers: RelayNotificationHandlers): Promise<RelayNotificationSession | undefined> {
    return this.serialized(async () => {
      if (this.suspended || handlers.signal.aborted) return undefined
      const binding = this.readCurrentBinding(), revision = this.revision, recovery = this.recoveryGeneration
      const current = (): boolean => !handlers.signal.aborted && recovery === this.recoveryGeneration
        && this.isCurrent(revision, binding)
      const request = new AbortController()
      this.activeRequests.add(request)
      let credential: Buffer | undefined, session: RelayNotificationSession | undefined
      try {
        credential = await this.load(binding)
        if (!current() || !credential) return undefined
        session = await (this.options.notificationTransport ?? openRegistrationNotifications)(credential, {
          signal: AbortSignal.any([handlers.signal, request.signal]),
          onMode: mode => { if (current() && mode === 'events') handlers.onMode(mode) },
          // Registration-only credentials never request a paid relay route.
          onPending: () => undefined,
          onRegistrationState: healthy => { if (current()) handlers.onRegistrationState?.(healthy) },
        })
        void session.closed.then(() => this.activeRequests.delete(request))
        if (!current()) { session.dispose(); return undefined }
        return session
      } finally {
        credential?.fill(0)
        if (!session) this.activeRequests.delete(request)
      }
    })
  }

  private deliveryState(context: NotificationDeliveryContext): 'current' | 'unavailable' | 'stale' {
    if (this.suspended || context.revision !== this.revision) return 'stale'
    try {
      const current = this.options.currentBinding()
      this.lastBinding = current === undefined ? undefined : validBinding(current)
      return sameBinding(context.binding, this.lastBinding) ? 'current' : 'stale'
    } catch { return 'unavailable' }
  }

  async submitCriticalNotification(notification: CriticalNotificationSubmission,
    expected = this.captureDeliveryContext()): Promise<NotificationSubmissionResult> {
    if (!validSubmission(notification)) throw new Error('Critical notification submission failed')
    if (!expected) return 'stopped'
    return this.serialized<NotificationSubmissionResult>(async () => {
      const state = this.deliveryState(expected)
      if (state !== 'current') return state === 'stale' ? 'stopped' : 0
      let credential: Buffer | undefined
      const request = new AbortController()
      try {
        credential = await this.load(expected.binding)
        const beforeSend = this.deliveryState(expected)
        if (beforeSend !== 'current') return beforeSend === 'stale' ? 'stopped' : 0
        // Initial provisioning can race the first event. Keep its original owner
        // while waiting; no credential and no local I/O failure is a server 401.
        if (credential === undefined) return 0
        this.activeRequests.add(request)
        const response = await (this.options.fetch ?? fetch)(CRITICAL_NOTIFICATION_SUBMIT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential.toString('base64url')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ version: notification.completionAtMs === undefined ? 1 : 2, eventId: notification.eventId, eventType: notification.eventType,
            ...(notification.completionAtMs === undefined ? {} : { completionAtMs: notification.completionAtMs }) }),
          cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([request.signal,
            (this.options.timeoutSignal ?? AbortSignal.timeout)(REQUEST_TIMEOUT_MS)]),
        })
        // An authenticated server rejection remains terminal even if a later
        // local read fails. Never turn a real 401/403 into a transient retry.
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel().catch(() => undefined)
          return response.status
        }
        const bounded = await discardBoundedResponse(response)
        const afterSend = this.deliveryState(expected)
        if (afterSend !== 'current') return afterSend === 'stale' ? 'stopped' : 0
        return bounded ? response.status : 0
      } catch {
        return this.deliveryState(expected) === 'stale' ? 'stopped' : 0
      } finally {
        this.activeRequests.delete(request)
        credential?.fill(0)
      }
    })
  }

  // DSH-only migration proof. Never return the historical credential or accept a caller-supplied service key/URL.
  async proveLegacyRegistration(signedChallenge: Uint8Array, trust: RegistrationTrust, expectedBody: Uint8Array,
    expectedBinding: PairingAuthorizationBinding, assertCurrent: () => void, now: () => number): Promise<object> {
    if (typeof assertCurrent !== 'function' || typeof now !== 'function') throw Error('registration_confirmation')
    return this.serialized(async () => {
      assertCurrent()
      const revision = this.revision, binding = this.readCurrentBinding()
      const check = () => { assertCurrent(); if (!sameBinding(expectedBinding, binding) || !this.isCurrent(revision, binding)) throw Error('registration_binding') }
      check()
      const body = parseDshRegistrationChallenge(signedChallenge, trust, now())
      if (body.purpose !== 'bootstrap' || body.mobilePublicKey !== binding.mobilePublicKeyRaw
        || !registrationBytes(body).equals(expectedBody)) throw Error('registration_scope')
      const credential = await this.load(binding)
      if (!credential) throw Error('registration_legacy_unavailable')
      let key: Buffer | undefined
      try {
        check(); parseDshRegistrationChallenge(signedChallenge, trust, now())
        key = Buffer.from(credential.toString('base64url'), 'ascii')
        const mac = createHmac('sha256', key).update(registrationTranscript('REGISTRATION/BOOTSTRAP-LEGACY', {
          body, oldPairingId: binding.pairingId, oldMobilePublicKey: binding.mobilePublicKeyRaw,
        })).digest('base64url')
        check()
        return { contract: 'dshos-legacy-proof-v2', oldPairingId: binding.pairingId, oldMobilePublicKey: binding.mobilePublicKeyRaw, mac }
      } finally { credential.fill(0); key?.fill(0) }
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
      if (binding === undefined) storageFailure()
      return validBinding(binding)
    } catch {
      return storageFailure()
    }
  }

  private isCurrent(revision: number, binding: PairingAuthorizationBinding): boolean {
    if (this.suspended || this.revision !== revision) return false
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
      return Buffer.concat([DOMAIN, this.identityId, pairingId, mobilePublicKeyRaw, credential],
        PLAINTEXT_BYTES)
    } finally {
      pairingId.fill(0)
      mobilePublicKeyRaw.fill(0)
    }
  }

  private async publish(protectedCredential: Buffer,
    authorized: () => boolean): Promise<NotificationConnectorCredentialProvisionResult> {
    const temporary = join(this.options.rootDirectory,
      `.${NOTIFICATION_CONNECTOR_CREDENTIAL_FILE_NAME}.${process.pid}.`
      + `${randomBytes(8).toString('hex')}.tmp`)
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
    return this.options.protector ?? createWindowsNotificationConnectorCredentialDataProtector()
  }
}

export function createNotificationConnectorCredentialRequestHandler(
  authorizer: NotificationConnectorCredentialAuthorizer,
  store: NotificationConnectorCredentialStore,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    try {
      const barePath = request.path.split(/[?#]/, 1)[0]!
      if (barePath !== NOTIFICATION_CONNECTOR_CREDENTIAL_PATH) return emptyResponse(404)
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
      } finally {
        credential.fill(0)
      }
    } finally {
      if (request.body instanceof Uint8Array) {
        try {
          request.body.fill(0)
        } catch {
        }
      }
    }
  }
}
