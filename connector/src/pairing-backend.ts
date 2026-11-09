import { TextDecoder } from 'node:util'
import { InMemoryPairingAuthentication, type PairingAuthorizationBinding, type PairingAuthenticationResponseResult, type PairingAuthenticationStartResult } from './pairing-auth.js'
import { TransientInvitationStore, type PairingOverlayController, type PairingOverlaySnapshot } from './pairing-overlay.js'
import { InMemoryPairingTrustStore, type PairingTrustRecord, type PairingTrustStore } from './pairing-trust-store.js'

export const MAX_PAIRING_MESSAGE_BYTES = 4_096
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const JSON_CONTENT_TYPE = 'application/json'
const PATHS = new Map([
  ['/pairing/v1/auth/start', ['type', 'pairingVersion', 'pairingId', 'clientNonce']],
  ['/pairing/v1/auth/response', ['type', 'pairingVersion', 'pairingId', 'clientNonce', 'connectionGeneration', 'signature']],
] as const)
const RETIRED_PATHS = new Set(['start','confirm','status','finalize','commit','abort'].map(name=>'/pairing/v1/'+name))
type PairingPath = typeof PATHS extends Map<infer Path, unknown> ? Path : never
export interface PairingV1BackendDependencies {
  readonly now?: () => number
  readonly trustStore?: PairingTrustStore
  readonly authentication?: InMemoryPairingAuthentication
  readonly onPairedDeviceRevoked?: () => void
  readonly assertLegacyRevocationAllowed?: () => void
}
export interface PairingV1HttpRequest {
  readonly method: string; readonly path: string; readonly contentType?: string; readonly body: Uint8Array
  readonly authorization?: string; readonly connectionGeneration?: string; readonly signal?: AbortSignal
}
export interface PairingV1HttpResponse { readonly status: number; readonly contentType?: 'application/json'; readonly body: string }
interface ParsedMessage { readonly type: string; readonly pairingVersion: number; readonly pairingId: string; readonly clientNonce: string; readonly connectionGeneration?: string; readonly signature?: string }
function decodeCanonicalBase64Url(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === length && decoded.toString('base64url') === value ? decoded : undefined
}
function decodeMessage(path: PairingPath, body: Uint8Array):
  {ok:true; value:ParsedMessage} | {ok:false; unsupportedVersion:boolean} {
  try {
    const text = UTF8_DECODER.decode(body), value:unknown = JSON.parse(text), expected=PATHS.get(path)!
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok:false,unsupportedVersion:false}
    const v=value as Record<string,unknown>, keys=Object.keys(v)
    if (keys.length!==expected.length || keys.some((key,i)=>key!==expected[i]) || JSON.stringify(v)!==text
      || v.type!==(path.endsWith('/start')?'auth_start':'auth_response') || !Number.isInteger(v.pairingVersion)) return {ok:false,unsupportedVersion:false}
    if (v.pairingVersion!==1) return {ok:false,unsupportedVersion:true}
    if (!decodeCanonicalBase64Url(v.pairingId,16) || !decodeCanonicalBase64Url(v.clientNonce,16)
      || path.endsWith('/response') && (!decodeCanonicalBase64Url(v.connectionGeneration,16) || !decodeCanonicalBase64Url(v.signature,64))) return {ok:false,unsupportedVersion:false}
    return {ok:true,value:v as unknown as ParsedMessage}
  } catch { return {ok:false,unsupportedVersion:false} }
}
function jsonResponse(body: object): PairingV1HttpResponse { return {status:200,contentType:'application/json',body:JSON.stringify(body)} }
function emptyResponse(status: number): PairingV1HttpResponse { return {status,body:''} }
function errorResponse(code: 'UNSUPPORTED_VERSION' | 'AUTH_FAILED'): PairingV1HttpResponse { return jsonResponse({type:'pairing_error',pairingVersion:1,code}) }

// This endpoint still authenticates existing and cloud-created bindings. New
// bindings are created exclusively by the cloud pairing code protocol.
export class PairingV1Backend implements PairingOverlayController {
  readonly invitationStore = new TransientInvitationStore()
  private managementVisible=false
  private disposed=false
  private readonly now:()=>number
  private readonly trustStore:PairingTrustStore
  private readonly authentication:InMemoryPairingAuthentication|undefined
  private readonly onPairedDeviceRevoked:(()=>void)|undefined
  private readonly assertLegacyRevocationAllowed:(()=>void)|undefined
  constructor(dependencies:PairingV1BackendDependencies={}) {
    this.now=dependencies.now??Date.now
    this.trustStore=dependencies.trustStore??new InMemoryPairingTrustStore()
    this.authentication=dependencies.authentication
    this.onPairedDeviceRevoked=dependencies.onPairedDeviceRevoked
    this.assertLegacyRevocationAllowed=dependencies.assertLegacyRevocationAllowed
    try { this.trustStore.deletePending() } catch { throw Error('Pairing trust storage failed') }
  }
  snapshot():PairingOverlaySnapshot|null {
    if(this.disposed)return null
    let record:PairingTrustRecord|null
    try {record=this.trustStore.read()} catch {throw Error('Pairing trust storage failed')}
    if(record?.status==='active'){this.managementVisible=true;return {status:'PAIRED'}}
    if(record?.status==='revoked'&&this.managementVisible)return {status:'REVOKED'}
    this.managementVisible=false;return null
  }
  open():PairingOverlaySnapshot {
    const snapshot=this.snapshot()
    if(snapshot?.status!=='PAIRED')throw Error('pairing_upgrade_required')
    return snapshot
  }
  regenerate():never {throw Error('pairing_upgrade_required')}
  confirmComputer(_sessionId:string,_verificationCode:string):never {throw Error('pairing_upgrade_required')}
  deny():never {throw Error('pairing_upgrade_required')}
  rejectAndRegenerate():never {throw Error('pairing_upgrade_required')}
  get hasAuthentication(): boolean {
    return this.authentication !== undefined
  }

authorize(authorization: unknown, connectionGeneration: unknown): boolean {
    return this.authentication?.authorize(authorization, connectionGeneration) ?? false
  }

authorizePairing(
    authorization: unknown,
    connectionGeneration: unknown,
  ): PairingAuthorizationBinding | undefined {
    return this.authentication?.authorizePairing(authorization, connectionGeneration)
  }

authenticateStart(pairingId: Buffer, clientNonce: Buffer): PairingAuthenticationStartResult {
    return this.authentication?.start(pairingId, clientNonce) ?? { ok: false }
  }

authenticateResponse(
    pairingId: Buffer,
    clientNonce: Buffer,
    connectionGeneration: Buffer,
    signature: Buffer,
  ): PairingAuthenticationResponseResult {
    return this.authentication?.respond(pairingId, clientNonce, connectionGeneration, signature) ?? {
      ok: false,
    }
  }
  revokePairedDevice(): { readonly status: 'REVOKED' } {
    // Existing local-only bindings may be revoked after new QR admission is closed.
    // Service-owned identities still require their original authorized removal.
    this.assertLegacyRevocationAllowed?.()
    if (this.disposed || !this.managementVisible) {
      throw new Error('Pairing revocation action failed')
    }
    let record: PairingTrustRecord | null
    const now = this.readNow()
    try {
      record = this.trustStore.read()
      if (now === undefined || record?.status !== 'active') throw new Error()
      this.trustStore.replace({
        ...record,
        updatedAt: Math.max(record.updatedAt, now),
        status: 'revoked',
      })
    } catch {
      throw new Error('Pairing revocation action failed')
    }
    this.authentication?.invalidate()
    this.managementVisible = true
    try {
      this.onPairedDeviceRevoked?.()
    } catch {
      throw new Error('Pairing revocation action failed')
    }
    return { status: 'REVOKED' }
  }
  close():void {this.managementVisible=false}
  dispose():void {if(this.disposed)return;this.disposed=true;this.managementVisible=false;this.authentication?.dispose()}
  private readNow(): number | undefined {
    try {
      const value = this.now()
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined
    } catch {
      return undefined
    }
  }
}
export function createPairingV1RequestHandler(backend: PairingV1Backend) {
  return (request: PairingV1HttpRequest): PairingV1HttpResponse => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (RETIRED_PATHS.has(barePath)) return { status: 426, contentType: 'application/json', body: '{"error":"pairing_upgrade_required"}' }
    if (!PATHS.has(barePath as PairingPath)) return emptyResponse(404)
    if ((barePath === '/pairing/v1/auth/start' || barePath === '/pairing/v1/auth/response')
      && !backend.hasAuthentication) {
      return emptyResponse(404)
    }
    if (request.method !== 'POST') return emptyResponse(405)
    if (request.path !== barePath || request.contentType?.toLowerCase() !== JSON_CONTENT_TYPE) {
      return emptyResponse(400)
    }
    if (!(request.body instanceof Uint8Array)) return emptyResponse(400)
    if (request.body.byteLength > MAX_PAIRING_MESSAGE_BYTES) return emptyResponse(413)
    const path = barePath as PairingPath
    const parsed = decodeMessage(path, request.body)
    if (!parsed.ok) {
      return parsed.unsupportedVersion ? errorResponse('UNSUPPORTED_VERSION') : emptyResponse(400)
    }
    if (path === '/pairing/v1/auth/start') {
      const pairingId = decodeCanonicalBase64Url(parsed.value.pairingId, 16)!
      const clientNonce = decodeCanonicalBase64Url(parsed.value.clientNonce, 16)!
      try {
        const result = backend.authenticateStart(pairingId, clientNonce)
        if (!result.ok) return errorResponse('AUTH_FAILED')
        try {
          return jsonResponse({
            type: 'auth_challenge',
            pairingVersion: 1,
            pairingId: result.pairingId.toString('base64url'),
            clientNonce: result.clientNonce.toString('base64url'),
            serverChallenge: result.serverChallenge.toString('base64url'),
            connectionGeneration: result.connectionGeneration.toString('base64url'),
          })
        } finally {
          result.pairingId.fill(0)
          result.clientNonce.fill(0)
          result.serverChallenge.fill(0)
          result.connectionGeneration.fill(0)
        }
      } finally {
        pairingId.fill(0)
        clientNonce.fill(0)
      }
    }
    if (path === '/pairing/v1/auth/response') {
      const pairingId = decodeCanonicalBase64Url(parsed.value.pairingId, 16)!
      const clientNonce = decodeCanonicalBase64Url(parsed.value.clientNonce, 16)!
      const connectionGeneration = decodeCanonicalBase64Url(parsed.value.connectionGeneration, 16)!
      const signature = decodeCanonicalBase64Url(parsed.value.signature, 64)!
      try {
        const result = backend.authenticateResponse(
          pairingId, clientNonce, connectionGeneration, signature,
        )
        if (!result.ok) return errorResponse('AUTH_FAILED')
        try {
          return jsonResponse({
            type: 'auth_ok',
            pairingVersion: 1,
            pairingId: result.pairingId.toString('base64url'),
            connectionGeneration: result.connectionGeneration.toString('base64url'),
            connectionToken: result.connectionToken.toString('base64url'),
          })
        } finally {
          result.pairingId.fill(0)
          result.connectionGeneration.fill(0)
          result.connectionToken.fill(0)
        }
      } finally {
        pairingId.fill(0)
        clientNonce.fill(0)
        connectionGeneration.fill(0)
        signature.fill(0)
      }
    }
    return emptyResponse(404)
  }
}
