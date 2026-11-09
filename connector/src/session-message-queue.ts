import { createHash } from 'node:crypto'

export type QueueState = 'waiting' | 'dispatching' | 'submitted' | 'completed' | 'rejected' | 'unknown' | 'deleted' | 'dismissed'
export type QueuePause = 'none' | 'user' | 'recovery' | 'uncertain'
export interface QueueItem {
  id: string
  body: string
  bodyDigest: string
  state: QueueState
  createdAt: number
  updatedAt: number
  dispatchId: string | null
  hostRef: string | null
}
export interface QueueOperationIdentity { id: string; ticketDigest: string; assertCurrent?: () => void }
export interface QueueOperationReceipt { id: string; ticketDigest: string; revision: number; appliedAt: number }
export interface QueueRecord {
  contract: 'dshos-session-message-queue-v1'
  scope: string
  ownerEpoch: string
  revision: number
  paused: QueuePause
  highWater: number
  items: QueueItem[]
  operations: QueueOperationReceipt[]
}
// The implementation must atomically compare and replace, protect content at rest,
// reject missing/corrupt state, and share one store across authenticated transports.
export interface QueueStore {
  read(): Promise<unknown | null>
  compareAndSwap(expectedRevision: number | null, record: QueueRecord, assertCurrent?: () => void): Promise<void>
}
export interface QueueReceipt {
  state: 'submitted' | 'rejected' | 'unknown'
  hostRef: string | null
}
// Only a trusted native adapter may report this, before entering any host write.
export class QueueNativeNotEntered extends Error {
  constructor() { super('queue_native_not_entered') }
}
export interface QueueClaim {
  id: string
  body: string
  bodyDigest: string
  dispatchId: string
}
const MAX_PENDING = 16
const MAX_RECORDS = 256
const MAX_OPERATIONS = 1024
const MAX_BODY = 32768
const MAX_BODIES = 256 * 1024
const RETAIN_MS = 24 * 60 * 60 * 1000
const terminal = (s: QueueState): boolean => s === 'completed' || s === 'rejected' || s === 'deleted' || s === 'dismissed'
const states: readonly string[] = ['waiting', 'dispatching', 'submitted', 'completed', 'rejected', 'unknown', 'deleted', 'dismissed']
const pauses: readonly string[] = ['none', 'user', 'recovery', 'uncertain']
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const opaque = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(v)
const scopeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)
const moment = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER - RETAIN_MS
const digest = (s: string): string => createHash('sha256').update(s).digest('base64url')
const bodyValid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && !s.includes('\0')
  && Buffer.byteLength(s) <= MAX_BODY && Buffer.from(s).toString('utf8') === s

export function readQueueRecord(value: unknown): QueueRecord {
  if (!exact(value, ['contract', 'scope', 'ownerEpoch', 'revision', 'paused', 'highWater', 'items', 'operations'])
    || value.contract !== 'dshos-session-message-queue-v1' || !scopeId(value.scope) || !opaque(value.ownerEpoch)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || (value.revision as number) >= Number.MAX_SAFE_INTEGER
    || !pauses.includes(value.paused as string) || !moment(value.highWater)
    || !Array.isArray(value.items) || value.items.length > MAX_RECORDS
    || !Array.isArray(value.operations) || value.operations.length > MAX_OPERATIONS) throw Error('queue_record_invalid')
  const operationIds = new Set<string>()
  for (const op of value.operations) {
    if (!exact(op, ['id', 'ticketDigest', 'revision', 'appliedAt']) || !opaque(op.id) || operationIds.has(op.id)
      || !scopeId(op.ticketDigest) || !Number.isSafeInteger(op.revision) || (op.revision as number) < 2
      || (op.revision as number) > (value.revision as number) || !moment(op.appliedAt) || op.appliedAt > value.highWater) throw Error('queue_record_invalid')
    operationIds.add(op.id)
  }
  const seen = new Set<string>(), dispatches = new Set<string>()
  let bytes = 0, pending = 0, dispatching = 0
  for (const item of value.items) {
    if (!exact(item, ['id', 'body', 'bodyDigest', 'state', 'createdAt', 'updatedAt', 'dispatchId', 'hostRef'])
      || !opaque(item.id) || seen.has(item.id) || !scopeId(item.bodyDigest) || !states.includes(item.state as string)
      || !moment(item.createdAt) || !moment(item.updatedAt) || item.updatedAt < item.createdAt || item.updatedAt > value.highWater
      || (item.dispatchId !== null && !opaque(item.dispatchId))
      || (item.hostRef !== null && (typeof item.hostRef !== 'string' || !item.hostRef.length || item.hostRef.length > 256
        || /[\u0000-\u001f\u007f]/u.test(item.hostRef) || Buffer.from(item.hostRef).toString('utf8') !== item.hostRef))) throw Error('queue_record_invalid')
    const state = item.state as QueueState
    if (terminal(state) ? item.body !== '' : !bodyValid(item.body) || digest(item.body as string) !== item.bodyDigest) throw Error('queue_record_invalid')
    if ((state === 'waiting' || state === 'deleted') && (item.dispatchId !== null || item.hostRef !== null)
      || ['dispatching', 'submitted', 'completed', 'rejected', 'unknown', 'dismissed'].includes(state) && item.dispatchId === null
      || (state === 'submitted' || state === 'completed') && item.hostRef === null) throw Error('queue_record_invalid')
    if (item.dispatchId !== null) {
      if (dispatches.has(item.dispatchId)) throw Error('queue_record_invalid')
      dispatches.add(item.dispatchId)
    }
    seen.add(item.id)
    if (!terminal(state)) { pending++; bytes += Buffer.byteLength(item.body as string) }
    if (state === 'dispatching' || state === 'submitted') dispatching++
  }
  if (pending > MAX_PENDING || bytes > MAX_BODIES || dispatching > 1) throw Error('queue_record_invalid')
  return clone(value) as unknown as QueueRecord
}

export interface QueueOperationResolution { state: 'applied' | 'not-recorded' | 'unconfirmed'; operationReceipt: QueueOperationReceipt | null }
// A negative result is restricted to the same live instance and retained receipt
// window. Call only AFTER expiring the ticket on the runtime-wide monotonic clock
// and awaiting the queue's serial writes. An absent receipt after restart is unknown.
export function resolveQueueOperation(record: Pick<QueueRecord, 'operations'>, operation: QueueOperationIdentity,
  issuedAt: number, expiresAt: number, observedAt: number, sameInstance: boolean): QueueOperationResolution {
  if (!opaque(operation.id) || !scopeId(operation.ticketDigest) || !moment(issuedAt) || !moment(expiresAt)
    || !moment(observedAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 30000 || observedAt < issuedAt) throw Error('queue_resolution')
  const receipt = record.operations.find(v => v.id === operation.id)
  if (receipt) {
    if (receipt.ticketDigest !== operation.ticketDigest || receipt.appliedAt < issuedAt || receipt.appliedAt >= expiresAt
      || receipt.appliedAt > observedAt) throw Error('queue_resolution_conflict')
    return { state: 'applied', operationReceipt: clone(receipt) }
  }
  return { state: sameInstance && observedAt >= expiresAt && observedAt - issuedAt < RETAIN_MS ? 'not-recorded' : 'unconfirmed', operationReceipt: null }
}

// A stopped/recovering queue is still user state, even without pending input.
// Receipt retention and all terminal timestamps are covered by highWater.
export function queueRecordCanRetire(record: QueueRecord, now: number): boolean {
  if (!moment(now) || now < record.highWater) throw Error('queue_clock')
  return record.paused === 'none' && now - record.highWater >= RETAIN_MS
    && record.items.every(item => terminal(item.state))
}

// Internal shared coordinator, not a network authority. The caller authenticates
// every command and binds scope to account/computer/member/pairing/key/session.
// Only the coordinator owns its queue; pending work is NOT also enqueued in the
// native host. Old native-r1 operations remain separate and unchanged.
export class SessionMessageQueue {
  private record: QueueRecord
  private serial: Promise<unknown> = Promise.resolve()
  private closed = false
  private fault = false
  private pauseGate = false
  private userPauseGate = false
  private barrier = 0

  private constructor(private readonly store: QueueStore, record: QueueRecord,
    private readonly assertOwner: () => void, private readonly now: () => number) {
    this.record = record
    this.pauseGate = record.paused !== 'none'
    this.userPauseGate = record.paused === 'user'
  }

  static async open(store: QueueStore, scope: string, ownerEpoch: string,
    assertOwner: () => void, now: () => number = Date.now): Promise<SessionMessageQueue> {
    if (!scopeId(scope) || !opaque(ownerEpoch)) throw Error('queue_identity')
    assertOwner()
    const raw = await store.read()
    assertOwner()
    const time = now()
    if (!moment(time)) throw Error('queue_clock')
    let record: QueueRecord
    if (raw === null) {
      record = { contract: 'dshos-session-message-queue-v1', scope, ownerEpoch, revision: 1,
        paused: 'none', highWater: time, items: [], operations: [] }
      await store.compareAndSwap(null, clone(record))
      assertOwner()
    } else {
      record = readQueueRecord(raw)
      if (record.scope !== scope) throw Error('queue_identity')
      if (time < record.highWater) throw Error('queue_clock')
      if (record.ownerEpoch !== ownerEpoch) {
        const previous = record.revision
        record.ownerEpoch = ownerEpoch
        record.revision++
        // A normal idle queue has no unfinished work to recover. Preserve explicit
        // pauses and every nonterminal item; only fresh future input may run.
        const idle = record.paused === 'none' && record.items.every(item => terminal(item.state))
        record.paused = idle ? 'none' : record.paused === 'user' ? 'user' : 'recovery'
        record.highWater = time
        for (const item of record.items) if (item.state === 'dispatching' || item.state === 'submitted') {
          item.state = 'unknown'
          item.updatedAt = time
        }
        readQueueRecord(record)
        await store.compareAndSwap(previous, clone(record))
        assertOwner()
      }
    }
    return new SessionMessageQueue(store, record, assertOwner, now)
  }

  private guard(): void {
    if (this.closed || this.fault) throw Error('queue_unavailable')
    this.assertOwner()
  }
  private time(): number {
    const now = this.now()
    if (!moment(now) || now < this.record.highWater) { this.pauseGate = true; this.fault = true; throw Error('queue_clock') }
    return now
  }
  // Synchronous stop intent remains visible even while its disk write is pending.
  userInterrupted(): boolean { return this.userPauseGate }
  snapshot(): QueueRecord { this.guard(); this.time(); return clone(this.record) }
  async settledSnapshot(): Promise<QueueRecord> { await this.serial; return this.snapshot() }
  close(): void { this.closed = true; this.pauseGate = true; this.barrier++ }

  private priorOperation(operation?: QueueOperationIdentity): QueueOperationReceipt | undefined {
    if (!operation) return undefined
    if (!opaque(operation.id) || !scopeId(operation.ticketDigest)) throw Error('queue_operation_invalid')
    operation.assertCurrent?.()
    const prior = this.record.operations.find(v => v.id === operation.id)
    if (prior && prior.ticketDigest !== operation.ticketDigest) throw Error('queue_operation_conflict')
    return prior
  }
  private mutate(change: (next: QueueRecord, now: number) => boolean, expectedRevision?: number,
    operation?: QueueOperationIdentity): Promise<QueueRecord> {
    const task = this.serial.then(async () => {
      this.guard()
      this.time()
      if (this.priorOperation(operation)) return clone(this.record)
      if (expectedRevision !== undefined && expectedRevision !== this.record.revision) throw Error('queue_revision_changed')
      const now = this.time(), next = clone(this.record), previous = next.revision
      if (operation) {
        next.operations = next.operations.filter(v => now - v.appliedAt < RETAIN_MS)
        if (next.operations.length >= MAX_OPERATIONS) throw Error('queue_capacity')
      }
      if (!change(next, now) && !operation) return clone(this.record)
      next.revision++
      if (operation) next.operations.push({ id: operation.id, ticketDigest: operation.ticketDigest, revision: next.revision, appliedAt: now })
      next.highWater = now
      readQueueRecord(next)
      this.guard()
      try {
        await this.store.compareAndSwap(previous, clone(next), operation?.assertCurrent)
        this.guard()
      } catch (error) {
        // A lost storage acknowledgement is not permission to retry the write or
        // native dispatch. A newly opened coordinator must read durable truth.
        this.fault = true; this.pauseGate = true; this.barrier++
        throw error
      }
      this.record = next
      return clone(next)
    })
    this.serial = task.catch(() => {})
    return task
  }

  enqueue(id: string, body: string, operation?: QueueOperationIdentity): Promise<QueueRecord> {
    if (!opaque(id) || !bodyValid(body)) return Promise.reject(Error('queue_input'))
    const hash = digest(body)
    return this.mutate((next, now) => {
      const prior = next.items.find(v => v.id === id)
      if (prior) { if (prior.bodyDigest !== hash) throw Error('queue_id_conflict'); return false }
      next.items = next.items.filter(v => !terminal(v.state) || now - v.updatedAt < RETAIN_MS)
      if (next.items.length >= MAX_RECORDS || next.items.filter(v => !terminal(v.state)).length >= MAX_PENDING
        || next.items.reduce((sum, v) => sum + Buffer.byteLength(v.body), 0) + Buffer.byteLength(body) > MAX_BODIES) throw Error('queue_capacity')
      next.items.push({ id, body, bodyDigest: hash, state: 'waiting', createdAt: now, updatedAt: now, dispatchId: null, hostRef: null })
      return true
    }, undefined, operation)
  }

  pause(operation?: QueueOperationIdentity): Promise<QueueRecord> {
    this.guard(); this.time()
    // An already applied old stop must never pause a later resumed queue.
    if (this.priorOperation(operation)) return Promise.resolve(clone(this.record))
    // This synchronous latch fences a claim whose durable write is still pending.
    // The caller sends the separately authorized stop to the ORIGINAL native run;
    // it must not wait for queue storage or report this pause as native stop success.
    this.pauseGate = true; this.userPauseGate = true; this.barrier++
    return this.mutate(next => { if (next.paused === 'user') return false; next.paused = 'user'; return true }, undefined, operation)
  }
  resume(expectedRevision: number, operation?: QueueOperationIdentity): Promise<QueueRecord> {
    const barrier = this.barrier
    return this.mutate(next => {
      if (next.items.some(v => v.state === 'dispatching' || v.state === 'unknown')) throw Error('queue_result_unconfirmed')
      if (next.paused === 'none') return false
      next.paused = 'none'; return true
    }, expectedRevision, operation).then(record => {
      this.guard()
      if (this.barrier === barrier) { this.pauseGate = record.paused !== 'none'; this.userPauseGate = record.paused === 'user' }
      return record
    })
  }
  edit(id: string, body: string, expectedRevision: number, operation?: QueueOperationIdentity): Promise<QueueRecord> {
    if (!bodyValid(body)) return Promise.reject(Error('queue_input'))
    return this.mutate((next, now) => {
      const item = next.items.find(v => v.id === id)
      if (!item || item.state !== 'waiting') throw Error('queue_item_not_waiting')
      if (next.items.reduce((sum, v) => sum + Buffer.byteLength(v.body), 0) - Buffer.byteLength(item.body) + Buffer.byteLength(body) > MAX_BODIES) throw Error('queue_capacity')
      item.body = body; item.bodyDigest = digest(body); item.updatedAt = now; return true
    }, expectedRevision, operation)
  }
  remove(id: string, expectedRevision: number, operation?: QueueOperationIdentity): Promise<QueueRecord> {
    return this.mutate((next, now) => {
      const item = next.items.find(v => v.id === id)
      if (!item || item.state !== 'waiting') throw Error('queue_item_not_waiting')
      item.state = 'deleted'; item.body = ''; item.updatedAt = now; return true
    }, expectedRevision, operation)
  }
  // Explicit user disposition, never evidence that the original input did not run.
  dismiss(id: string, expectedRevision: number, operation?: QueueOperationIdentity,
    retire: () => void = () => {}): Promise<QueueRecord> {
    return this.mutate((next, now) => {
      const item = next.items.find(v => v.id === id)
      if (!item || item.state !== 'unknown') throw Error('queue_item_not_unknown')
      // Fence a still-pending causal input before yielding to durable storage.
      retire()
      this.pauseGate = true; this.barrier++
      if (next.paused === 'none') next.paused = 'uncertain'
      item.state = 'dismissed'; item.body = ''; item.updatedAt = now
      return true
    }, expectedRevision, operation)
  }
  reorder(ids: readonly string[], expectedRevision: number, operation?: QueueOperationIdentity): Promise<QueueRecord> {
    const order = [...ids]
    return this.mutate(next => {
      const waiting = next.items.filter(v => v.state === 'waiting'), map = new Map(waiting.map(v => [v.id, v]))
      if (order.length !== waiting.length || new Set(order).size !== order.length || order.some(id => !map.has(id))) throw Error('queue_order')
      let index = 0
      next.items = next.items.map(v => v.state === 'waiting' ? map.get(order[index++])! : v)
      return true
    }, expectedRevision, operation)
  }

  // Only actual, correlated host evidence calls reconcile; clients may not assert
  // "not executed". An unknown dispatch NEVER becomes waiting again.
  reconcile(id: string, dispatchId: string, receipt: QueueReceipt | { state: 'completed'; hostRef: string }): Promise<QueueRecord> {
    return this.mutate((next, now) => {
      const item = next.items.find(v => v.id === id)
      if (!item || item.dispatchId !== dispatchId || item.state === 'waiting' || item.state === 'deleted') throw Error('queue_receipt_scope')
      if (!['submitted', 'completed', 'rejected', 'unknown'].includes(receipt.state)) throw Error('queue_receipt')
      if (item.state === 'dismissed') return false
      if (terminal(item.state)) {
        if (item.state !== receipt.state || item.hostRef !== receipt.hostRef) throw Error('queue_receipt_conflict')
        return false
      }
      if (item.hostRef !== null && receipt.hostRef !== null && item.hostRef !== receipt.hostRef) throw Error('queue_receipt_conflict')
      if (item.state === 'submitted' && receipt.state === 'unknown') return false
      item.state = receipt.state
      item.hostRef = receipt.hostRef ?? item.hostRef
      item.updatedAt = now
      if (terminal(item.state)) item.body = ''
      if (receipt.state === 'unknown') { this.pauseGate = true; this.barrier++; if (next.paused !== 'user') next.paused = 'uncertain' }
      return true
    })
  }

  // Native-only positive proof: an exact owned inbox entry was removed BEFORE
  // claim/admission. No network request may supply this proof or reset unknown work.
  withdrawBeforeAdmission(id: string, dispatchId: string, verifyRemoved: () => boolean): Promise<QueueRecord> {
    this.guard(); this.pauseGate = true; this.barrier++
    return this.mutate((next, now) => {
      const item = next.items.find(v => v.id === id)
      if (!item || item.dispatchId !== dispatchId || !['dispatching', 'submitted'].includes(item.state)
        || !verifyRemoved()) throw Error('queue_withdrawal_unproven')
      item.state = 'waiting'; item.dispatchId = null; item.hostRef = null; item.updatedAt = now
      if (next.paused === 'none') next.paused = 'recovery'
      return true
    })
  }

  async dispatchNext(dispatchId: string, canDispatch: () => boolean,
    invoke: (claim: QueueClaim, assertCurrent: () => void) => QueueReceipt | Promise<QueueReceipt>,
    prepare: (claim: QueueClaim) => Promise<void> = async () => {}): Promise<QueueRecord> {
    if (!opaque(dispatchId)) throw Error('queue_dispatch_id')
    const barrier = this.barrier
    let claimed: QueueClaim | null = null
    await this.mutate((next, now) => {
      if (this.pauseGate || next.paused !== 'none' || !canDispatch()
        || next.items.some(v => ['dispatching', 'submitted', 'unknown'].includes(v.state))) return false
      if (next.items.some(v => v.dispatchId === dispatchId)) throw Error('queue_dispatch_id')
      const item = next.items.find(v => v.state === 'waiting')
      if (!item) return false
      item.state = 'dispatching'; item.dispatchId = dispatchId; item.updatedAt = now
      claimed = { id: item.id, body: item.body, bodyDigest: item.bodyDigest, dispatchId }
      return true
    })
    if (claimed === null) return this.snapshot()
    const claim = claimed as QueueClaim
    const assertCurrent = (): void => {
      this.guard(); this.time()
      if (this.pauseGate || this.barrier !== barrier || !canDispatch()) throw Error('queue_dispatch_cancelled')
      const item = this.record.items.find(v => v.id === claim.id)
      if (item?.state !== 'dispatching' || item.dispatchId !== dispatchId || item.bodyDigest !== claim.bodyDigest) throw Error('queue_dispatch_changed')
    }
    // Read-only AUTH refresh/preparation completes before the last synchronous guard.
    // Failure here proves native entry was never invoked; retain the input.
    try { await prepare(Object.freeze({ ...claim })); assertCurrent() } catch {
      // No native entry was invoked: this precise claim may safely return to waiting.
      return this.mutate((next, now) => {
        const item = next.items.find(v => v.id === claim.id)
        if (!item || item.state !== 'dispatching' || item.dispatchId !== dispatchId) throw Error('queue_dispatch_changed')
        item.state = 'waiting'; item.dispatchId = null; item.updatedAt = now; return true
      })
    }
    let receipt: QueueReceipt
    try { receipt = await invoke(Object.freeze({ ...claim }), assertCurrent) }
    catch (error) {
      if (error instanceof QueueNativeNotEntered) return this.mutate((next, now) => {
        const item = next.items.find(v => v.id === claim.id)
        if (!item || item.state !== 'dispatching' || item.dispatchId !== dispatchId) throw Error('queue_dispatch_changed')
        item.state = 'waiting'; item.dispatchId = null; item.updatedAt = now; return true
      })
      receipt = { state: 'unknown', hostRef: null }
    }
    this.guard()
    const current = this.record.items.find(v => v.id === claim.id)
    // A real host event may already have settled this exact dispatch while the
    // invocation acknowledgement was in flight. Do not overwrite stronger evidence.
    if (current?.dispatchId === dispatchId && terminal(current.state)) return this.snapshot()
    // A positively proven native withdrawal may have already retained this input.
    if (current?.state === 'waiting' && current.dispatchId === null && this.record.paused !== 'none') return this.snapshot()
    return this.reconcile(claim.id, dispatchId, receipt)
  }
}
