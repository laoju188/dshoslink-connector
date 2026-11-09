import { createHash, randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { registrationBytes as encode, registrationDigest as digest } from './dsh-registration-contract.js'
import { RegistrationFile, registrationLock, type RegistrationLease } from './dsh-registration-storage.js'
import { createWindowsMessageQueueDataProtector, createWindowsMessageQueueInitProtector, createWindowsQueueContentInitProtector, createWindowsQueueContentDataProtector } from './windows-dpapi.js'
import { MessageQueueDatabase } from './session-message-queue-store.js'
import { SessionMessageQueue, type QueueOperationIdentity, type QueueRecord } from './session-message-queue.js'
import { DshMessageQueueDriver, type DshQueuePort } from './dsh-message-queue-driver.js'
import { dshQueueSessionId, type DshQueueTarget, type DshQueueTicket } from './dsh-message-queue-contract.js'
import type { DshQueueIdentityLease } from './dsh-message-queue-identity.js'
import { QueueContentTransfer, type QueueContentTransferState } from './session-message-content-transfer.js'
import { QueueContentDatabase } from './session-message-content-store.js'
import { QueueContentBinding } from './session-message-content-binding.js'
import { readQueueBoundContent, readQueueContentReference, type QueueContentReference, type QueueMessageContent } from './session-message-content.js'
const fresh = (): string => randomBytes(16).toString('base64url')
interface Marker { contract: 'dshos-message-queue-init-v1'; state: 'initializing' | 'ready' }
const markerValid = (v: unknown): v is Marker => !!v && typeof v === 'object'
  && Object.keys(v).join(',') === 'contract,state' && (v as Marker).contract === 'dshos-message-queue-init-v1'
  && ['initializing','ready'].includes((v as Marker).state)
interface ContentMarker { contract: 'dshos-queue-content-init-v1'; state: 'initializing' | 'ready' }
const contentMarkerValid = (v: unknown): v is ContentMarker => !!v && typeof v === 'object'
  && Object.keys(v).join(',') === 'contract,state' && (v as ContentMarker).contract === 'dshos-queue-content-init-v1'
  && ['initializing','ready'].includes((v as ContentMarker).state)
export interface DshQueueEntry {
  scope: string; target: DshQueueTarget; lease: DshQueueIdentityLease; port: DshQueuePort
  retainedUntil: number
  content: QueueContentBinding | null; queue: SessionMessageQueue | null; driver: DshMessageQueueDriver | null; opening: Promise<void> | null
  authorities: Map<object, () => Promise<() => void>>; operations: Map<string, { digest: string; promise: Promise<string | null> }>
}
export interface DshQueueRuntimeOptions {
  directory: string; loadIdentity(): Promise<DshQueueIdentityLease>; port(sessionId: string): DshQueuePort; assertRuntime(): void
}
// One private Windows owner/database for all authenticated LAN/relay connections.
export class DshMessageQueueRuntime {
  readonly instanceId = fresh()
  readonly enableEpoch = fresh()
  private closed = false
  private fault = false
  private clock = -1
  private owner: RegistrationLease | null = null
  private db: MessageQueueDatabase | null = null
  private contentDb: QueueContentDatabase | null = null
  private contentOpening: Promise<void> | null = null
  private contentStaging = false
  private readonly transfers: QueueContentTransfer
  private opening: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private readonly entries = new Map<string, DshQueueEntry>()
  constructor(private readonly options: DshQueueRuntimeOptions, private readonly now = Date.now) { this.transfers=new QueueContentTransfer(now) }
  observeTime(n: number): number {
    this.check()
    if (!Number.isSafeInteger(n) || n < 0 || n < this.clock || n >= Number.MAX_SAFE_INTEGER - 86400000) throw Error('queue_clock')
    this.clock = n; return n
  }
  nowValue(): number { return this.observeTime(this.now()) }
  check(): void {
    if (this.closed || this.fault) throw Error('queue_runtime_closed')
    this.options.assertRuntime(); this.owner?.assertHeld()
  }
  checkEntry(entry: DshQueueEntry): void {
    this.check(); entry.lease.assertCurrent()
    if (this.entries.get(entry.scope) !== entry) throw Error('queue_identity_changed')
  }
  retainCapability(entry: DshQueueEntry, expiresAt: number): void {
    this.checkEntry(entry)
    const now = this.nowValue()
    if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + 60000) throw Error('queue_clock')
    entry.retainedUntil = Math.max(entry.retainedUntil, expiresAt)
  }
  private async database(): Promise<void> {
    if (this.opening) { await this.opening; this.check(); return }
    this.opening = (async () => {
      this.check(); this.owner = await registrationLock(this.options.directory); this.check()
      const marker = new RegistrationFile<Marker>(join(this.options.directory, 'message-queue-init-v1.json'),
        createWindowsMessageQueueInitProtector(), markerValid)
      let state = await marker.read(); this.check()
      let exists = true
      try { await lstat(join(this.options.directory, 'message-queue-v1.sqlite')) }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw e }
      this.check()
      if (!state) {
        if (exists) throw Error('queue_initialization_unconfirmed')
        state = { contract: 'dshos-message-queue-init-v1', state: 'initializing' }
        await marker.write(state, { assertHeld: () => this.check() }); this.check()
      }
      this.db = await MessageQueueDatabase.open(this.options.directory, createWindowsMessageQueueDataProtector(), () => this.check(), state.state === 'initializing')
      this.check()
      if (state.state !== 'ready') await marker.write({ contract: state.contract, state: 'ready' }, { assertHeld: () => this.check() })
      this.check()
    })().catch(e => { this.fault = true; throw e })
    await this.opening
  }
  async retireExpired(assertTransport: () => void): Promise<void> {
    await this.database(); this.check(); assertTransport()
    const now = this.nowValue()
    await this.db!.retireExpired(now, record => {
      this.check(); assertTransport()
      const resident = this.entries.get(record.scope)
      if (resident) {
        if (resident.opening !== null || resident.operations.size > 0 || this.contentStaging
          || resident.retainedUntil > now) return false
        // Fence old actors, scheduled pumps and content guards synchronously.
        // Their old tickets can only be queried; retirement never dispatches.
        resident.authorities.clear(); resident.driver?.close(); resident.content?.close(); resident.queue?.close()
        this.entries.delete(record.scope)
      }
      return true
    })
    this.check(); assertTransport()
  }
  async access(sessionId: string, assertTransport: () => void): Promise<DshQueueEntry> {
    this.check(); assertTransport()
    if (!dshQueueSessionId(sessionId)) throw Error('queue_session')
    const lease = await this.options.loadIdentity(); this.check(); assertTransport(); lease.assertCurrent()
    const i = lease.identity, scope = digest({ contract: 'dshos-message-queue-scope-v1', accountBindingId: i.accountBindingId,
      computerId: i.computerId, platform: 'dsh', memberId: i.memberId, pairingId: i.pairingId, keyGeneration: i.keyGeneration, sessionId })
    await this.database(); this.check(); assertTransport(); lease.assertCurrent()
    if (!this.entries.has(scope)) {
      await this.retireExpired(() => { assertTransport(); lease.assertCurrent() })
      this.check(); assertTransport(); lease.assertCurrent()
    }
    let entry = this.entries.get(scope)
    if (!entry) {
      if (this.entries.size >= 32) {
        const empty = [...this.entries.values()].find(e => e.queue === null && e.opening === null && e.authorities.size === 0)
        if (empty) this.entries.delete(empty.scope)
      }
      if (this.entries.size >= 32) throw Error('queue_capacity')
      const target: DshQueueTarget = Object.freeze({ contract: 'dshos-target-scope-v2', platform: 'dsh', computerId: i.computerId,
        memberId: i.memberId, pairingId: i.pairingId, instanceId: this.instanceId, enableEpoch: this.enableEpoch, sessionId })
      entry = { scope, target, lease, port: this.options.port(sessionId), retainedUntil: 0, content: null, queue: null, driver: null, opening: null,
        authorities: new Map(), operations: new Map() }
      this.entries.set(scope, entry)
    } else {
      if (!encode(entry.lease.identity).equals(encode(i))) throw Error('queue_identity_changed')
      entry.lease = lease
    }
    await this.database(); this.checkEntry(entry); assertTransport()
    await this.bind(entry, false); this.checkEntry(entry); assertTransport()
    return entry
  }
  async bind(entry: DshQueueEntry, create: boolean): Promise<void> {
    this.checkEntry(entry)
    if (entry.opening) { await entry.opening; return this.bind(entry, create) }
    this.checkEntry(entry)
    if (entry.queue) return
    entry.opening = (async () => {
      const store = this.db!.forScope(entry.scope), raw = await store.read(); this.checkEntry(entry)
      if (raw === null && !create) return // A read never allocates a session queue.
      entry.queue = await SessionMessageQueue.open(store, entry.scope, this.enableEpoch, () => this.checkEntry(entry), this.now)
      this.checkEntry(entry)
      entry.driver = new DshMessageQueueDriver(entry.port, entry.queue, () => this.authorize(entry), () => this.checkEntry(entry), this.enableEpoch, {
        dispatch: async (claim,guard) => (await this.contentBinding(entry,false)).resolve(claim,guard),
        retained: async (item,guard) => (await this.contentBinding(entry,false)).readItem(item.id,item.bodyDigest,guard)
      })
    })()
    try { await entry.opening } finally { entry.opening = null }
  }
  private async contentStore(entry: DshQueueEntry,create: boolean): Promise<QueueContentDatabase> {
    this.checkEntry(entry)
    if(!this.contentOpening)this.contentOpening=(async()=>{
      const marker=new RegistrationFile<ContentMarker>(join(this.options.directory,'queue-content-init-v1.json'),createWindowsQueueContentInitProtector(),contentMarkerValid)
      let state=await marker.read();this.check()
      let exists=true
      try { await lstat(join(this.options.directory,'queue-message-content-v1.sqlite')) }
      catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw e }
      this.check()
      if(!state){
        if(!exists&&!create)throw Error('queue_content_not_initialized')
        if(exists)throw Error('queue_content_initialization_unconfirmed')
        state={contract:'dshos-queue-content-init-v1',state:'initializing'}
        await marker.write(state,{assertHeld:()=>this.check()});this.check()
      }
      this.contentDb=await QueueContentDatabase.open(this.options.directory,createWindowsQueueContentDataProtector(),()=>this.check(),state.state==='initializing')
      this.check()
      if(state.state!=='ready')await marker.write({contract:state.contract,state:'ready'},{assertHeld:()=>this.check()})
      this.check()
    })().catch(e=>{if(e instanceof Error&&e.message==='queue_content_not_initialized')this.contentOpening=null;throw e})
    await this.contentOpening;this.checkEntry(entry);return this.contentDb!
  }
  private async contentBinding(entry: DshQueueEntry,create: boolean): Promise<QueueContentBinding> {
    this.checkEntry(entry);if(!entry.queue)throw Error('queue_not_initialized')
    await this.contentStore(entry,create);this.checkEntry(entry)
    entry.content??=new QueueContentBinding(entry.scope,entry.queue,this.contentDb!,()=>this.checkEntry(entry))
    return entry.content
  }
  // These internal methods require the existing authenticated actor guard. They
  // neither grant dispatch authority nor change the released text-only wire.
  async stageContent(entry: DshQueueEntry,reference: QueueContentReference,bytes: Buffer,guard: () => void): Promise<void> {
    this.checkEntry(entry);guard();const ref=readQueueContentReference(reference)
    if(!Buffer.isBuffer(bytes)||bytes.length!==ref.bytes)throw Error('queue_content_digest')
    if(this.contentStaging)throw Error('queue_content_preparation_busy')
    const copy=Buffer.from(bytes);this.contentStaging=true
    try { await this.bind(entry,true);guard();const binding=await this.contentBinding(entry,true);guard();await binding.stage(ref,copy,guard);this.checkEntry(entry);guard() }
    finally {copy.fill(0);this.contentStaging=false}
  }
  transferContent(entry: DshQueueEntry,actor: object,value: unknown,guard: () => void): Promise<QueueContentTransferState | null> {
    const check=()=>{this.checkEntry(entry);guard()};check()
    return this.transfers.request(actor,entry.scope,value,check,(ref,bytes,active)=>this.stageContent(entry,ref,bytes,active))
  }
  async readContent(entry: DshQueueEntry,itemId: string,bodyDigest: string,guard: () => void): Promise<QueueMessageContent> {
    this.checkEntry(entry);guard();const binding=await this.contentBinding(entry,false);guard()
    return binding.readItem(itemId,bodyDigest,guard)
  }
  async readContentChunk(entry: DshQueueEntry,itemId: string,bodyDigest: string,offset: number,guard: () => void): Promise<{reference:QueueContentReference;offset:number;data:string}> {
    this.checkEntry(entry);guard();const binding=await this.contentBinding(entry,false);guard()
    return binding.readItemChunk(itemId,bodyDigest,offset,guard)
  }
  async releaseContent(entry: DshQueueEntry,reference: QueueContentReference,guard: () => void): Promise<void> {
    const ref=readQueueContentReference(reference)
    const check=()=>{
      this.checkEntry(entry);guard();if(this.contentStaging)throw Error('queue_content_preparation_busy')
      for(const item of this.snapshot(entry).items){if(item.body&&readQueueBoundContent(item.body)?.id===ref.id)throw Error('queue_content_still_referenced')}
    }
    check();let store: QueueContentDatabase
    try {store=await this.contentStore(entry,false)}
    catch(e){if(!(e instanceof Error)||e.message!=='queue_content_not_initialized')throw e;check();return}
    check()
    if(entry.queue){const binding=await this.contentBinding(entry,false);check();await binding.release(ref,check)}
    else await store.remove(entry.scope,ref,check)
    check()
  }
  async settledSnapshot(entry: DshQueueEntry): Promise<Pick<QueueRecord, 'revision' | 'paused' | 'items' | 'operations'>> {
    this.checkEntry(entry); if (entry.opening) await entry.opening
    const state = entry.queue ? await entry.queue.settledSnapshot() : this.snapshot(entry)
    this.checkEntry(entry); return state
  }
  async recoveredSnapshot(entry: DshQueueEntry): Promise<Pick<QueueRecord, 'revision' | 'paused' | 'items' | 'operations'>> {
    this.checkEntry(entry); await entry.driver?.recover(); this.checkEntry(entry)
    return this.settledSnapshot(entry)
  }
  snapshot(entry: DshQueueEntry): Pick<QueueRecord, 'revision' | 'paused' | 'items' | 'operations'> {
    this.checkEntry(entry)
    return entry.queue?.snapshot() ?? { revision: 0, paused: 'none', items: [], operations: [] }
  }
  runId(entry: DshQueueEntry): string | null {
    this.checkEntry(entry)
    if (entry.driver) return entry.driver.runId()
    const current = entry.port.currentTurn()
    return current ? createHash('sha256').update(JSON.stringify([this.enableEpoch, current.agent.id, current.number, current.seq]))
      .digest().subarray(0,16).toString('base64url') : null
  }
  setAuthority(entry: DshQueueEntry, actor: object, authorize: () => Promise<() => void>): void {
    this.checkEntry(entry); entry.authorities.delete(actor)
    while (entry.authorities.size >= 4) entry.authorities.delete(entry.authorities.keys().next().value!)
    entry.authorities.set(actor, authorize)
  }
  forget(actor: object): void { this.transfers.releaseOwner(actor);for (const e of this.entries.values()) e.authorities.delete(actor) }
  private async authorize(entry: DshQueueEntry): Promise<() => void> {
    this.checkEntry(entry)
    for (const [actor, authorize] of [...entry.authorities].reverse()) {
      try {
        const assert = await authorize(); this.checkEntry(entry)
        if (entry.authorities.get(actor) !== authorize) continue
        assert()
        return () => { this.checkEntry(entry); if (entry.authorities.get(actor) !== authorize) throw Error('queue_auth_required'); assert() }
      } catch { entry.authorities.delete(actor) }
    }
    throw Error('queue_auth_required')
  }
  async apply(entry: DshQueueEntry, ticket: DshQueueTicket, body: Record<string, unknown>, assertCurrent: () => void): Promise<string | null> {
    this.checkEntry(entry); assertCurrent()
    const operation = { id: ticket.operationId, ticketDigest: digest(ticket), assertCurrent }
    const prior = this.snapshot(entry).operations.find(v => v.id === operation.id)
    if (prior) {
      if (prior.ticketDigest !== operation.ticketDigest) throw Error('queue_operation_conflict')
      return ticket.action === 'stop' ? 'unconfirmed' : null
    }
    const old = entry.operations.get(operation.id)
    if (old) {
      if (old.digest !== operation.ticketDigest) throw Error('queue_operation_conflict')
      await old.promise; this.checkEntry(entry); assertCurrent()
      return ticket.action === 'stop' ? 'unconfirmed' : null
    }
    const promise = this.applyOnce(entry, ticket, body, operation)
    entry.operations.set(operation.id, { digest: operation.ticketDigest, promise })
    try { return await promise } finally { entry.operations.delete(operation.id) }
  }
  private async applyOnce(entry: DshQueueEntry, ticket: DshQueueTicket, body: Record<string, unknown>, operation: QueueOperationIdentity): Promise<string | null> {
    // An existing queue must latch stop before yielding to another native admission.
    if (!entry.queue) await this.bind(entry, true)
    this.checkEntry(entry); operation.assertCurrent!()
    const q = entry.queue!, driver = entry.driver!
    let stopped: string | null = null
    if (ticket.action === 'stop') stopped = await driver.stop(ticket.runId, operation)
    else if (ticket.action === 'enqueue' || ticket.action === 'edit') {
      const ref=readQueueBoundContent(JSON.stringify(body))
      if(ref){
        const binding=await this.contentBinding(entry,false);operation.assertCurrent!()
        if(ticket.action==='enqueue')await binding.enqueue(ticket.operationId,ref,operation)
        else await binding.edit(ticket.subjectId!,ref,ticket.expectedRevision!,operation)
      }else if(ticket.action==='enqueue')await q.enqueue(ticket.operationId,JSON.stringify(body),operation)
      else await q.edit(ticket.subjectId!,JSON.stringify(body),ticket.expectedRevision!,operation)
    }
    else if (ticket.action === 'resume') await q.resume(ticket.expectedRevision!, operation)
    else if (ticket.action === 'remove') await q.remove(ticket.subjectId!, ticket.expectedRevision!, operation)
    else if (ticket.action === 'dismiss') await q.dismiss(ticket.subjectId!, ticket.expectedRevision!, operation)
    else if (ticket.action === 'reorder') await q.reorder(body.ids as string[], ticket.expectedRevision!, operation)
    this.checkEntry(entry); operation.assertCurrent!()
    if (ticket.action === 'enqueue' || ticket.action === 'resume') driver.wake()
    return stopped
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true;this.transfers.close()
    for (const e of this.entries.values()) { e.authorities.clear(); e.driver?.close(); e.content?.close(); e.queue?.close() }
    this.closing = (async () => {
      try { await this.opening } catch {}
      await Promise.allSettled([...this.entries.values()].flatMap(e => [e.opening, ...[...e.operations.values()].map(o => o.promise)]))
      for (const e of this.entries.values()) { e.driver?.close(); e.content?.close(); e.queue?.close() }
      try { await this.contentOpening } catch {}
      await Promise.allSettled([...this.entries.values()].map(e=>e.content?.settled()))
      this.contentDb?.close();this.contentDb=null
      this.db?.close(); this.db = null
      await this.owner?.release(); this.owner = null
    })()
    return this.closing
  }
}
