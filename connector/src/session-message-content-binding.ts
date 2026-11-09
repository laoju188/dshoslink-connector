import { createHash } from 'node:crypto'
import { QueueContentDatabase } from './session-message-content-store.js'
import { SessionMessageQueue, type QueueClaim, type QueueOperationIdentity, type QueueRecord } from './session-message-queue.js'
import { queueContentId, queueBoundContent, readQueueBoundContent, readQueueContentReference,
  readQueueMessageContent, type QueueContentReference, type QueueMessageContent } from './session-message-content.js'

// Exactly one binding per queue under its existing runtime owner. Stop/removal
// may run immediately in the queue; only adding/replacing content references and
// explicit content release share this serial fence. Reads never dispatch.
export class QueueContentBinding {
  private serial: Promise<void> = Promise.resolve()
  private closed = false
  private staging = false
  constructor(private readonly scope: string,private readonly queue: SessionMessageQueue,
    private readonly store: QueueContentDatabase,private readonly assertOwner: () => void) {
    if(!queueContentId(scope,32))throw Error('queue_content_scope');this.current()
  }
  close(): void { this.closed=true }
  private current(): QueueRecord {
    this.assertOwner();if(this.closed)throw Error('queue_content_binding_closed')
    const record=this.queue.snapshot();if(record.scope!==this.scope)throw Error('queue_content_scope');return record
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const next=this.serial.then(async()=>{this.current();return action()})
    this.serial=next.then(()=>{},()=>{});return next
  }
  async settled(): Promise<void> { await this.serial }
  stage(reference: QueueContentReference,bytes: Buffer,guard: () => void): Promise<void> {
    const ref=readQueueContentReference(reference)
    if(!Buffer.isBuffer(bytes)||bytes.length!==ref.bytes)throw Error('queue_content_digest')
    // Snapshot before the serial wait so an upstream upload cannot mutate its input.
    if(this.staging)throw Error('queue_content_preparation_busy')
    this.staging=true
    let copy: Buffer
    try { copy=Buffer.from(bytes) } catch(e) { this.staging=false;throw e }
    return this.run(async()=>{
      const check=()=>{this.current();guard()};check();await this.store.put(this.scope,ref,copy,check);check()
    }).finally(()=>{copy.fill(0);this.staging=false})
  }
  private async retained(ref: QueueContentReference,operation?: QueueOperationIdentity): Promise<void> {
    const check=()=>{this.current();operation?.assertCurrent?.()};check()
    const prior=operation&&this.current().operations.find(v=>v.id===operation.id)
    // The queue validates a repeated operation's digest. Do not require payload
    // bytes that a completed original operation may legitimately have released.
    if(prior)return
    const bytes=await this.store.read(this.scope,ref,check);bytes.fill(0);check()
  }
  enqueue(id: string,reference: QueueContentReference,operation?: QueueOperationIdentity): Promise<QueueRecord> {
    const ref=readQueueContentReference(reference)
    return this.run(async()=>{await this.retained(ref,operation);const record=await this.queue.enqueue(id,queueBoundContent(ref),operation);this.current();return record})
  }
  edit(id: string,reference: QueueContentReference,revision: number,operation?: QueueOperationIdentity): Promise<QueueRecord> {
    const ref=readQueueContentReference(reference)
    return this.run(async()=>{await this.retained(ref,operation);const record=await this.queue.edit(id,queueBoundContent(ref),revision,operation);this.current();return record})
  }
  release(reference: QueueContentReference,guard: () => void): Promise<void> {
    const ref=readQueueContentReference(reference)
    return this.run(async()=>{
      const check=()=>{
        const state=this.current();guard()
        for(const item of state.items) {
          if(!item.body)continue
          const bound=readQueueBoundContent(item.body)
          if(bound?.id===ref.id)throw Error('queue_content_still_referenced')
        }
      }
      check();await this.store.remove(this.scope,ref,check);check()
    })
  }
  async resolve(claim: QueueClaim,guard: () => void): Promise<QueueMessageContent> {
    const original: QueueClaim={id:claim.id,body:claim.body,bodyDigest:claim.bodyDigest,dispatchId:claim.dispatchId}
    const ref=readQueueBoundContent(original.body)
    if(ref===null)throw Error('queue_content_reference_required')
    const check=()=>{
      const state=this.current();guard();const item=state.items.find(v=>v.id===original.id)
      if(!item||item.state!=='dispatching'||item.dispatchId!==original.dispatchId||item.body!==original.body||item.bodyDigest!==original.bodyDigest
        ||createHash('sha256').update(original.body).digest('base64url')!==original.bodyDigest)throw Error('queue_content_claim_changed')
    }
    check();const bytes=await this.store.read(this.scope,ref,check)
    try { const content=readQueueMessageContent(bytes);check();return content } finally { bytes.fill(0) }
  }
  async readItemChunk(itemId: string,bodyDigest: string,offset: number,guard: () => void): Promise<{reference:QueueContentReference;offset:number;data:string}> {
    const original=this.current().items.find(v=>v.id===itemId)
    if(!original||!original.body||original.bodyDigest!==bodyDigest)throw Error('queue_content_item_changed')
    const ref=readQueueBoundContent(original.body);if(ref===null)throw Error('queue_content_reference_required')
    const check=()=>{
      const item=this.current().items.find(v=>v.id===itemId);guard()
      if(!item||item.body!==original.body||item.bodyDigest!==bodyDigest)throw Error('queue_content_item_changed')
    }
    check();const bytes=await this.store.readChunk(this.scope,ref,offset,check)
    try {check();return {reference:ref,offset,data:bytes.toString('base64url')}} finally {bytes.fill(0)}
  }
  async readItem(itemId: string,bodyDigest: string,guard: () => void): Promise<QueueMessageContent> {
    const original=this.current().items.find(v=>v.id===itemId)
    if(!original||!original.body||original.bodyDigest!==bodyDigest)throw Error('queue_content_item_changed')
    const ref=readQueueBoundContent(original.body);if(ref===null)throw Error('queue_content_reference_required')
    const check=()=>{
      const item=this.current().items.find(v=>v.id===itemId);guard()
      if(!item||!item.body||item.body!==original.body||item.bodyDigest!==bodyDigest)throw Error('queue_content_item_changed')
    }
    check();const bytes=await this.store.read(this.scope,ref,check)
    try { const content=readQueueMessageContent(bytes);check();return content } finally { bytes.fill(0) }
  }

}
