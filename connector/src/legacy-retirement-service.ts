import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:https'
import { performance } from 'node:perf_hooks'
import { setTimeout as wait } from 'node:timers/promises'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { registrationBytes as bytes, registrationFields as fields, registrationId as id, registrationJson as json,
  registrationTime, verifyRegistrationService, type JsonRecord, type RegistrationTrust } from './dsh-registration-contract.js'

export const legacyBindingHash = (pairingId: string): string => {
  if (!id(pairingId)) throw Error('legacy_retirement_identity')
  return createHash('sha256').update(Buffer.from(pairingId, 'base64url')).digest('hex')
}
export function createLegacyRetirementQuery(pairingId: string): JsonRecord {
  return { contract: 'dshos-legacy-retirement-query-v1', computerBindingHash: legacyBindingHash(pairingId),
    nonce: randomBytes(32).toString('base64url') }
}
export function parseLegacyRetirement(body: Uint8Array, sent: JsonRecord, trust: RegistrationTrust,
  timing: { startedAt: number; now: number; elapsedMs: number }): { retired: boolean; proof: JsonRecord } {
  if (!fields(sent, ['contract', 'computerBindingHash', 'nonce']) || sent.contract !== 'dshos-legacy-retirement-query-v1'
    || typeof sent.computerBindingHash !== 'string' || !/^[a-f0-9]{64}$/.test(sent.computerBindingHash) || !id(sent.nonce, 32))
    throw Error('legacy_retirement_request')
  const value = json(body, 2048)
  if (!fields(value, ['contract', 'keyId', 'request', 'status', 'issuedAt', 'expiresAt', 'signature'])
    || value.contract !== 'dshos-legacy-retirement-proof-v1' || !bytes(value.request).equals(bytes(sent))
    || !['retired', 'unconfirmed'].includes(value.status as string)) throw Error('legacy_retirement_scope')
  verifyRegistrationService('REGISTRATION/LEGACY-RETIREMENT', value, trust)
  registrationTime(value, timing.now, 30000)
  if (!Number.isSafeInteger(timing.startedAt) || timing.startedAt < 0 || timing.now < timing.startedAt
    || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs < 0 || timing.elapsedMs >= 2000
    || timing.now - timing.startedAt >= 2000) throw Error('legacy_retirement_deadline')
  return { retired: value.status === 'retired', proof: value }
}

// Fixed first-party HTTPS; no account/token, configurable URL, retries or absence inference.
export function queryLegacyRetirement(pairingId: string, trusted: RegistrationTrust, signal: AbortSignal,
  now = Date.now): Promise<ReturnType<typeof parseLegacyRetirement>> {
  const sent = createLegacyRetirementQuery(pairingId), startedAt = now(), startedMono = performance.now()
  return new Promise((resolve, reject) => {
    const req = request(`${SERVICE_ENDPOINTS.baseUrl}/v2/computer-registry/legacy-retirement`, {
      method: 'POST', agent: false, rejectUnauthorized: true, signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
        || response.headers['content-encoding']) { req.destroy(Error('legacy_retirement_unavailable')); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('error', reject)
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2048) req.destroy(Error('legacy_retirement_limit')); else chunks.push(chunk)
      })
      response.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks), proof = json(body, 2048)
          verifyRegistrationService('REGISTRATION/LEGACY-RETIREMENT', proof, trusted)
          const ahead = typeof proof.issuedAt === 'number' ? proof.issuedAt - now() : 0
          const remaining = 2000 - Math.max(now() - startedAt, performance.now() - startedMono)
          if (Number.isSafeInteger(ahead) && ahead > 0 && ahead < remaining) await wait(ahead, undefined, { signal })
          signal.throwIfAborted()
          return parseLegacyRetirement(body, sent, trusted, { startedAt, now: now(), elapsedMs: performance.now() - startedMono })
        })().then(resolve, reject)
      })
    })
    const timer = setTimeout(() => req.destroy(Error('legacy_retirement_timeout')), 2000)
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(JSON.stringify(sent))
  })
}
