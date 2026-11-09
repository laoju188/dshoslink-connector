export interface RelayClockOptions {
  readonly now?: () => number
  readonly monotonic?: () => number
}

/** Use only the Date header of this authenticated, non-redirected response.
 * Second precision plus the full request RTT gives a conservative upper bound
 * on service time. Local prechecks may expire early; the server's signed expiry
 * and signature checks remain authoritative. Never calibrate from ticket data.
 */
export function relayResponseClock(date: string | undefined | null,
  requestStarted: number, options: RelayClockOptions = {}): () => number {
  const wall = options.now ?? Date.now
  if (date === undefined || date === null) return wall // Older peers retain the existing strict precheck.
  const epoch = Date.parse(date)
  const monotonic = options.monotonic ?? (() => performance.now())
  const received = monotonic()
  const roundTrip = received - requestStarted
  if (!Number.isSafeInteger(epoch) || epoch < 0 || new Date(epoch).toUTCString() !== date
    || !Number.isFinite(roundTrip) || roundTrip < 0) throw new Error('Relay response time invalid')
  const upper = epoch + 1_000 + Math.ceil(roundTrip)
  return () => {
    const elapsed = monotonic() - received
    return Number.isFinite(elapsed) && elapsed >= 0 ? Math.ceil(upper + elapsed) : NaN
  }
}

export interface RelayLifetime {
  readonly expiresAtEpochMs: number
  /** In-memory only: bound to this response, never persisted or sent. */
  readonly remainingMs?: () => number
}

export function relayRemainingMs(value: RelayLifetime, now: () => number = Date.now): number {
  return value.remainingMs ? value.remainingMs() : value.expiresAtEpochMs - now()
}
