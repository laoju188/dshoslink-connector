import { observeConnection, type ConnectionObserver } from './connection-observations.js'
import type {
  CriticalNotificationEvent,
  CriticalNotificationEventSource,
} from './critical-notification.js'
import type { NotificationConnectorCredentialStore, NotificationDeliveryContext, NotificationSubmissionResult } from './notification-connector-credential.js'

const MAX_QUEUE = 100
const MAX_ATTEMPTS = 6
const INITIAL_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1_000

interface QueuedEvent {
  readonly event: CriticalNotificationEvent
  readonly createdAtEpochMs: number
  readonly context?: NotificationDeliveryContext
  attempts: number
}

export interface CriticalNotificationDeliveryWorkerOptions {
  readonly observeConnection?: ConnectionObserver
  readonly source: CriticalNotificationEventSource
  readonly credentialStore: Pick<NotificationConnectorCredentialStore, 'submitCriticalNotification'>
    & Partial<Pick<NotificationConnectorCredentialStore, 'captureDeliveryContext'>>
  readonly now?: () => number
  readonly retryDelay?: (attempt: number) => number
}

export interface CriticalNotificationDeliveryWorkerController {
  start(): void
  stop(): Promise<void>
}

export class CriticalNotificationDeliveryWorker
implements CriticalNotificationDeliveryWorkerController {
  private readonly queue: QueuedEvent[] = []
  private stopped = true
  private unsubscribe: (() => void) | undefined
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<void> | undefined
  private retryAfterMs: number | undefined
  private loadingPending = false
  private readonly attemptedCompletions = new Set<string>()
  private generation = 0

  constructor(private readonly options: CriticalNotificationDeliveryWorkerOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.generation += 1
    this.attemptedCompletions.clear()
    this.unsubscribe = this.options.source.subscribe(event => this.enqueue(event))
    this.loadPending()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.inFlight?.catch(() => undefined)
    this.queue.length = 0
  }

  private enqueue(event: CriticalNotificationEvent): void {
    if (this.stopped) return
    const createdAtEpochMs = event.completionAtMs ?? (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0) return
    if (this.queue.some(item => item.event.eventId === event.eventId)) return
    if (event.completionAtMs !== undefined) {
      if (this.attemptedCompletions.has(event.eventId) || this.queue.length >= MAX_QUEUE
        || this.attemptedCompletions.size >= 4096) return
    }
    const context = this.options.credentialStore.captureDeliveryContext?.()
    if (this.options.credentialStore.captureDeliveryContext && !context) return
    if (event.completionAtMs !== undefined) this.attemptedCompletions.add(event.eventId)
    this.queue.push({ event, createdAtEpochMs, attempts: 0, context })
    while (this.queue.length > MAX_QUEUE) this.queue.shift()
    this.schedule(0)
  }

  private loadPending(): void {
    if (this.stopped || this.loadingPending || !this.options.source.pending) return
    this.loadingPending = true
    const generation = this.generation
    void this.options.source.pending().then(events => {
      if (generation !== this.generation || this.stopped) return
      for (const event of events) this.enqueue(event)
    }).catch(() => undefined).finally(() => {
      this.loadingPending = false
      // A stopped worker's late read must not swallow the new worker's startup replay.
      if (generation !== this.generation && !this.stopped) this.loadPending()
    })
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer !== undefined || this.inFlight !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const current = this.drain()
      this.inFlight = current
      void current.finally(() => {
        if (this.inFlight === current) this.inFlight = undefined
        const delay = this.retryAfterMs ?? 0
        this.retryAfterMs = undefined
        if (!this.stopped && this.queue.length > 0 && this.timer === undefined) {
          this.schedule(delay)
        } else if (!this.stopped && this.queue.length === 0) {
          this.loadPending()
        }
      })
    }, delayMs)
    this.timer.unref()
  }

  private async drain(): Promise<void> {
    const queued = this.queue[0]
    if (queued === undefined || this.stopped) return
    const nowEpochMs = (this.options.now ?? Date.now)()
    if (!Number.isSafeInteger(nowEpochMs)
      || nowEpochMs < 0
      || nowEpochMs - queued.createdAtEpochMs >= MAX_EVENT_AGE_MS) {
      observeConnection(this.options.observeConnection, 'notification', 'expired')
      this.remove(queued)
      return
    }
    let status: NotificationSubmissionResult = 0
    try {
      status = await this.options.credentialStore.submitCriticalNotification({
        eventId: queued.event.eventId,
        eventType: queued.event.eventType,
        ...(queued.event.completionAtMs === undefined ? {} : { completionAtMs: queued.event.completionAtMs }),
      }, queued.context)
    } catch {
      // A rejected submission follows the same bounded retry policy as a temporary failure.
    }
    // Enqueue may have evicted this item while its request was pending. Its
    // completion must not remove or delay the next, never-submitted event.
    if (!this.queue.includes(queued)) return
    if (status === 'stopped') {
      // A local pause/close or an obsolete binding ends this event, not server access.
      observeConnection(this.options.observeConnection, 'notification', 'closed')
      this.remove(queued)
      return
    }
    observeConnection(this.options.observeConnection, 'notification', status === 202 || status === 204 ? 'ok'
      : status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'unavailable')
    if (status === 202 || status === 204) {
      try { await this.options.source.accepted?.(queued.event.eventId) } catch {}
    }
    if (status === 202 || status === 204
      || (status >= 400 && status < 500 && status !== 409 && status !== 429)) {
      this.remove(queued)
      return
    }
    queued.attempts += 1
    if (queued.attempts >= MAX_ATTEMPTS) {
      observeConnection(this.options.observeConnection, 'notification', 'retry_exhausted')
      this.remove(queued)
      return
    }
    const delayMs = this.options.retryDelay?.(queued.attempts)
      ?? Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** (queued.attempts - 1))
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > MAX_RETRY_MS) {
      this.remove(queued)
      return
    }
    this.retryAfterMs = delayMs
  }

  private remove(queued: QueuedEvent): void {
    const index = this.queue.indexOf(queued)
    if (index >= 0) this.queue.splice(index, 1)
  }
}
