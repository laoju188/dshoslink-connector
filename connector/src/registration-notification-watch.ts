import { randomBytes } from 'node:crypto'

/** A liveness hint only. It never authorizes a peer or accepts a revocation. */
export class RegistrationNotificationWatch {
  private timer?: ReturnType<typeof setTimeout>
  private pending?: { nonce: string; sent: number }
  private stopped = true
  constructor(private readonly send: (nonce: string) => void,
    private readonly state: (healthy: boolean) => void,
    private readonly unavailable: () => void,
    private readonly now: () => number = () => performance.now()) {}
  start(): void {
    if (!this.stopped) return
    this.stopped = false; this.probe()
  }
  private probe(): void {
    if (this.stopped) return
    const nonce = randomBytes(16).toString('base64url')
    this.pending = { nonce, sent: this.now() }
    this.timer = setTimeout(() => {
      this.pending = undefined; this.state(false)
      // An optional scheduling hint timing out must not tear down a working
      // relay notification socket. Full signed reads recover independently.
      if (!this.stopped) { this.timer = setTimeout(() => this.probe(), 30_000); this.timer.unref() }
    }, 2000); this.timer.unref()
    try { this.send(nonce) } catch { this.stop(); this.unavailable() }
  }
  accept(nonce: string): boolean {
    const pending = this.pending
    if (this.stopped || !pending || nonce !== pending.nonce) return false
    const elapsed = this.now() - pending.sent
    if (elapsed < 0 || elapsed >= 2000) return false
    clearTimeout(this.timer); this.pending = undefined
    this.state(true)
    if (!this.stopped) { this.timer = setTimeout(() => this.probe(), 5000); this.timer.unref() }
    return true
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.pending = undefined
    this.state(false)
  }
}
