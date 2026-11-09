import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { registrationPrivateKey } from './dsh-registration-contract.js'
import { observationError, type ObservationHandle, type ObservationIdentity, type ObservationOutcome } from './pairing-observations.js'
import { traceCause, TRACE_CAUSES, type TraceCause } from './pairing-trace-detail.js'
import type { RegistrationReadEvent } from './registration-operation.js'
import { supportTranscript, type SupportObservationBody, type SupportError, type SupportStage } from './pairing-support-contract.js'
import { DETAILED_TRACE_CONTRACT, TRACE_DOMAIN, TRACE_STAGES, pairingInvitationRef, type PairingTrace, type TraceStage, type PreparationStage,
  type TraceObservationBody, type TraceObservationPacket } from './pairing-trace-contract.js'

export class PairingSupportObservation implements ObservationHandle {
  readonly attemptId = randomBytes(16).toString('base64url')
  private identity?: { publicKey: string; key: KeyObject; type: 'member' | 'temporary' }
  private seen = 0
  private sequence = 0
  private reportsSent = 0
  private outcome: SupportObservationBody['outcome'] = 'open'
  private error: SupportError = 'none'
  private errorStage: SupportStage = 'none'
  private mode: SupportObservationBody['mode'] = 'unknown'
  private readonly start: number
  private timer?: ReturnType<typeof setTimeout>
  private errorsSent = 0
  private packet?: TraceObservationPacket
  private packetState?: string
  private sessionId?: string
  private storageStarted = 0
  private readonly trace: PairingTrace
  constructor(private readonly pluginVersion: string, private readonly enqueue: (packet: TraceObservationPacket) => void,
    private readonly startedAtMs = Date.now(), private readonly mono = () => performance.now(),
    origin?: { operationId: string; parentAttemptId: string }) {
    this.start = mono()
    this.trace = { operationId: origin?.operationId ?? this.attemptId, parentAttemptId: origin?.parentAttemptId ?? '',
      trigger: origin ? 'refresh' : 'user', invitationRef: '', display: 'unknown', address: 'unknown', listenerSignals: 0,
      lastSuccess: 'none', blockingStage: 'none', blockingError: 'none', recoveredErrors: 0, timings: [],
      detail: {first:null,events:[],omitted:0,storage:null,reads:0,decryptions:0,reused:0} }
  }
  get preparing(): boolean { return !this.identity }
  private temporary(): void {
    if (this.identity) return
    const key = generateKeyPairSync('ed25519')
    this.identity = { publicKey: key.publicKey.export({ format: 'jwk' }).x!, key: key.privateKey, type: 'temporary' }
  }
  generated(identity: ObservationIdentity & { sessionId?: string; address?: PairingTrace['address'] }): void {
    if (this.identity || this.outcome !== 'open') return
    this.identity = { publicKey: identity.publicKey, key: registrationPrivateKey(identity.privateKey, identity.publicKey), type: 'member' }
    this.mode = identity.mode; this.seen = 1; this.sessionId = identity.sessionId
    if (identity.sessionId) this.trace.invitationRef = pairingInvitationRef(identity.sessionId,identity.publicKey)
    this.trace.address = identity.address ?? 'unknown'
    this.succeeded('preparation')
    this.timer = setTimeout(() => this.end('expired'), 300000); this.timer.unref()
    this.emit()
  }
  preparationPassed(stage: PreparationStage): void {
    if (!this.identity && this.outcome === 'open') this.succeeded(stage)
  }
  preparationFailed(error: SupportError, stage: SupportStage = 'preparation', address: PairingTrace['address'] = 'unknown',
    preparationStage?: PreparationStage, cause?: unknown): void {
    if (this.identity) return
    this.temporary(); this.outcome = 'failed'; this.error = error === 'none' ? 'other' : error; this.errorStage = stage
    this.trace.blockingStage = preparationStage ?? stage; this.trace.blockingError = this.error
    this.trace.address = address
    if(error==='timeout'&&this.trace.detail!.storage?.[4]==='pending') {
      const s=this.trace.detail!.storage!;s[2]=Math.min(600000,Math.max(0,Math.floor(this.mono()-this.storageStarted)));s[3]=0;s[4]='failed';s[5]='deadline_or_cancel'
    }
    this.failed(this.trace.blockingStage,this.error,traceCause(cause))
    this.emit()
  }
  manualSnapshot(unavailable: boolean): void {
    if (this.identity) return
    this.temporary();this.outcome='not_started'
    if(unavailable){this.error='unavailable';this.errorStage='startup';this.trace.blockingStage='startup';this.trace.blockingError='unavailable'}
    this.emit()
  }
  attachManualIdentity(identity: Pick<ObservationIdentity,'publicKey'|'privateKey'>): void {
    if (this.outcome !== 'not_started' || this.seen !== 0 || this.identity?.type !== 'temporary')
      throw Error('support_identity_changed')
    const key = registrationPrivateKey(identity.privateKey,identity.publicKey)
    this.identity = { publicKey:identity.publicKey,key,type:'member' }
    this.mode = 'resume'
    // This is a manual report, not a generated invitation or automatic event.
  }
  requestReceived(): void {
    if (!this.identity || this.outcome !== 'open' || !(this.seen & 1) || (this.seen & 64)) return
    this.seen |= 64; this.emit()
  }
  phase(bit: 2 | 4 | 8 | 16 | 32): void {
    if (!this.identity || this.outcome === 'connected' || this.outcome !== 'open' && bit !== 32) return
    if (bit === 2 && !(this.seen & 1) || bit !== 2 && !(this.seen & 2)
      || bit === 16 && (this.seen & 15) !== 15 || bit === 32 && (this.seen & 31) !== 31) return
    const resolves: Record<number,TraceStage[]> = {2:['request_validation','phone_start'],4:['computer_confirmation'],
      8:['phone_confirmation'],16:['registration','activation'],32:['authentication']}
    const repeated = !!(this.seen & bit)
    if (repeated && !resolves[bit]!.includes(this.trace.blockingStage)) return
    if (bit === 2) this.seen |= 64
    this.seen |= bit
    const stages: Record<number,TraceStage> = {2:'phone_start',4:'computer_confirmation',8:'phone_confirmation',16:'activation',32:'authentication'}
    // A repeated successful stage matters only after a reported blocker. Ordinary
    // polling still emits nothing; retries no longer leave a recovered error stuck.
    this.succeeded(stages[bit]!)
    if (bit === 32 || resolves[bit]!.includes(this.trace.blockingStage)) this.recovered()
    if (bit === 32) { this.outcome = 'connected'; clearTimeout(this.timer) }
    // Repeated recovery must not consume the slots reserved for terminal milestones.
    this.emit(!repeated)
  }
  failureDetail(error: unknown, stage: SupportStage): void { this.failure(observationError(error),stage,traceCause(error)) }
  failure(error: SupportError, stage: SupportStage = 'request_validation', cause: TraceCause = 'unknown'): void {
    cause = TRACE_CAUSES.includes(cause) && cause !== 'none' ? cause : 'unknown'
    if (!this.identity || this.outcome !== 'open' || error === 'none'
      || error === this.trace.blockingError && stage === this.trace.blockingStage
        && this.trace.detail!.events.at(-1)?.[3] === cause) return
    if(error==='expired'&&this.trace.blockingStage!=='none')return
    this.error = error; this.errorStage = stage
    this.trace.blockingStage = stage; this.trace.blockingError = error
    this.failed(stage,error,cause)
    if (this.errorsSent++ < 16) this.emit(false)
  }
  end(outcome: Exclude<ObservationOutcome, 'open' | 'connected'>): void {
    if (this.outcome !== 'open') return
    this.temporary(); this.outcome = outcome; clearTimeout(this.timer); this.emit()
  }
  private elapsed(): number { return Math.max(0, Math.min(600000, Math.floor(this.mono() - this.start))) }
  private succeeded(stage: TraceStage): void {
    this.event(stage,'ok','none')
    if (!this.trace.timings.some(item=>item[0]===stage)) this.trace.timings.push([stage,this.elapsed()])
    if(TRACE_STAGES.indexOf(stage)>TRACE_STAGES.indexOf(this.trace.lastSuccess))this.trace.lastSuccess = stage
  }
  private event(stage: TraceStage, result: 'ok'|'failed', cause: TraceCause): void {
    const d=this.trace.detail!, last=d.events.at(-1)
    if(last&&last[1]===stage&&last[2]===result&&last[3]===cause)return
    d.events.push([d.omitted+d.events.length+1,stage,result,cause,this.elapsed()])
    if(d.events.length>8){d.events.shift();d.omitted++}
  }
  private failed(stage:TraceStage,error:SupportError,cause:TraceCause):void {
    this.trace.detail!.first??=[stage,error,cause,this.elapsed()]
    this.event(stage,'failed',cause)
  }
  storageEvent(event:RegistrationReadEvent):void {
    if(this.outcome!=='open')return
    const d=this.trace.detail!
    if(event.result==='ok'&&event.step==='read')d.reads=Math.min(65535,d.reads+1)
    if(event.result==='ok'&&event.step==='decrypt')d.decryptions=Math.min(65535,d.decryptions+1)
    if(event.result==='cached')d.reused=Math.min(65535,d.reused+1)
    if(d.storage?.[4]==='failed')return
    if(event.result==='pending')this.storageStarted=this.mono()
    d.storage=[event.record,event.step,Math.min(600000,event.milliseconds),Math.min(8000,event.remaining),event.result,
      TRACE_CAUSES.includes(event.cause as TraceCause)?event.cause as TraceCause:'unknown']
  }
  private recovered(): void {
    if (this.trace.blockingStage!=='none') this.trace.recoveredErrors=Math.min(32,this.trace.recoveredErrors+1)
    this.trace.blockingStage='none';this.trace.blockingError='none'
  }
  display(sessionId: string, shown: boolean): void {
    if (this.outcome!=='open' || sessionId!==this.sessionId || this.trace.display==='shown'
      || this.trace.display===(shown?'shown':'failed')) return
    this.trace.display=shown?'shown':'failed'
    if(shown) { this.succeeded('qr_display');if(this.trace.blockingStage==='qr_display')this.recovered() }
    else { this.trace.blockingStage='qr_display';this.trace.blockingError='unavailable';this.failed('qr_display','unavailable','unknown') }
    this.emit(false)
  }
  listener(signals: number): void {
    if(this.outcome!=='open'||!Number.isInteger(signals)||signals<0||signals>255) return
    const next=this.trace.listenerSignals|signals
    if(next===this.trace.listenerSignals)return
    this.trace.listenerSignals=next;this.emit(false)
  }
  refreshOrigin(): { operationId: string; parentAttemptId: string } {
    return { operationId:this.trace.operationId,parentAttemptId:this.attemptId }
  }
  private emit(essential = true): void {
    if (!this.identity || this.reportsSent >= (essential ? 48 : 40)) return
    try {
      const packet = this.capture()
      this.reportsSent++
      this.enqueue(structuredClone(packet))
    } catch { /* Diagnostics never affect pairing. */ }
  }
  private capture(): TraceObservationPacket {
    if (!this.identity) throw Error('support_preparing')
    const body: TraceObservationBody = { contract: DETAILED_TRACE_CONTRACT, attemptId: this.attemptId,
      publicKey: this.identity.publicKey, identityType: this.identity.type, sequence: this.sequence + 1, seen: this.seen,
      outcome: this.outcome, error: this.error, errorStage: this.errorStage,
      elapsedMs: this.elapsed(), mode: this.mode,
      pluginVersion: this.pluginVersion, startedAtMs: this.startedAtMs, trace: structuredClone(this.trace) }
    // A manual preview must capture current facts even when automatic uploads are
    // capped. Its revision is independent of the network budget, and unchanged
    // reads reuse the exact signed packet instead of consuming new revisions.
    const state = JSON.stringify({ ...body, sequence: 0, elapsedMs: 0 })
    if (this.packet && this.packetState === state) return this.packet
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw Error('support_snapshot_limit')
    this.packet = { body, signature: this.sign(TRACE_DOMAIN, body) }
    this.sequence = body.sequence
    this.packetState = state
    return this.packet
  }
  snapshot(): TraceObservationPacket {
    // Callers can freeze a preview without retaining a mutable live object.
    return structuredClone(this.capture())
  }
  sign(domain: string, value: unknown): string {
    if (!this.identity) throw Error('support_preparing')
    return sign(null, supportTranscript(domain, value), this.identity.key).toString('base64url')
  }
}
