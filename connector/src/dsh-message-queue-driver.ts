import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionMessageQueue, QueueNativeNotEntered, type QueueClaim, type QueueReceipt, type QueueOperationIdentity, type QueueItem } from './session-message-queue.js'

import { dshQueueHistoryReceipt, type DshQueueExpectedPart } from './dsh-message-queue-history.js'
import { prepareSessionImage } from './session-image-prepare.js'
import { imageReference } from './session-image-contract.js'
import { readQueueBoundContent, readQueueMessageContent, type QueueMessageContent } from './session-message-content.js'

type Value = Record<string, unknown>
const object = (v: unknown): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v)
const fresh = (): string => randomBytes(16).toString('base64url')
const call = (owner: unknown, method: string, ...args: unknown[]): unknown => {
  if (!object(owner) || typeof owner[method] !== 'function') throw Error('dsh_queue_api_unavailable')
  return Reflect.apply(owner[method] as (...args: unknown[]) => unknown, owner, args)
}
interface Text { type: 'text'; text: string }
interface Image { type: 'image'; attachment: Value }
export interface DshQueueContentResolver { dispatch(claim: QueueClaim,guard: () => void): Promise<QueueMessageContent>; retained(item: QueueItem,guard: () => void): Promise<QueueMessageContent> }
export interface DshQueueMessage { content: readonly (Text | Image)[]; source: { kind: 'user'; rpcId: string }; role: 'user'; id: string }
export interface DshQueueAgent {
  id: string
  status: string
  session: { id: string }
  inbox: { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[]; remove(id: string): boolean }
  whenIdle(): Promise<void>
  followup(message: DshQueueMessage): void
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>
  cancel(cause: { kind: 'user' }, options: { keepInbox: true }): void
}
export interface DshQueuePort {
  current(): DshQueueAgent | undefined
  cancel(agent: DshQueueAgent): void
  recover?(item: QueueItem,content?: QueueMessageContent,guard?: () => void): Promise<string | null>
  currentTurn(): { agent: DshQueueAgent; number: number; seq: number } | null
  prepare(text: string, requestId: string): Promise<{ agent: DshQueueAgent; message: DshQueueMessage }>
  prepareContent?(content: QueueMessageContent,requestId: string,guard: () => void): Promise<{ agent: DshQueueAgent; message: DshQueueMessage }>
  on(name: string, listener: (...args: unknown[]) => void): () => void
}
// Preserve the official ordinary-session resolver and attachment admission before
// using the public Agent inbox API. Bound images never become arbitrary file paths.
export function createDshQueuePort(ctx: Context, sessionId: string): DshQueuePort {
  const current = (): DshQueueAgent | undefined => {
    const agents = ctx.get('agents'), agent = call(agents, 'get', sessionId) as DshQueueAgent | undefined
    const session = agent?.session ?? call(ctx.get('sessions'), 'get', sessionId)
    if (session !== undefined) {
      if (!object(session) || !object(session.header) || session.header.id !== sessionId) throw Error('dsh_queue_session_invalid')
      if (session.header.origin === 'subagent') throw Error('dsh_queue_subagent_owned')
      if (agent && session.header.parentSession !== undefined) {
        const parent = call(agents, 'get', session.header.parentSession)
        if (parent && call(agents, 'isOwnedBy', agent.id, parent)) throw Error('dsh_queue_subagent_owned')
      }
    }
    return agent
  }
  const prepareContent = async(value: QueueMessageContent,guard: () => void): Promise<{ input: Value[]; expected: DshQueueExpectedPart[] }>=>{
    const saved=readQueueMessageContent(Buffer.from(JSON.stringify(value))),input: Value[]=[],expected: DshQueueExpectedPart[]=[]
    if(saved.text){input.push({type:'text',text:saved.text});expected.push({type:'text',text:saved.text})}
    let total=0
    for(const image of saved.images){
      guard();const raw=Buffer.from(image.data,'base64url');let prepared: Awaited<ReturnType<typeof prepareSessionImage>> | undefined
      try {
        prepared=await prepareSessionImage({data:raw,mediaType:image.mediaType,name:image.name});guard()
        total+=prepared.data.length;if(total>20*1024*1024)throw Error('dsh_queue_image_capacity')
        input.push({type:'image',mediaType:prepared.mediaType,name:image.name,data:prepared.data.toString('base64')})
        expected.push({type:'image',attachmentId:'sha256:'+createHash('sha256').update(prepared.data).digest('hex'),mediaType:prepared.mediaType,bytes:prepared.data.length})
      } finally {raw.fill(0);prepared?.data.fill(0)}
    }
    guard();return {input,expected}
  }
  // One unsuccessful scan per immutable live cut; no full-log work on steady
  // polling. Cold reads use the official retained preparation without starting
  // an Agent; interrupted/forked synthetic closers never prove completion.
  const scans = new Map<string, { session: object; cursor: number }>()
  return {
    current,
    async recover(item,content,guard = () => {}) {
      const agent = current()
      if (agent && (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)) return null
      const session = agent?.session ?? call(ctx.get('sessions'), 'get', sessionId)
      const service = ctx.get('sessionQuery')
      if (!object(service) || typeof service.observeSession !== 'function') return null
      const cut = await call(service, 'observeSession', sessionId, { projectionMode: 'none' })
      if (!object(cut)) throw Error('dsh_queue_history_invalid')
      const release = (cut as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]
      if (typeof release !== 'function') throw Error('dsh_queue_history_lease')
      try {
        if (current() !== agent || (agent?.session ?? call(ctx.get('sessions'), 'get', sessionId)) !== session
          || agent && (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length)
          || !['live', 'prepared'].includes(cut.source as string) || !object(cut.header) || cut.header.id !== sessionId || cut.header.origin === 'subagent'
          || !Number.isSafeInteger(cut.cursor) || !Number.isSafeInteger(cut.inheritedEventCount)) return null
        const prior = scans.get(item.dispatchId!)
        if (session && prior?.session === session && prior.cursor === cut.cursor) return null
        const events: unknown = cut.events
        if (!Array.isArray(events) || events.length !== (cut.cursor as number) + 1) return null
        const check=()=>{guard();if(current()!==agent||agent&&(agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length))throw Error('dsh_queue_history_changed')}
        const expected=content?(await prepareContent(content,check)).expected:undefined
        check();const ref = dshQueueHistoryReceipt(events, cut.inheritedEventCount as number, item,expected)
        if (ref === null && object(session)) {
          if (scans.size >= 16) scans.delete(scans.keys().next().value!)
          scans.set(item.dispatchId!, { session, cursor: cut.cursor as number })
        }
        return ref
      } finally { Reflect.apply(release, cut, []) }
    },
    cancel(agent) {
      if (current() !== agent) throw Error('dsh_queue_session_changed')
      const result = call(ctx.get('sessionController'), 'cancel', { sessionId })
      if (!object(result) || result.accepted !== true) throw Error('dsh_queue_cancel_unconfirmed')
    },
    currentTurn() {
      const agent = current()
      if (!agent || agent.status !== 'running') return null
      const state = call(ctx.get('sessionProjections'), 'stateOf', agent.session, 'turnBoundary')
      if (!object(state) || state.openTurnStartSeq === null) return null
      if (!Number.isSafeInteger(state.openTurnStartSeq) || (state.openTurnStartSeq as number) < 0
        || !Number.isSafeInteger(state.lastTurn) || (state.lastTurn as number) < 1) throw Error('dsh_queue_turn_invalid')
      return { agent, number: state.lastTurn as number, seq: state.openTurnStartSeq as number }
    },
    async prepare(text, requestId) {
      const found = await call(ctx.get('sessionController'), 'resolveAgent', sessionId)
      if (!object(found) || 'error' in found || !object(found.agent)) throw Error('dsh_queue_session_unavailable')
      const agent = found.agent as unknown as DshQueueAgent
      if (agent !== current() || agent.id !== sessionId || agent.session.id !== sessionId
        || typeof agent.runMaintenance !== 'function' || typeof agent.followup !== 'function' || typeof agent.whenIdle !== 'function'
        || typeof agent.inbox?.remove !== 'function') throw Error('dsh_queue_session_changed')
      const content = await call(ctx.get('attachments'), 'admitPromptContent', [{ type: 'text', text }])
      if (agent !== current() || !Array.isArray(content) || content.length !== 1 || !object(content[0])
        || Object.keys(content[0]).length !== 2 || content[0].type !== 'text' || content[0].text !== text) throw Error('dsh_queue_admission_changed')
      const message: DshQueueMessage = Object.freeze({ content: Object.freeze([Object.freeze({ type: 'text' as const, text })]),
        source: Object.freeze({ kind: 'user' as const, rpcId: requestId }), role: 'user', id: randomUUID() })
      return { agent, message }
    },
    async prepareContent(value,requestId,guard) {
      guard();const found=await call(ctx.get('sessionController'),'resolveAgent',sessionId);guard()
      if(!object(found)||'error' in found||!object(found.agent))throw Error('dsh_queue_session_unavailable')
      const agent=found.agent as unknown as DshQueueAgent
      const check=()=>{guard();if(current()!==agent||agent.id!==sessionId||agent.session.id!==sessionId||typeof agent.runMaintenance!=='function'||typeof agent.followup!=='function'||typeof agent.whenIdle!=='function'||typeof agent.inbox?.remove!=='function')throw Error('dsh_queue_session_changed')}
      check();const prepared=await prepareContent(value,check);check()
      const admitted=await call(ctx.get('attachments'),'admitPromptContent',prepared.input);check()
      if(!Array.isArray(admitted)||admitted.length!==prepared.expected.length)throw Error('dsh_queue_admission_changed')
      const content: (Text|Image)[]=admitted.map((part:unknown,index:number)=>{
        const expected=prepared.expected[index]
        if(!object(part)||part.type!==expected.type)throw Error('dsh_queue_admission_changed')
        if(expected.type==='text'){
          if(part.text!==expected.text)throw Error('dsh_queue_admission_changed')
          return Object.freeze({type:'text' as const,text:expected.text!})
        }
        const ref=imageReference(part.attachment,index)
        if(!ref||ref.attachmentId!==expected.attachmentId||ref.mediaType!==expected.mediaType||ref.bytes!==expected.bytes)throw Error('dsh_queue_admission_changed')
        return Object.freeze({type:'image' as const,attachment:Object.freeze(JSON.parse(JSON.stringify(part.attachment)) as Value)})
      })
      check();const message:DshQueueMessage=Object.freeze({content:Object.freeze(content),source:Object.freeze({kind:'user' as const,rpcId:requestId}),role:'user',id:randomUUID()})
      return {agent,message}
    },
    on(name, listener) { return call(ctx, 'on', name, listener) as () => void }
  }
}
interface Pending {
  claim: QueueClaim; agent: DshQueueAgent; message: DshQueueMessage; turn: number | null
  entered: boolean; admitted: boolean; confirmed: boolean; removed: boolean; done: boolean; withdrawal: Promise<unknown> | null
}

export class DshMessageQueueDriver {
  private readonly disposers: (() => void)[] = []
  private closed = false
  private fault = false
  private scheduled = false
  private recovering: Promise<void> | null = null
  private pumping: Promise<void> | null = null
  private pending: Pending | null = null
  private waitingIdle: DshQueueAgent | null = null
  private turn: { agent: DshQueueAgent; number: number; id: string } | null = null
  constructor(private readonly port: DshQueuePort, private readonly queue: SessionMessageQueue,
    private readonly authorize: () => Promise<() => void>, private readonly assertOwner: () => void, private readonly salt = fresh(), private readonly content: DshQueueContentResolver | null = null) {
    const current = port.currentTurn()
    if (current) this.turn = { agent: current.agent, number: current.number, id: this.turnId(current.agent, current.number, current.seq) }
    this.disposers.push(port.on('agent/inbox/claimed', value => this.claimed(value)))
    this.disposers.push(port.on('session/event', (session, event) => this.event(session, event)))
    this.disposers.push(port.on('agent/status', value => {
      if (object(value) && value.agent === this.port.current() && value.status === 'idle') this.scheduleSettlement()
    }))
  }
  private turnId(agent: DshQueueAgent, turn: number, seq: unknown): string {
    return createHash('sha256').update(JSON.stringify([this.salt, agent.id, turn, seq])).digest().subarray(0, 16).toString('base64url')
  }
  private awaitIdle(agent: DshQueueAgent): void {
    if (this.waitingIdle === agent) return
    this.waitingIdle = agent
    void agent.whenIdle().then(() => {
      if (this.waitingIdle === agent) this.waitingIdle = null
      if (!this.closed && !this.fault && this.port.current() === agent) this.wake()
    }).catch(() => { this.fault = true })
  }
  private check(): void { if (this.closed || this.fault) throw Error('dsh_queue_driver_closed'); this.assertOwner() }
  private available(): boolean {
    try {
      this.check(); const a = this.port.current()
      return this.pending === null && (a === undefined || a.status === 'idle' && a.inbox.nextTurn.length === 0 && a.inbox.nextStep.length === 0)
    } catch { return false }
  }
  recover(): Promise<void> {
    if (this.recovering) return this.recovering
    this.recovering = this.recoverHistory().finally(() => { this.recovering = null })
    return this.recovering
  }
  private async recoverHistory(): Promise<void> {
    this.check()
    if (!this.available() || !this.port.recover) return
    const state = await this.queue.settledSnapshot(); this.check()
    for (const item of state.items.filter(i => i.state === 'unknown')) {
      if (!this.available()) return
      let content: QueueMessageContent | undefined
      if(readQueueBoundContent(item.body)!==null){
        if(!this.content)continue
        try { content=await this.content.retained(item,()=>this.check()) }
        catch { this.check();continue } // Missing original content is not positive proof; keep the item visible and unknown.
      }
      const hostRef = await this.port.recover(item,content,()=>this.check()); this.check()
      if (hostRef !== null) await this.queue.reconcile(item.id, item.dispatchId!, { state: 'completed', hostRef })
    }
    // No wake/resume: the original interruption/recovery pause is preserved.
  }
  runId(): string | null { this.check(); const turn = this.turn; return turn !== null && turn.agent === this.port.current() ? turn.id : null }
  wake(): void {
    if (this.closed || this.fault || this.scheduled) return
    this.scheduled = true
    setImmediate(() => { this.scheduled = false; if (!this.closed && !this.fault) void this.pump().catch(() => { this.fault = true }) })
  }
  pump(): Promise<void> {
    if (this.pumping) return this.pumping
    this.pumping = this.run().finally(() => { this.pumping = null })
    return this.pumping
  }
  private async run(): Promise<void> {
    this.check()
    if (!this.available()) return
    const before = this.queue.snapshot()
    if (before.paused !== 'none' || !before.items.some(v => v.state === 'waiting')
      || before.items.some(v => ['dispatching', 'submitted', 'unknown'].includes(v.state))) return
    let authority = (): void => {}, prepared: Awaited<ReturnType<DshQueuePort['prepare']>> | null = null
    await this.queue.dispatchNext(fresh(), () => { authority(); return this.available() }, async (claim, guard): Promise<QueueReceipt> => {
      if (!prepared) throw new QueueNativeNotEntered()
      const p: Pending = { claim, ...prepared, turn: null, entered: false, admitted: false, confirmed: false, removed: false, done: false, withdrawal: null }
      let acquired = false
      try {
        // runMaintenance synchronously acquires true idle, including maintenance
        // exclusion that public status='idle' alone cannot establish.
        await p.agent.runMaintenance(async signal => {
          acquired = true
          guard(); this.check(); authority(); signal.throwIfAborted()
          if (this.port.current() !== p.agent || p.agent.inbox.nextTurn.length || p.agent.inbox.nextStep.length) throw new QueueNativeNotEntered()
          this.pending = p
          p.entered = true // Any throw after entry may have committed a native splice.
          p.agent.followup(p.message)
        })
        if (p.withdrawal) await p.withdrawal
        return { state: 'submitted', hostRef: p.message.id }
      } catch (error) {
        if (!p.entered) {
          if (!acquired) this.awaitIdle(p.agent)
          if (this.pending === p) this.pending = null
          throw new QueueNativeNotEntered()
        }
        if (this.pending === p) this.pending = null
        throw error
      }
    }, async claim => {
      authority = await this.authorize(); authority(); this.check()
      const body: unknown = JSON.parse(claim.body)
      if(JSON.stringify(body)!==claim.body)throw Error('dsh_queue_body_invalid')
      if(object(body)&&Object.keys(body).join(',')==='text'){
        if(typeof body.text!=='string'||!body.text.trim()||body.text.includes('\0')||[...body.text].length>4000)throw Error('dsh_queue_text_invalid')
        prepared=await this.port.prepare(body.text,claim.dispatchId)
      }else{
        if(!this.content||!this.port.prepareContent)throw Error('dsh_queue_content_unavailable')
        const guard=()=>{authority();this.check();if(this.queue.userInterrupted())throw Error('dsh_queue_preparation_stopped')}
        prepared=await this.port.prepareContent(await this.content.dispatch(claim,guard),claim.dispatchId,guard)
      }
      authority(); this.check()
      if (prepared.agent !== this.port.current()) throw Error('dsh_queue_session_changed')
    })
    // No immediate retry after an admission refusal: a new explicit action or
    // later native idle transition is required, avoiding a maintenance busy loop.
  }
  private claimed(value: unknown): void {
    const p = this.pending
    if (this.closed || !p || p.done || !object(value) || value.agent !== p.agent || !object(value.message) || value.message.id !== p.message.id) return
    if (!Number.isSafeInteger(value.turn) || (value.turn as number) < 1 || JSON.stringify(value.message) !== JSON.stringify(p.message)
      || p.turn !== null || p.removed) { this.fault = true; return }
    p.turn = value.turn as number
    if (this.queue.userInterrupted() && this.turn?.agent === p.agent && this.turn.number === p.turn) this.port.cancel(p.agent)
  }
  private event(session: unknown, event: unknown): void {
    if (this.closed || !object(session) || !object(event) || !object(event.data)) return
    const a = this.port.current()
    if (!a || session !== a.session) return
    const observed = this.pending
    if (event.type === 'user/message' && observed?.agent === a && (event.data.id === observed.message.id
      || object(event.data.source) && event.data.source.rpcId === observed.claim.dispatchId)) {
      observed.admitted = true
      observed.confirmed = event.data.id === observed.message.id && event.data.role === 'user'
        && object(event.data.source) && event.data.source.kind === 'user' && event.data.source.rpcId === observed.claim.dispatchId
        && JSON.stringify(event.data.content) === JSON.stringify(observed.message.content)
    }
    if (!Number.isSafeInteger(event.data.turn) || (event.data.turn as number) < 1) return
    const n = event.data.turn as number
    if (event.type === 'turn/start') {
      this.turn = { agent: a, number: n, id: this.turnId(a, n, event.seq) }
    } else if (event.type === 'turn/end') {
      if (this.turn?.agent === a && this.turn.number === n) this.turn = null
      const p = this.pending
      if (p?.agent === a && p.turn === n && !p.done) {
        const reason = event.data.reason
        if (object(reason) && typeof reason.kind === 'string' && ['aborted', 'error'].includes(reason.kind)) void this.queue.pause().catch(() => { this.fault = true })
        p.done = true
        void this.queue.reconcile(p.claim.id, p.claim.dispatchId, { state: p.confirmed ? 'completed' : 'unknown', hostRef: p.message.id }).then(() => {
          if (this.pending === p) this.pending = null
          this.wake()
        }).catch(() => { this.fault = true })
      }
    }
  }
  private absent(p: Pending): boolean {
    if (this.port.current() !== p.agent || p.turn !== null || p.admitted || p.done || !p.removed) return false
    const owns = (v: unknown): boolean => object(v) && (v.id === p.message.id || object(v.source) && v.source.rpcId === p.claim.dispatchId)
    return ![...p.agent.inbox.nextTurn, ...p.agent.inbox.nextStep].some(owns)
  }
  private withdraw(p: Pending): Promise<unknown> | null {
    if (p.withdrawal) return p.withdrawal
    if (p.turn !== null || p.admitted || p.done || !p.entered || this.port.current() !== p.agent) return null
    const matches = [...p.agent.inbox.nextTurn, ...p.agent.inbox.nextStep].filter(v => object(v) && v.id === p.message.id)
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(p.message) || !p.agent.inbox.remove(p.message.id)) return null
    p.removed = true
    p.withdrawal = this.queue.withdrawBeforeAdmission(p.claim.id, p.claim.dispatchId, () => this.absent(p)).then(() => {
      p.done = true; if (this.pending === p) this.pending = null
    })
    return p.withdrawal
  }
  async stop(originalRunId: string | null, operation?: QueueOperationIdentity): Promise<'requested' | 'idle' | 'unconfirmed'> {
    this.check(); const paused = this.queue.pause(operation)
    const p = this.pending
    let withdrawn: Promise<unknown> | null = null
    let result: 'requested' | 'idle' | 'unconfirmed' = 'unconfirmed'
    try {
      withdrawn = p ? this.withdraw(p) : null
      const a = this.port.current(), turn = this.turn
      if (originalRunId !== null && turn?.id === originalRunId && a === turn.agent) {
        this.port.cancel(a); result = 'requested'
      } else if (a?.status === 'idle' && turn === null) result = 'idle'
    } finally { await paused; if (withdrawn) await withdrawn }
    return result
  }
  private scheduleSettlement(): void {
    setImmediate(() => {
      if (this.closed || this.fault) return
      const p = this.pending
      if (p && !p.done && p.agent.status === 'idle') {
        const withdrawn = this.withdraw(p)
        if (withdrawn) void withdrawn.catch(() => { this.fault = true })
      }
      this.wake()
    })
  }
  close(): void {
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    // A handed-off native input belongs to its exact session. Closing must not
    // stop a later desktop run or manufacture a completion/permission to replay.
    this.pending = null
  }
}
