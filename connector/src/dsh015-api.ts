import { randomUUID } from 'node:crypto'
import { readRuntimeDshVersion } from './runtime-version.js'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event'(session: { id: string }, event: unknown): void
    'agent/assistant-stream'(payload: { agent: { id: string }; frame: unknown }): void
  }
}

type RecordValue = Record<string, unknown>
interface RpcRequest { readonly rpcId: string; readonly payload: RecordValue }
interface Envelope { readonly rpcId: string; readonly payload: RecordValue }
interface Pending { readonly clientId: string; readonly envelope: Envelope; readonly kind: 'approval' | 'question' }
interface ConnectionPeer { readonly signal: AbortSignal; dispose(): Promise<void> }

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bounded, process-local fan-out; overflow disconnects instead of dropping decisions. */
class EventQueue {
  private readonly items: Envelope[] = []
  private wake?: () => void
  private closed = false
  push(value: Envelope): void {
    if (this.closed) return
    if (this.items.length >= 256) { this.close(); return }
    this.items.push(value)
    this.wake?.()
  }
  close(): void { this.closed = true; this.items.length = 0; this.wake?.() }
  async *read(signal: AbortSignal): AsyncIterable<Envelope> {
    const abort = () => this.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        const item = this.items.shift()
        if (item !== undefined) yield item
        else await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally { signal.removeEventListener('abort', abort); this.close() }
  }
}

/** Keep the shipped phone protocol independent from the DSH 0.1.5 Host API. */
export class Dsh015Api {
  private readonly lifetime = new AbortController()
  private readonly subscribers = new Set<EventQueue>()
  private readonly pending = new Map<string, Pending>()
  private readonly replying = new Set<string>()
  private readonly creating = new Set<string>()
  private readonly uncertainCreates = new Map<string, { workspaceId: string; agentPreset?: string; attachFailed: boolean }>()
  private releasing = 0
  private online = false
  private started = false
  private peer?: ConnectionPeer
  private peerDisposal?: Promise<void>
  private readonly disposeEvents: (() => void)[] = []

  constructor(
    private readonly ctx: Context,
    private readonly runtimeDshVersion = readRuntimeDshVersion(),
  ) {}

  private service(name: string): RecordValue {
    const value: unknown = this.ctx.get(name)
    if (!record(value)) throw new Error('DSH service unavailable')
    return value
  }

  private call(name: string, method: string, ...args: unknown[]): unknown {
    const owner = this.service(name)
    const fn = owner[method]
    if (typeof fn !== 'function') throw new Error('DSH method unavailable')
    return Reflect.apply(fn, owner, args)
  }

  private async response(request: RpcRequest, action: () => unknown): Promise<unknown> {
    try { return { rpcId: request.rpcId, result: { ok: true, value: await action() } } }
    catch (error) {
      const code = record(error) && typeof error.code === 'string' ? error.code : 'internal'
      // Retain both identities for an exact attachment recovery. No host paths.
      const details = code === 'session/workspace-attach-failed' && record(error) && record(error.details)
        && typeof error.details.sessionId === 'string' ? { sessionId: error.details.sessionId,
          ...(typeof error.details.workspaceId === 'string' ? { workspaceId: error.details.workspaceId } : {}) } : {}
      return { rpcId: request.rpcId, result: { ok: false, error: { code, message: 'DSH request failed', details } } }
    }
  }

  private async opening(service: string, args: unknown[]): Promise<RecordValue> {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 10_000)
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal])
    try {
      const stream = this.call(service, 'follow', ...args, signal) as AsyncIterable<unknown>
      for await (const frame of stream) {
        if (!record(frame)) throw new Error('Invalid DSH opening')
        return frame
      }
      throw new Error('DSH opening unavailable')
    } finally { clearTimeout(timeout); abort.abort() }
  }

  private async sessionOpening(sessionId: unknown): Promise<RecordValue> {
    return this.opening('sessionController', [{ address: { kind: 'session', sessionId }, maxMessages: 1 }])
  }

  private createFailure(code: string): Error {
    return Object.assign(new Error('Session creation needs confirmation'), { code })
  }

  /** Observe the exact identity without resuming a writer or changing its preset. */
  private async createdIdentity(sessionId: string): Promise<{ header: RecordValue; agentPreset?: string } | undefined> {
    const live = this.call('sessions', 'get', sessionId)
    if (record(live) && record(live.header)) {
      const preset = this.call('sessionProjections', 'stateOf', live, 'agentPreset')
      if (preset !== undefined && typeof preset !== 'string') throw this.createFailure('session/create-unconfirmed')
      return { header: live.header, ...(preset === undefined ? {} : { agentPreset: preset }) }
    }
    let observation: unknown
    try { observation = await this.call('sessionQuery', 'observeSession', sessionId) }
    catch (error) {
      if (record(error) && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
    try {
      if (!record(observation) || !record(observation.header) || !record(observation.projections)
        || !record(observation.projections.values)) throw this.createFailure('session/create-unconfirmed')
      const preset = observation.projections.values.agentPreset
      if (preset !== undefined && typeof preset !== 'string') throw this.createFailure('session/create-unconfirmed')
      return { header: observation.header, ...(preset === undefined ? {} : { agentPreset: preset }) }
    } finally {
      if (record(observation)) {
        const dispose: unknown = Reflect.get(observation, Symbol.dispose)
        if (typeof dispose === 'function') Reflect.apply(dispose, observation, [])
      }
    }
  }

  /** The host's generic create may mint a second ID on retry. Never replay it for an existing identity. */
  private async createMobileSession(payload: RecordValue): Promise<unknown> {
    const { sessionId, workspaceId, agentPreset } = payload
    if (typeof sessionId !== 'string' || !/^dshos-mobile-[A-Za-z0-9_-]{22}$/.test(sessionId)
      || typeof workspaceId !== 'string' || !workspaceId
      || (agentPreset !== undefined && typeof agentPreset !== 'string')) throw this.createFailure('gateway/bad-request')
    if (this.creating.has(sessionId)) throw this.createFailure('session/create-pending')
    const pending = this.uncertainCreates.get(sessionId)
    if (pending && (pending.workspaceId !== workspaceId || pending.agentPreset !== agentPreset)) {
      throw this.createFailure('session/create-conflict')
    }
    this.creating.add(sessionId)
    try {
      const workspace = this.call('workspaceRegistry', 'get', workspaceId)
      const archived = this.service('workspaceRegistry').archivedSessionIds
      if (!record(workspace) || typeof workspace.path !== 'string' || !Array.isArray(workspace.sessionIds)
        || !Array.isArray(archived) || archived.includes(sessionId)) throw this.createFailure('session/create-conflict')
      let identity = await this.createdIdentity(sessionId)
      if (identity === undefined) {
        // An earlier call with an unknown outcome is not permission to create again.
        if (pending || this.uncertainCreates.size >= 128 || this.lifetime.signal.aborted) throw this.createFailure('session/create-unconfirmed')
        const intent = { workspaceId, ...(agentPreset === undefined ? {} : { agentPreset }), attachFailed: false }
        this.uncertainCreates.set(sessionId, intent)
        try {
          const created = await this.call('sessionController', 'create', payload)
          if (!record(created) || created.sessionId !== sessionId) throw this.createFailure('session/create-unconfirmed')
        } catch (error) {
          if (record(error) && error.code === 'session/workspace-attach-failed' && record(error.details)
            && error.details.sessionId === sessionId && error.details.workspaceId === workspaceId) intent.attachFailed = true
          throw error
        }
        identity = await this.createdIdentity(sessionId)
      }
      if (identity === undefined || identity.header.id !== sessionId || identity.header.cwd !== workspace.path
        || identity.header.origin === 'subagent' || identity.header.parentSession !== undefined
        || (agentPreset !== undefined && identity.agentPreset !== agentPreset)) throw this.createFailure('session/create-conflict')
      if (!workspace.sessionIds.includes(sessionId)) {
        // Only an observed attachment failure for this exact operation can authorize repair.
        // After a restart, an unattached identity remains uncertain; it is never recreated/adopted.
        if (!pending?.attachFailed || this.lifetime.signal.aborted || typeof workspace.attachSession !== 'function') {
          throw this.createFailure('session/create-unconfirmed')
        }
        await Reflect.apply(workspace.attachSession, workspace, [sessionId])
      }
      const currentWorkspace = this.call('workspaceRegistry', 'get', workspaceId)
      const current = await this.createdIdentity(sessionId)
      if (this.lifetime.signal.aborted || !record(currentWorkspace) || currentWorkspace.path !== workspace.path
        || !Array.isArray(currentWorkspace.sessionIds) || !currentWorkspace.sessionIds.includes(sessionId)
        || (this.service('workspaceRegistry').archivedSessionIds as unknown[]).includes(sessionId)
        || current === undefined || current.header.id !== sessionId || current.header.cwd !== workspace.path || current.header.origin === 'subagent'
        || current.header.parentSession !== undefined || (agentPreset !== undefined && current.agentPreset !== agentPreset)) {
        throw this.createFailure('session/create-conflict')
      }
      this.uncertainCreates.delete(sessionId)
      return { sessionId, workspaceId, ...(current.agentPreset === undefined ? {} : { agentPreset: current.agentPreset }) }
    } finally { this.creating.delete(sessionId) }
  }

  readonly sessions = {
    list: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'list', {}, this.lifetime.signal)),
    create: (r: RpcRequest) => this.response(r, () => this.createMobileSession(r.payload)),
    presets: (r: RpcRequest) => this.response(r, () => {
      // Older hosts have no roster; never invent modes that the host cannot run.
      if (this.ctx.get('agentPresets') === undefined) return { presets: [] }
      return this.call('agentPresets', 'remoteExportList')
    }),
    rename: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'rename', r.payload)),
    fork: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'fork', r.payload)),
    prompt: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'prompt', {
      ...r.payload, requestId: r.rpcId,
    }, this.lifetime.signal)),
    cancel: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'cancel', r.payload)),
    attachment: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'attachment', r.payload)),
    selectModel: (r: RpcRequest) => this.response(r, () => this.call('sessionController', 'selectModel', r.payload)),
    history: (r: RpcRequest) => this.response(r, async () => {
      const frame = await this.sessionOpening(r.payload.sessionId)
      if (frame.type !== 'snapshot' || !record(frame.projections)) throw new Error('Invalid DSH projections')
      // This adapter is consumed only by the bounded token-usage reader.
      return { events: [], hasMore: false, projections: frame.projections }
    }),
    newSessionModels: (r: RpcRequest) => this.response(r, async () => {
      // Discover the host defaults without opening or creating a conversation.
      const catalog = await this.call('sessionController', 'modelCatalog')
      if (this.lifetime.signal.aborted || !record(catalog) || !record(catalog.default)
        || !Array.isArray(catalog.routableProviders)) throw new Error('Invalid DSH model catalog')
      return { current: catalog.default, routable: catalog.routableProviders.includes(catalog.default.provider),
        groups: catalog.groups, failures: catalog.failures }
    }),
    models: (r: RpcRequest) => this.response(r, async () => {
      const catalog = await this.call('sessionController', 'modelCatalog')
      const frame = await this.sessionOpening(r.payload.sessionId)
      if (!record(catalog) || !record(frame.projections) || !record(frame.projections.values)
        || !Array.isArray(catalog.routableProviders)) throw new Error('Invalid DSH model catalog')
      const selection = frame.projections.values.modelSelection
      const current = record(selection) && record(selection.next) ? selection.next : catalog.default
      if (!record(current)) throw new Error('Invalid DSH current model')
      return { current, routable: catalog.routableProviders.includes(current.provider), groups: catalog.groups, failures: catalog.failures }
    }),
  }

  readonly workspace = {
    rename: (r: RpcRequest) => this.response(r, () => this.call('workspaceController', 'rename', r.payload)),
    delete: (r: RpcRequest) => this.response(r, () => this.call('workspaceController', 'delete', r.payload)),
    pinSession: (r: RpcRequest) => this.response(r, () => this.call('workspaceController', 'pinSession', r.payload)),
    unpinSession: (r: RpcRequest) => this.response(r, () => this.call('workspaceController', 'unpinSession', r.payload)),
    archiveSession: (r: RpcRequest) => this.response(r, () => this.call('workspaceController', 'archiveSession', r.payload)),
    unarchiveSession: (r: RpcRequest) => this.response(r, () => this.call('workspaceController', 'unarchiveSession', r.payload)),
    list: (r: RpcRequest) => this.response(r, async () => {
      const frame = await this.opening('workspaceController', [])
      if (frame.type !== 'baseline' || !record(frame.value) || !Array.isArray(frame.value.items)) {
        throw new Error('Invalid DSH workspace baseline')
      }
      // Keep the host's full workspace projection, including pin/archive sets.
      // Dropping those fields makes the authenticated desktop directory unavailable.
      return frame.value
    }),
  }

  private publish(payload: RecordValue, rpcId: string = randomUUID()): void {
    const envelope = { rpcId, payload }
    for (const queue of this.subscribers) queue.push(envelope)
  }

  readonly events = {
    mux: (_request: RpcRequest, signal: AbortSignal): AsyncIterable<Envelope> => {
      const queue = new EventQueue()
      if (!this.online || this.subscribers.size >= 3) queue.close()
      else {
        this.subscribers.add(queue)
        for (const pending of this.pending.values()) queue.push(pending.envelope)
      }
      const subscribers = this.subscribers
      return (async function* () {
        try { yield* queue.read(signal) }
        finally { subscribers.delete(queue) }
      })()
    },
  }

  private async result(clientId: string, eventId: string, outcome: RecordValue): Promise<void> {
    const handler = this.call('connection', 'createSharedFetchHandler', '/api') as { fetch(request: Request, peer?: ConnectionPeer): Promise<Response> }
    const rpcId = randomUUID()
    // In-process registered carrier: no loopback HTTP, browser cookies or credentials.
    const response = await handler.fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: this.lifetime.signal,
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: { clientId, eventId, outcome } } }),
    }), this.peer)
    const receipt: unknown = await response.json()
    if (!response.ok || !record(receipt) || receipt.rpcId !== rpcId || !record(receipt.result) || receipt.result.ok !== true) {
      throw new Error('DSH decision unavailable')
    }
  }

  async respond(value: unknown): Promise<unknown> {
    if (!record(value) || typeof value.rpcId !== 'string' || !record(value.result)) return { accepted: false, reason: 'invalid' }
    const eventId = value.rpcId
    const pending = this.pending.get(eventId)
    if (pending === undefined || this.replying.has(eventId)) return { accepted: false, reason: 'not-pending' }
    const body = value.result.value
    let outcome: RecordValue
    if (pending.kind === 'approval') {
      if (value.result.ok !== true || !record(body) || body.sessionId !== pending.envelope.payload.sessionId
        || body.approvalId !== eventId || (body.outcome !== 'allowed-once' && body.outcome !== 'rejected')) {
        return { accepted: false, reason: 'invalid' }
      }
      outcome = { kind: 'result', value: body.outcome }
    } else if (value.result.ok === false && record(value.result.error) && value.result.error.code === 'cancelled') {
      outcome = { kind: 'rejected', error: { name: 'AbortError', message: 'User cancelled the question', code: 'cancelled' } }
    } else {
      if (value.result.ok !== true || !record(body) || body.sessionId !== pending.envelope.payload.sessionId || !record(body.answer)) {
        return { accepted: false, reason: 'invalid' }
      }
      outcome = { kind: 'result', value: body.answer }
    }
    this.replying.add(eventId)
    try {
      await this.result(pending.clientId, eventId, outcome)
      // The pinned in-process Gateway queues cancellation before acknowledging a
      // losing RPC. Drain its buffered stream through the microtask checkpoint;
      // consume() must never await another RPC ahead of that cancellation.
      await new Promise<void>(resolve => setImmediate(resolve))
      if (this.pending.get(eventId) !== pending) return { accepted: false, reason: 'not-pending' }
      this.removePending(eventId)
      return { accepted: true }
    } finally { this.replying.delete(eventId) }
  }

  private removePending(eventId: string): void {
    const pending = this.pending.get(eventId)
    if (pending === undefined) return
    this.pending.delete(eventId)
    const sessionId = pending.envelope.payload.sessionId
    this.publish(pending.kind === 'approval'
      ? { type: 'approval/resolved', sessionId, approvalId: eventId, outcome: 'cancelled' }
      : { type: 'question/resolved', sessionId, questionRpcId: eventId, outcome: 'cancelled' })
  }

  async start(): Promise<void> {
    if (this.started || this.lifetime.signal.aborted) throw new Error('DSH event carrier already started or disposed')
    this.started = true
    try { await this.startCarrier() }
    catch (error) { await this.dispose().catch(() => undefined); throw error }
  }

  private async startCarrier(): Promise<void> {
    const gateway = this.service('typertGateway')
    if (!record(gateway.wireStream) || typeof gateway.wireStream.open !== 'function') throw new Error('DSH event carrier unavailable')
    const peerCarrier = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2'].includes(this.runtimeDshVersion)
    if (peerCarrier) {
      // The authenticated phone routes remain the admission boundary. This
      // dedicated in-process Peer belongs only to this bridge, never a browser
      // session, and is shared by its event stream and decision receipts.
      const peer = this.call('connection', 'createPeer', { principal: { kind: 'owner' }, interactions: 'answer' })
      if (!record(peer) || !(peer.signal instanceof AbortSignal) || typeof peer.dispose !== 'function') {
        throw new Error('DSH connection identity unavailable')
      }
      this.peer = peer as unknown as ConnectionPeer
      if (this.peer.signal.aborted) throw new Error('DSH connection identity disposed')
    }
    const stream = await (peerCarrier || ['0.1.7-alpha.2', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2'].includes(this.runtimeDshVersion)
      ? gateway.wireStream.open('$events', { args: {} }, (async function* () {})(), this.peer, this.lifetime.signal)
      : gateway.wireStream.open('$events', { args: {} }, this.lifetime.signal)) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (this.lifetime.signal.aborted || !record(first.value) || first.value.type !== 'ready' || typeof first.value.clientId !== 'string') {
      await iterator.return?.()
      throw new Error('DSH event carrier not ready')
    }
    const clientId = first.value.clientId
    this.online = true
    this.disposeEvents.push(this.ctx.on('session/event', (session: { id: string }, event: unknown) => {
      this.publish({ type: 'session/event', sessionId: session.id, event })
    }))
    this.disposeEvents.push(this.ctx.on('agent/assistant-stream', (payload: { agent: { id: string }; frame: unknown }) => {
      this.publish({ type: 'session/assistant-stream', sessionId: payload.agent.id, frame: payload.frame })
    }))
    void this.consume(iterator, clientId).catch(() => this.dispose())
  }

  private async consume(iterator: AsyncIterator<unknown>, clientId: string): Promise<void> {
    try {
      while (!this.lifetime.signal.aborted) {
        const next = await iterator.next()
        if (next.done) return
        const frame = next.value
        if (!record(frame)) throw new Error('Invalid DSH event')
        if (frame.type === 'cancel' && typeof frame.eventId === 'string') this.removePending(frame.eventId)
        if (frame.type !== 'waterfall') continue
        if (typeof frame.eventId !== 'string' || typeof frame.agentId !== 'string' || !record(frame.request)) throw new Error('Invalid DSH request')
        const kind = frame.event === 'approval/request' ? 'approval' : frame.event === 'user-questions/request' ? 'question' : undefined
        if (kind === undefined || this.pending.size >= 100) {
          if (this.releasing >= 100) throw new Error('DSH event release overflow')
          this.releasing++
          void this.result(clientId, frame.eventId, { kind: 'next' })
            .catch(() => this.dispose()).finally(() => { this.releasing-- })
          continue
        }
        const payload: RecordValue = kind === 'approval'
          ? { type: 'approval/requested', sessionId: frame.agentId, approvalId: frame.eventId,
            toolName: frame.request.toolName,
            ...(frame.request.callId === undefined ? {} : { callId: frame.request.callId }),
            ...(frame.request.reason === undefined ? {} : { reason: frame.request.reason }) }
          : { type: 'question/requested', sessionId: frame.agentId, questions: frame.request.questions }
        const envelope = { rpcId: frame.eventId, payload }
        this.pending.set(frame.eventId, { clientId, envelope, kind })
        this.publish(payload, frame.eventId)
      }
    } finally { await this.dispose(); await iterator.return?.() }
  }

  dispose(): Promise<void> {
    this.online = false
    this.lifetime.abort()
    for (const dispose of this.disposeEvents.splice(0)) dispose()
    for (const queue of this.subscribers) queue.close()
    this.subscribers.clear()
    this.pending.clear()
    if (this.peerDisposal === undefined) this.peerDisposal = this.peer?.dispose() ?? Promise.resolve()
    return this.peerDisposal
  }
}
