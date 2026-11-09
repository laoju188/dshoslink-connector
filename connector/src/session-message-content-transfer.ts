import { randomBytes } from 'node:crypto'
import { timingSafeEqual } from 'node:crypto'
import { queueContentId, queueContentHash, readQueueContentReference, type QueueContentReference } from './session-message-content.js'

export const QUEUE_CONTENT_CHUNK_BYTES = 16384
const IDLE_MS = 120000
export interface QueueContentTransferState {
  uploadId: string; reference: QueueContentReference; offset: number; chunkBytes: number; expiresAt: number; ready: boolean
}
interface Upload {
  owner: object; scope: string; id: string; ref: QueueContentReference; data: Buffer | null
  offset: number; expiresAt: number; ready: boolean; busy: boolean
}
// One receiver per existing authenticated runtime, shared by its LAN/relay actors.
// No credential, network listener or dispatch authority lives here. Only finish
// may persist through the owning runtime's guarded content store; it never enqueues.
export class QueueContentTransfer {
  private upload: Upload | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private high = -1
  constructor(private readonly now = Date.now) {}
  private clear(): void {
    const old=this.upload;this.upload=null
    if(this.timer)clearTimeout(this.timer);this.timer=null
    old?.data?.fill(0);if(old)old.data=null
  }
  private time(): number {
    if(this.closed)throw Error('queue_content_transfer_closed')
    const value=this.now()
    if(!Number.isSafeInteger(value)||value<0||value<this.high||value>=Number.MAX_SAFE_INTEGER-IDLE_MS){this.clear();throw Error('queue_content_transfer_clock')}
    this.high=value
    if(this.upload&&value>=this.upload.expiresAt)this.clear()
    return value
  }
  private touch(upload: Upload,now: number): void {
    if(this.closed||this.upload!==upload)throw Error('queue_content_transfer_stale')
    upload.expiresAt=now+IDLE_MS
    if(this.timer)clearTimeout(this.timer)
    this.timer=setTimeout(()=>{if(this.upload===upload)this.clear()},IDLE_MS);this.timer.unref()
  }
  private current(owner: object,scope: string,uploadId: string,guard: () => void): Upload {
    guard();this.time();const state=this.upload
    if(!state||state.owner!==owner||state.scope!==scope||state.id!==uploadId)throw Error('queue_content_transfer_stale')
    return state
  }
  private result(state: Upload): QueueContentTransferState {
    return {uploadId:state.id,reference:{...state.ref},offset:state.offset,chunkBytes:QUEUE_CONTENT_CHUNK_BYTES,expiresAt:state.expiresAt,ready:state.ready}
  }
  begin(owner: object,scope: string,reference: QueueContentReference,guard: () => void): QueueContentTransferState {
    guard();const now=this.time(),ref=readQueueContentReference(reference)
    if(owner===null||typeof owner!=='object'||!queueContentId(scope,32))throw Error('queue_content_transfer_scope')
    const previous=this.upload
    if(previous){
      if(previous.owner!==owner||previous.scope!==scope)throw Error('queue_content_transfer_busy')
      if(JSON.stringify(previous.ref)===JSON.stringify(ref))return this.result(previous)
      if(!previous.ready||previous.busy)throw Error('queue_content_transfer_busy')
      this.clear()
    }
    const state: Upload={owner,scope,id:randomBytes(16).toString('base64url'),ref:Object.freeze(ref),data:Buffer.alloc(ref.bytes),offset:0,expiresAt:0,ready:false,busy:false}
    this.upload=state;this.touch(state,now);return this.result(state)
  }
  inspect(owner: object,scope: string,uploadId: string,guard: () => void): QueueContentTransferState {
    return this.result(this.current(owner,scope,uploadId,guard))
  }
  chunk(owner: object,scope: string,uploadId: string,offset: number,data: string,guard: () => void): QueueContentTransferState {
    const state=this.current(owner,scope,uploadId,guard)
    if(state.busy||state.ready||!state.data)throw Error('queue_content_transfer_busy')
    if(!Number.isSafeInteger(offset)||offset<0||offset>=state.ref.bytes||offset%QUEUE_CONTENT_CHUNK_BYTES!==0
      ||typeof data!=='string'||data.length>Math.ceil(QUEUE_CONTENT_CHUNK_BYTES*4/3)||!/^[A-Za-z0-9_-]+$/.test(data))throw Error('queue_content_transfer_chunk')
    const raw=Buffer.from(data,'base64url')
    try {
      if(raw.toString('base64url')!==data||raw.length!==Math.min(QUEUE_CONTENT_CHUNK_BYTES,state.ref.bytes-offset)||offset>state.offset)throw Error('queue_content_transfer_order')
      if(offset<state.offset){
        if(offset+raw.length>state.offset||!timingSafeEqual(state.data.subarray(offset,offset+raw.length),raw))throw Error('queue_content_transfer_conflict')
      }else {raw.copy(state.data,offset);state.offset+=raw.length}
      guard();this.touch(state,this.time());return this.result(state)
    } finally {raw.fill(0)}
  }
  async finish(owner: object,scope: string,uploadId: string,guard: () => void,
    persist: (reference: QueueContentReference,bytes: Buffer,guard: () => void) => Promise<void>): Promise<QueueContentTransferState> {
    const state=this.current(owner,scope,uploadId,guard)
    if(state.ready)return this.result(state)
    if(state.busy)throw Error('queue_content_transfer_busy')
    if(state.offset!==state.ref.bytes||!state.data||queueContentHash(state.data)!==state.ref.sha256)throw Error('queue_content_transfer_incomplete')
    const check=()=>{if(this.current(owner,scope,uploadId,guard)!==state)throw Error('queue_content_transfer_stale')}
    state.busy=true
    try {
      check();await persist(state.ref,state.data,check);check()
      state.data.fill(0);state.data=null;state.ready=true;this.touch(state,this.time());return this.result(state)
    } finally {state.busy=false}
  }
  abort(owner: object,scope: string,uploadId: string,guard: () => void): void {
    this.current(owner,scope,uploadId,guard);this.clear()
  }
  async request(owner: object,scope: string,value: unknown,guard: () => void,
    persist: (reference: QueueContentReference,bytes: Buffer,guard: () => void) => Promise<void>): Promise<QueueContentTransferState | null> {
    guard()
    if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('queue_content_transfer_format')
    const v=value as Record<string,unknown>,keys=(names: string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k))
    if(v.action==='begin'&&keys(['action','reference']))return this.begin(owner,scope,readQueueContentReference(v.reference),guard)
    if(!queueContentId(v.uploadId))throw Error('queue_content_transfer_format')
    if(v.action==='chunk'&&keys(['action','uploadId','offset','data']))return this.chunk(owner,scope,v.uploadId,v.offset as number,v.data as string,guard)
    if(!keys(['action','uploadId']))throw Error('queue_content_transfer_format')
    if(v.action==='inspect')return this.inspect(owner,scope,v.uploadId,guard)
    if(v.action==='finish')return this.finish(owner,scope,v.uploadId,guard,persist)
    if(v.action==='abort'){this.abort(owner,scope,v.uploadId,guard);return null}
    throw Error('queue_content_transfer_format')
  }
  releaseOwner(owner: object): void { if(this.upload?.owner===owner)this.clear() }
  close(): void { this.closed=true;this.clear() }
}
