import { validNotificationDetail, type ConnectionEvent, type ConnectionSnapshot } from './pairing-support-contract.js'
export type ConnectionObserver = (stage: ConnectionEvent['stage'], result: ConnectionEvent['result'], routeId?: string, detail?: ConnectionEvent['detail']) => void
export function observeConnection(observer: ConnectionObserver | undefined,
  stage: ConnectionEvent['stage'], result: ConnectionEvent['result'], routeId?: string, detail?: ConnectionEvent['detail']): void {
  try { observer?.(stage, result, routeId, detail) } catch { /* Observation cannot change access or delivery. */ }
}
export class ConnectionObservations {
  private events: ConnectionEvent[] = []
  private firstFailure: ConnectionEvent | null = null
  private lastFailure: ConnectionEvent | null = null
  constructor(private readonly now = Date.now) {}
  readonly observe: ConnectionObserver = (stage, result, routeId, detail) => {
    const atMs = this.now()
    if (!Number.isSafeInteger(atMs) || atMs < 0) return
    if(detail!==undefined&&(stage!=='relay_notify'||!validNotificationDetail(detail)))return
    const previous = this.events.at(-1)
    if (routeId !== undefined && (!/^[A-Za-z0-9_-]{22}$/.test(routeId)
      || Buffer.from(routeId,'base64url').toString('base64url')!==routeId || !stage.startsWith('relay_'))) return
    if (previous?.stage === stage && previous.result === result && previous.routeId === routeId&&JSON.stringify(previous.detail)===JSON.stringify(detail)) return
    const event = Object.freeze({ stage, result, atMs, ...(routeId === undefined ? {} : {routeId}),...(detail?{detail:Object.freeze({...detail})}:{}) })
    this.events.push(event)
    if (this.events.length > 8) this.events.shift()
    if (!['ok', 'waiting', 'closed', 'paused','not_required','replaced','legacy'].includes(result)) {
      this.firstFailure ??= event; this.lastFailure = event
    }
  }
  snapshot(): ConnectionSnapshot {
    return { events: this.events.map(e => ({ ...e,...e.detail?{detail:{...e.detail}}:{} })), firstFailure: this.firstFailure && { ...this.firstFailure,...this.firstFailure.detail?{detail:{...this.firstFailure.detail}}:{} },
      lastFailure: this.lastFailure && { ...this.lastFailure,...this.lastFailure.detail?{detail:{...this.lastFailure.detail}}:{} } }
  }
  reset(): void { this.events = []; this.firstFailure = null; this.lastFailure = null }
}
