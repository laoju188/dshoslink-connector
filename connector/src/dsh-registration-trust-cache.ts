import { loadDshRegistrationTrust } from './dsh-registration-http.js'
import type { RegistrationTrust } from './dsh-registration-contract.js'

const TTL_MS = 300_000

/** Only the background retirement monitor uses this cache. Signed status,
 * nonce and expiry are checked on every poll; foreground pairing stays fresh. */
export class DshRegistrationTrustCache {
  private cached?: { value: RegistrationTrust; wall: number; mono: number }
  private pending?: { controller: AbortController; result: Promise<RegistrationTrust> }
  private closed = false
  constructor(private readonly load = loadDshRegistrationTrust, private readonly now = Date.now,
    private readonly monotonic = () => performance.now()) {}

  async get(signal: AbortSignal): Promise<RegistrationTrust> {
    signal.throwIfAborted()
    if (this.closed) throw Error('registration_context_ended')
    const cached = this.cached
    if (cached) {
      const elapsed = this.monotonic() - cached.mono
      if (elapsed >= 0 && elapsed < TTL_MS && Math.abs(this.now() - cached.wall - elapsed) <= 250) return cached.value
      this.cached = undefined
    }
    if (!this.pending) {
      const controller = new AbortController()
      const result = Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return this.load(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))
      })
        .then(value => {
          controller.signal.throwIfAborted()
          if (this.closed || this.pending !== pending) throw Error('registration_context_ended')
          this.cached = { value, wall: this.now(), mono: this.monotonic() }
          return value
        }).finally(() => { if (this.pending === pending) this.pending = undefined })
      const pending = { controller, result }
      this.pending = pending
    }
    const result = this.pending.result
    // A cancelled monitor must not abort another caller sharing the fetch.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      result.then(value => {
        if (signal.aborted) reject(signal.reason)
        else resolve(value)
      }, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  invalidate(): void {
    this.cached = undefined
    this.pending?.controller.abort(Error('registration_context_ended'))
    this.pending = undefined
  }
  close(): void { this.closed = true; this.invalidate() }
}
