import { request } from 'node:https'
import { performance } from 'node:perf_hooks'
import { setTimeout as wait } from 'node:timers/promises'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { createLocalStatusRequest, parseLocalStatus, type LocalRegistrationIdentity } from './local-registration-status.js'
import { registrationJson, verifyRegistrationService, type RegistrationTrust } from './dsh-registration-contract.js'

export function queryLocalStatus(identity: LocalRegistrationIdentity, trusted: RegistrationTrust,
  signal: AbortSignal, now = Date.now, accountBindingId?: string): Promise<ReturnType<typeof parseLocalStatus>> {
  const sent = createLocalStatusRequest(identity, accountBindingId), startedAt = now(), startedMono = performance.now()
  return new Promise((resolve, reject) => {
    const req = request(`${SERVICE_ENDPOINTS.baseUrl}/v2/computer-registry/local-status`, {
      method: 'POST', agent: false, rejectUnauthorized: true, signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, response => {
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
        || response.headers['content-encoding']) { req.destroy(Error('local_status_unavailable')); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('error', reject)
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 4096) req.destroy(Error('local_status_limit')); else chunks.push(chunk)
      })
      response.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks), receipt = registrationJson(body, 4096)
          verifyRegistrationService('REGISTRATION/LOCAL-STATUS-RESULT', receipt, trusted)
          // A slightly faster server clock must not require weakening proof validity.
          // Wait only inside the original request budget, then run all ordinary checks.
          while (true) {
            signal.throwIfAborted()
            const current = now()
            const ahead = typeof receipt.issuedAt === 'number' ? receipt.issuedAt - current : 0
            const remaining = 2000 - Math.max(current - startedAt, performance.now() - startedMono)
            if (!Number.isSafeInteger(ahead) || ahead <= 0 || ahead >= remaining) break
            await wait(ahead, undefined, { signal })
            // A timer may return before the wall clock reaches issuedAt. Recheck
            // within the same deadline instead of accepting or expiring early.
          }
          signal.throwIfAborted()
          return parseLocalStatus(body, sent, trusted,
            { startedAt, now: now(), elapsedMs: performance.now() - startedMono })
        })().then(resolve, reject)
      })
    })
    const timer = setTimeout(() => req.destroy(Error('local_status_timeout')), 2000)
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(JSON.stringify(sent))
  })
}
