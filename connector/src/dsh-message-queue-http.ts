import { readQueueBoundContent, readQueueContentReference } from './session-message-content.js'
import { resolveQueueOperation } from './session-message-queue.js'
import { createHash, randomBytes, createPublicKey, sign, verify } from 'node:crypto'
import { registrationBytes as encode, registrationDigest as digest, registrationFields as fields, registrationId as id,
  registrationJson, type JsonRecord } from './dsh-registration-contract.js'
import { DSH_QUEUE_REVISION as REV, DSH_QUEUE_CONTENT_REVISION as CONTENT_REV, dshQueueRevision, DSH_QUEUE_PREFIX as PREFIX, DSH_QUEUE_ACTIONS, DSH_QUEUE_PATH,
  dshQueueBody, dshQueueTarget, dshQueueTicket, dshQueueTranscript, dshQueueSessionId } from './dsh-message-queue-contract.js'
import { DshMessageQueueRuntime, type DshQueueEntry } from './dsh-message-queue-runtime.js'
import type { SessionListAuthorizer } from './session-list.js'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
const fresh = (): string => randomBytes(16).toString('base64url')
const same = (a: unknown, b: unknown): boolean => encode(a).equals(encode(b))
interface Capability { contract: string; revision: string; accountBindingId: string; keyGeneration: string; target: DshQueueEntry['target']
  queueScope: string; capabilityId: string; actions: readonly string[]; formats: readonly string[]; issuedAt: number; expiresAt: number }
class Actor {
  private cap: Capability | null = null
  private high = -1
  private closed = false
  constructor(private readonly runtime: DshMessageQueueRuntime, readonly entry: DshQueueEntry,
    private readonly assertTransport: () => void, private readonly now: () => number) {}
  usable(): boolean { try { this.check(); return true } catch { return false } }
  close(): void { this.closed = true; this.cap = null; this.runtime.forget(this) }
  private check = (): void => { if (this.closed) throw Error('queue_closed'); this.assertTransport(); this.runtime.checkEntry(this.entry) }
  private time(): number {
    const time = this.now()
    if (!Number.isSafeInteger(time) || time < 0 || time < this.high || time >= Number.MAX_SAFE_INTEGER - 86400000) throw Error('queue_clock')
    this.runtime.observeTime(time); this.high = time; return time
  }
  private signed(kind: 'capability' | 'ticket' | 'receipt' | 'snapshot' | 'resolution' | 'content', value: unknown): JsonRecord {
    this.check()
    return { [kind]: value, signature: sign(null, dshQueueTranscript(kind, value), this.entry.lease.memberKey).toString('base64url') }
  }
  capabilities(v: JsonRecord): Buffer {
    this.check()
    if (!fields(v, ['contract','revision','sessionId']) || v.contract !== PREFIX + 'capabilities-v2'
      || !dshQueueRevision(v.revision) || v.sessionId !== this.entry.target.sessionId) throw Error('queue_revision_required')
    const now = this.time(), i = this.entry.lease.identity
    // After this response, prepare and commit each need a 20s request budget.
    // Issuance happens after connect; reserve 10s for this reply (LAN read is 8s)
    // plus 40s for that chain. Never extend an old envelope or ticket deadline.
    if (!this.cap || this.cap.revision !== v.revision || now >= this.cap.expiresAt - 50000) this.cap = { contract: PREFIX + 'capability-v2', revision: v.revision,
      accountBindingId: i.accountBindingId, keyGeneration: i.keyGeneration, target: this.entry.target, queueScope: this.entry.scope,
      capabilityId: fresh(), actions: [...DSH_QUEUE_ACTIONS], formats: v.revision===CONTENT_REV?['text','content-v1']:['text'], issuedAt: now, expiresAt: now + 60000 }
    this.runtime.retainCapability(this.entry, this.cap.expiresAt)
    return encode({ contract: PREFIX + 'capabilities-v2', revision: this.cap.revision, ...this.signed('capability', this.cap) })
  }
  private active(): { now: number; cap: Capability } {
    this.check(); const now = this.time(), cap = this.cap
    if (!cap || now < cap.issuedAt || now >= cap.expiresAt) throw Error('queue_revision_required')
    return { now, cap }
  }
  prepare(v: JsonRecord): Buffer {
    const { now, cap } = this.active()
    if (!fields(v, ['contract','target','capabilityDigest','action','subjectId','runId','expectedRevision','bodyDigest'])
      || v.contract !== PREFIX + 'prepare-v2' || !same(v.target, this.entry.target) || v.capabilityDigest !== digest(cap)) throw Error('queue_prepare')
    const ticket = dshQueueTicket(encode({ contract: PREFIX + 'ticket-v2', revision: cap.revision, accountBindingId: cap.accountBindingId,
      keyGeneration: cap.keyGeneration, target: cap.target, queueScope: cap.queueScope, capabilityDigest: v.capabilityDigest,
      operationId: fresh(), nonce: fresh(), action: v.action, subjectId: v.subjectId, runId: v.runId, expectedRevision: v.expectedRevision,
      bodyDigest: v.bodyDigest, issuedAt: now, expiresAt: Math.min(now + 30000, cap.expiresAt) }))
    return encode({ contract: PREFIX + 'prepared-v2', revision: cap.revision, ...this.signed('ticket', ticket) })
  }
  async operation(v: JsonRecord): Promise<Buffer> {
    const { now, cap } = this.active()
    if (!fields(v, ['contract','ticket','signature','body']) || v.contract !== PREFIX + 'commit-v2') throw Error('queue_commit')
    const t = dshQueueTicket(encode(v.ticket)), i = this.entry.lease.identity
    if (!id(v.signature,64) || !verify(null, dshQueueTranscript('ticket',t), createPublicKey(this.entry.lease.memberKey), Buffer.from(v.signature,'base64url'))
      || !same(t.target,this.entry.target) || t.accountBindingId !== i.accountBindingId || t.keyGeneration !== i.keyGeneration
      || t.revision !== cap.revision || t.queueScope !== this.entry.scope || t.capabilityDigest !== digest(cap) || t.issuedAt < cap.issuedAt || t.expiresAt > cap.expiresAt
      || now < t.issuedAt || now >= t.expiresAt || digest(v.body) !== t.bodyDigest) throw Error('queue_commit')
    const body = dshQueueBody(t.action,v.body,t.revision), assertCurrent = (): void => {
      this.check(); if (this.cap !== cap || this.time() >= t.expiresAt) throw Error('queue_commit')
    }
    assertCurrent()
    // This guard belongs to the original authenticated generation. Reconnecting
    // and reading may inspect the record, but cannot refresh execution authority.
    if (t.action === 'enqueue' || t.action === 'resume') this.runtime.setAuthority(this.entry, this, async () => { this.check(); return this.check })
    const stopState = await this.runtime.apply(this.entry,t,body,assertCurrent); assertCurrent()
    const state = this.runtime.snapshot(this.entry)
    const receipt = { contract: PREFIX + 'receipt-v2', revision: t.revision, target: this.entry.target, queueScope: this.entry.scope,
      operationId: t.operationId, ticketDigest: digest(t), queueRevision: state.revision, paused: state.paused, stopState }
    return encode({ contract: PREFIX + 'receipt-envelope-v2', revision: t.revision, ...this.signed('receipt', receipt) })
  }
  async resolve(v: JsonRecord): Promise<Buffer> {
    this.check()
    if (!fields(v,['contract','target','prepared']) || v.contract !== PREFIX+'resolve-v1' || !same(v.target,this.entry.target)
      || !fields(v.prepared,['contract','revision','ticket','signature']) || v.prepared.contract !== PREFIX+'prepared-v2'
      || !dshQueueRevision(v.prepared.revision)) throw Error('queue_resolution')
    const t = dshQueueTicket(encode(v.prepared.ticket)), i = this.entry.lease.identity, target = this.entry.target
    if (t.revision !== v.prepared.revision || !id(v.prepared.signature,64) || !verify(null,dshQueueTranscript('ticket',t),createPublicKey(this.entry.lease.memberKey),Buffer.from(v.prepared.signature,'base64url'))
      || t.accountBindingId !== i.accountBindingId || t.keyGeneration !== i.keyGeneration || t.queueScope !== this.entry.scope
      || t.target.computerId !== target.computerId || t.target.memberId !== target.memberId || t.target.pairingId !== target.pairingId
      || t.target.sessionId !== target.sessionId) throw Error('queue_resolution')
    const expired = this.time() >= t.expiresAt
    const state = await this.runtime.settledSnapshot(this.entry); this.check(); const now = this.time()
    const result = resolveQueueOperation(state,{id:t.operationId,ticketDigest:digest(t)},t.issuedAt,t.expiresAt,now,expired && same(t.target,target))
    const resolution = { contract:PREFIX+'resolution-v1',revision:t.revision,accountBindingId:i.accountBindingId,keyGeneration:i.keyGeneration,
      target,queueScope:this.entry.scope,operationId:t.operationId,ticketDigest:digest(t),queueRevision:state.revision,
      state:result.state,operationReceipt:result.operationReceipt,observedAt:now }
    return encode({contract:PREFIX+'resolution-envelope-v1',revision:t.revision,...this.signed('resolution',resolution)})
  }
  async content(v: JsonRecord): Promise<Buffer> {
    const {cap}=this.active()
    if(cap.revision!==CONTENT_REV||!fields(v,['contract','revision','target','capabilityDigest','request'])
      ||v.contract!==PREFIX+'content-v1'||v.revision!==CONTENT_REV||!same(v.target,cap.target)||v.capabilityDigest!==digest(cap))throw Error('queue_content_revision_required')
    const check=()=>{this.check();if(this.cap!==cap||this.time()>=cap.expiresAt)throw Error('queue_content_capability_expired')};check()
    const request=v.request
    let result: unknown
    if(fields(request,['action','itemId','bodyDigest','offset'])&&request.action==='read'){
      if(!id(request.itemId)||!id(request.bodyDigest,32))throw Error('queue_content_read')
      result=await this.runtime.readContentChunk(this.entry,request.itemId,request.bodyDigest,request.offset as number,check)
    }else if(fields(request,['action','reference'])&&request.action==='release'){
      await this.runtime.releaseContent(this.entry,readQueueContentReference(request.reference),check);result=null
    }else result=await this.runtime.transferContent(this.entry,this,request,check)
    check();const content={contract:PREFIX+'content-result-v1',revision:CONTENT_REV,target:cap.target,queueScope:cap.queueScope,
      capabilityDigest:digest(cap),requestDigest:digest(request),result,observedAt:this.time()}
    const out=encode({contract:PREFIX+'content-envelope-v1',revision:CONTENT_REV,...this.signed('content',content)})
    if(out.length>32768)throw Error('queue_capacity');return out
  }
  async read(v: JsonRecord): Promise<Buffer> {
    this.check()
    if (!fields(v, ['contract','target','itemId','operationId']) || v.contract !== PREFIX + 'read-v2'
      || !same(v.target,this.entry.target) || v.itemId !== null && !id(v.itemId) || v.operationId !== null && !id(v.operationId)) throw Error('queue_read')
    const cap=this.cap,revision=cap?.revision??REV
    const state = await this.runtime.recoveredSnapshot(this.entry); this.check();if(this.cap!==cap)throw Error('queue_revision_changed')
    const found = v.itemId === null ? null : state.items.find(i => i.id === v.itemId)
    const items = state.items.filter(i => !['completed','rejected','deleted','dismissed'].includes(i.state))
      .map(i => ({ id:i.id,state:i.state,bodyDigest:i.bodyDigest,createdAt:i.createdAt,updatedAt:i.updatedAt }))
    const item = !found ? null : { id:found.id,state:found.state,bodyDigest:found.bodyDigest,body:found.body,createdAt:found.createdAt,updatedAt:found.updatedAt }
    if(revision===REV&&item?.body&&readQueueBoundContent(item.body)!==null)throw Error('queue_content_revision_required')
    const i = this.entry.lease.identity, snapshot = { contract: PREFIX + 'snapshot-v2', revision, accountBindingId:i.accountBindingId,
      keyGeneration:i.keyGeneration,target:this.entry.target,queueScope:this.entry.scope,queueRevision:state.revision,paused:state.paused,
      runId:this.runtime.runId(this.entry),items,item,operationId:v.operationId,operationReceipt:v.operationId === null ? null : state.operations.find(o => o.id === v.operationId) ?? null,
      observedAt:this.time() }
    const out = encode({ contract:PREFIX + 'snapshot-envelope-v2',revision,...this.signed('snapshot',snapshot) })
    if (out.length > 32768) throw Error('queue_capacity')
    return out
  }
}
export class DshMessageQueueHttp {
  private closed = false
  private readonly actors = new Map<string, Actor>()
  private readonly pending = new Map<string, Promise<Actor>>()
  constructor(private readonly auth: SessionListAuthorizer, private readonly runtime: DshMessageQueueRuntime,
    private readonly now = () => runtime.nowValue()) {}
  close(): void { this.closed = true; for (const actor of this.actors.values()) actor.close(); this.actors.clear() }
  async handle(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    if (request.path !== DSH_QUEUE_PATH) return { status:404,body:'' }
    if (request.method !== 'POST') return { status:405,body:'' }
    if (request.contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return { status:415,body:'' }
    const assertTransport = (): void => {
      if (this.closed || !this.auth.authorize(request.authorization,request.connectionGeneration)) throw Error('queue_auth_required')
    }
    try { assertTransport() } catch { return { status:401,body:'' } }
    try {
      request.signal?.throwIfAborted()
      const v = registrationJson(request.body,32768)
      let sessionId: unknown = v.sessionId
      if (v.contract !== PREFIX + 'capabilities-v2') {
        const target = v.contract === PREFIX + 'commit-v2' && v.ticket && typeof v.ticket === 'object' ? (v.ticket as JsonRecord).target : v.target
        if (!dshQueueTarget(target)) throw Error('queue_target')
        sessionId = target.sessionId
      }
      if (!dshQueueSessionId(sessionId)) throw Error('queue_session')
      for (const [oldKey, old] of this.actors) if (!old.usable()) { old.close(); this.actors.delete(oldKey) }
      const key = createHash('sha256').update(JSON.stringify([request.authorization,request.connectionGeneration,sessionId])).digest('hex')
      let actor = this.actors.get(key)
      if (!actor) {
        let opening = this.pending.get(key)
        if (!opening) {
          if (this.actors.size + this.pending.size >= 32) {
            await this.runtime.retireExpired(assertTransport); request.signal?.throwIfAborted()
            for (const [oldKey, old] of this.actors) if (!old.usable()) { old.close(); this.actors.delete(oldKey) }
            // Another request may have acquired this key while collection awaited.
            if (this.actors.has(key) || this.pending.has(key)) return this.handle(request)
            if (this.actors.size + this.pending.size >= 32) throw Error('queue_capacity')
          }
          opening = (async () => {
            const entry = await this.runtime.access(sessionId,assertTransport); assertTransport(); request.signal?.throwIfAborted()
            const created = new Actor(this.runtime,entry,assertTransport,this.now)
            this.actors.set(key,created); return created
          })()
          this.pending.set(key,opening)
        }
        try { actor = await opening } finally { this.pending.delete(key) }
      }
      assertTransport(); request.signal?.throwIfAborted()
      let out: Buffer
      if (v.contract === PREFIX + 'capabilities-v2') out = actor.capabilities(v)
      else if (v.contract === PREFIX + 'prepare-v2') out = actor.prepare(v)
      else if (v.contract === PREFIX + 'commit-v2') out = await actor.operation(v)
      else if (v.contract === PREFIX + 'resolve-v1') out = await actor.resolve(v)
      else if (v.contract === PREFIX + 'read-v2') out = await actor.read(v)
      else if (v.contract === PREFIX + 'content-v1') out = await actor.content(v)
      else throw Error('queue_contract')
      assertTransport(); request.signal?.throwIfAborted()
      return { status:200,contentType:'application/json',body:out.toString() }
    } catch {
      try { assertTransport() } catch { return { status:401,body:'' } }
      return { status:409,body:'' }
    }
  }
}
