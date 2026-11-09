export interface RegistrationStatusMonitor {
  notificationState(healthy: boolean): void
  stop(): void
}

/** Keep signed reads authoritative. Missing/old control support uses the old
 * polling cadence; a short, fresh challenge response permits a longer interval. */
export function startRegistrationStatusMonitor(check: () => Promise<unknown>, options: {
  now?: () => number
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
} = {}): RegistrationStatusMonitor {
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? setTimeout, cancel = options.cancel ?? clearTimeout
  let stopped = false, running = false, revision = 0
  let healthyUntil = 0, nextCheck = now(), retryNotBefore = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (stopped || running) return
    if (timer !== undefined) cancel(timer)
    const due = Math.min(Math.max(nextCheck, retryNotBefore), healthyUntil || Infinity)
    timer = schedule(() => { void tick() }, Math.max(0, due - now())); timer.unref?.()
  }
  const request = (): void => { revision++; nextCheck = Math.min(nextCheck, now()) }
  const tick = async (): Promise<void> => {
    timer = undefined
    if (stopped || running) return
    if (healthyUntil && now() >= healthyUntil) { healthyUntil = 0; request() }
    if (now() < Math.max(nextCheck, retryNotBefore)) { arm(); return }
    running = true
    const began = revision
    let failed = false
    try { await check() } catch { failed = true }
    running = false
    if (stopped) return
    const at = now()
    retryNotBefore = failed ? at + 30_000 : 0
    nextCheck = at + (failed ? 30_000 : healthyUntil > at ? 60_000 : 10_000)
    if (began !== revision) nextCheck = Math.min(nextCheck, at)
    arm()
  }
  arm()
  return {
    notificationState(healthy) {
      if (stopped) return
      const wasHealthy = healthyUntil > now()
      if (healthy) { healthyUntil = now() + 6000; if (!wasHealthy) request() }
      else { if (healthyUntil) request(); healthyUntil = 0 }
      arm()
    },
    stop() { stopped = true; healthyUntil = 0; if (timer !== undefined) cancel(timer); timer = undefined },
  }
}
