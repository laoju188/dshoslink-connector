import { createPublicKey, randomBytes } from 'node:crypto'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import { DshRegistration } from './dsh-registration.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { pairingClockOffset } from './dsh-pairing-time.js'
import { registrationBytes as bytes, registrationFields as fields, registrationId as id,
  registrationJson as json, type JsonRecord, type RegistrationTrust } from './dsh-registration-contract.js'

export const DSH_REGISTRATION_PREFIX = '/connection/v2/registration/'
export async function loadDshRegistrationTrust(signal: AbortSignal): Promise<RegistrationTrust> {
  const started = Date.now()
  const response = await fetch(`${SERVICE_ENDPOINTS.baseUrl}/v2/computer-registration/public-key`, {
    method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
  })
  if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || response.headers.get('content-encoding')) {
    await response.body?.cancel(); throw Error('registration_trust')
  }
  if (!response.body) throw Error('registration_trust')
  const reader = response.body.getReader(), chunks: Buffer[] = []; let length = 0
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; length += r.value.length; if (length > 1024) throw Error('registration_capacity'); chunks.push(Buffer.from(r.value)) }
  } finally { await reader.cancel().catch(() => {}) }
  const v = json(Buffer.concat(chunks), 1024)
  if (!fields(v, ['contract', 'keyId', 'publicKey']) || v.contract !== 'dshos-registration-public-key-v2'
    || typeof v.keyId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(v.keyId) || !id(v.publicKey, 32)) throw Error('registration_trust')
  signal.throwIfAborted()
  return { keyId: v.keyId, publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: v.publicKey } }),
    pairingClockOffsetMs: pairingClockOffset(response.headers.get('date'), response.headers.get('age'), started, Date.now()) }
}
interface Authorizer { authorizePairing(authorization?: string, connectionGeneration?: string): PairingAuthorizationBinding | undefined }
interface Exchange {
  id: string; authorization?: string; generation?: string; claimed: boolean
  deliver?: (value: Uint8Array) => void
  operation?: Promise<JsonRecord>
}
const response = (status: number, value?: unknown): PairingV1HttpResponse => ({ status, contentType: 'application/json', body: value === undefined ? '' : JSON.stringify(value) })
export class DshRegistrationHttp {
  private exchange: Exchange | null = null
  constructor(readonly registration: DshRegistration, private readonly auth: Authorizer) {}
  cancel(): void { this.registration.cancel(); this.exchange = null }
  async handle(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    if (!request.path.startsWith(DSH_REGISTRATION_PREFIX)) return response(404)
    if (request.method !== 'POST') return response(405)
    if (request.path.includes('?') || request.path.includes('#') || request.contentType !== 'application/json') return response(400)
    if (request.body.byteLength > 8192) return response(413)
    const binding = this.auth.authorizePairing(request.authorization, request.connectionGeneration)
    if (!binding) return response(401)
    const check = () => {
      const current = this.auth.authorizePairing(request.authorization, request.connectionGeneration)
      if (!current || current.pairingId !== binding.pairingId || current.mobilePublicKeyRaw !== binding.mobilePublicKeyRaw || request.signal?.aborted)
        throw Error('registration_unauthorized')
    }
    try {
      const value = json(request.body, 8192), route = request.path.slice(DSH_REGISTRATION_PREFIX.length)
      if (route === 'status-proof' && fields(value, ['contract', 'nonce']) && value.contract === 'dshos-dsh-registration-status-proof-v2') {
        const result = await this.registration.statusProof(value.nonce, check); check(); return response(200, result)
      }
      if (route === 'continue-offer' && fields(value, ['contract', 'previousDigest']) && value.contract === 'dshos-dsh-registration-continue-offer-request-v2') {
        const result = await this.registration.continueOffer(value.previousDigest, check); check(); return response(200, result)
      }
      if (route === 'continue-proof' && fields(value, ['contract', 'previousDigest', 'signedChallenge']) && value.contract === 'dshos-dsh-registration-continue-proof-v2') {
        const result = await this.registration.continueProof(value.previousDigest, bytes(value.signedChallenge), check); check(); return response(200, result)
      }
      if (route === 'offer' && fields(value, ['contract']) && value.contract === 'dshos-dsh-registration-offer-request-v2') {
        const result = await this.registration.offer(check); check(); return response(200, result)
      }
      if (route === 'proof' && fields(value, ['contract', 'signedChallenge']) && value.contract === 'dshos-dsh-registration-proof-v2') {
        const result = await this.registration.prove(bytes(value.signedChallenge), check); check(); return response(200, result)
      }
      if (route === 'pairing-proof' && fields(value, ['contract', 'signedChallenge', 'mobileSignature']) && value.contract === 'dshos-dsh-member-pairing-proof-v2') {
        const result = await this.registration.provePairing(bytes(value.signedChallenge), value.mobileSignature, check); check(); return response(200, result)
      }
      if (route === 'pairing-status' && fields(value, ['contract', 'nonce']) && value.contract === 'dshos-dsh-member-pairing-status-request-v2') {
        const result = await this.registration.pairingStatus(value.nonce, check); check(); return response(200, result)
      }
      if (route === 'current' && fields(value, ['contract']) && value.contract === 'dshos-dsh-registration-current-v2') {
        if (this.exchange) return response(429)
        const exchange: Exchange = { id: randomBytes(16).toString('base64url'), authorization: request.authorization,
          generation: request.connectionGeneration, claimed: false }
        this.exchange = exchange
        let ready!: (value: JsonRecord) => void, failed!: (error: unknown) => void
        const query = new Promise<JsonRecord>((resolve, reject) => { ready = resolve; failed = reject })
        exchange.operation = this.registration.synchronize((current, signal) => new Promise((resolve, reject) => {
          exchange.deliver = resolve
          signal.addEventListener('abort', () => reject(Error('registration_timeout')), { once: true })
          ready({ contract: 'dshos-dsh-registration-query-v2', exchangeId: exchange.id, request: current })
        }), check)
        void exchange.operation.catch(failed).finally(() => { if (this.exchange === exchange) this.exchange = null })
        const result = await query; check(); return response(202, result)
      }
      if (route === 'current-response' && fields(value, ['contract', 'exchangeId', 'currentProof'])
        && value.contract === 'dshos-dsh-registration-current-response-v2') {
        const exchange = this.exchange
        if (!exchange || exchange.claimed || exchange.id !== value.exchangeId || exchange.authorization !== request.authorization
          || exchange.generation !== request.connectionGeneration || !exchange.deliver || !exchange.operation) return response(409)
        check(); exchange.claimed = true; exchange.deliver(bytes(value.currentProof))
        const result = await exchange.operation; check(); return response(200, result)
      }
      return response(400)
    } catch (e) {
      const message = e instanceof Error ? e.message : ''
      return response(message === 'registration_unauthorized' ? 401 : message === 'registration_busy' ? 429
        : ['registration_confirmation', 'registration_recovery_required', 'registration_material', 'registration_scope'].includes(message) ? 409 : 400)
    }
  }
}
