import {emptyEntry,observeEntryEvent,validEntry,type EntryEvent,type PairingEntryObservation} from './pairing-entry-observation.js'
import { randomBytes } from 'node:crypto'
import { cloudSign } from './cloud-pairing-contract.js'
import { registrationPrivateKey } from './dsh-registration-contract.js'
import { CLOUD_DIAGNOSTIC_STAGES, CLOUD_DIAGNOSTIC_REASONS, CLOUD_OPERATIONS, validCloudDiagnosticBody,
  type CloudDiagnosticBody, type CloudDiagnosticPacket, type CloudDiagnosticStep } from './cloud-pairing-diagnostic.js'

export function cloudFailureReason(error:unknown,depth=0):string {
  if(depth>3)return 'unknown'
  if(error instanceof AggregateError&&error.errors.length)return cloudFailureReason(error.errors[0],depth+1)
  const e=error as {reason?:unknown;message?:unknown;code?:unknown;status?:unknown;name?:unknown;cause?:unknown}|null
  const reason=typeof e?.reason==='string'?e.reason:typeof e?.message==='string'?e.message:''
  if(['cloud_pairing_relay_root_conflict','cloud_pairing_relay_root_unauthorized',
    'cloud_pairing_relay_credential_unauthorized','cloud_pairing_relay_key_changed'].includes(reason))return 'identity_conflict'
  if(['relay_bootstrap_invalid','relay_bootstrap_key_invalid','cloud_pairing_relay_key_invalid',
    'cloud_pairing_relay_payload_invalid'].includes(reason))return 'proof'
  if(reason==='registration_busy'||reason==='cloud_pairing_storage_busy')return 'storage_busy'
  if(['registration_windows','registration_lock_lost','registration_format','registration_file','registration_guard','registration_reparse','registration_path'].includes(reason))return 'storage'
  if(/(?:timeout|timed_out|response_expired|ETIMEDOUT)/i.test(reason)||e?.code==='ETIMEDOUT')return 'timeout'
  if(e?.status===429||reason==='rate_limited')return 'rate_limited'
  if(e?.status===401||/login|account_changed|session/.test(reason))return 'login'
  if(/identity|binding_changed|binding_mismatch|computer_mismatch|registry_scope|source_changed/.test(reason))return 'identity_conflict'
  if(/proof|signature|manifest|revision_conflict|challenge_scope/.test(reason))return 'proof'
  if(/stor|file|disk|vault|protected|key_missing|unsafe|directory/.test(reason)||['ENOSPC','EACCES','EPERM','EIO','EROFS','EMFILE','ENFILE'].includes(String(e?.code)))return 'storage'
  if(/code_unavailable|invalid_code/.test(reason))return 'invalid_code'
  if(/expired|attempt_ended/.test(reason))return 'expired'
  if(e?.name==='AbortError'||e?.code==='ABORT_ERR')return 'cancelled'
  if(/cancel|closed|context_ended/.test(reason))return 'cancelled'
  if(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(String(e?.code)))return 'tls'
  if(['ECONNRESET','ECONNREFUSED','EPIPE','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH'].includes(String(e?.code)))return 'network'
  if(typeof e?.status==='number'&&e.status>=500)return 'service'
  if(/unavailable|pending/.test(reason))return 'unavailable'
  return e?.cause?cloudFailureReason(e.cause,depth+1):'unknown'
}

/** Never copy an exception message or remote address into diagnostic fields. */
export function cloudTransportCause(error:unknown,depth=0):CloudDiagnosticStep['transport'] {
  if(depth>3)return 'unknown'
  if(error instanceof AggregateError&&error.errors.length)return cloudTransportCause(error.errors[0],depth+1)
  const e=error as {code?:unknown;name?:unknown;message?:unknown;cause?:unknown}|null
  const code=String(e?.code??'')
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'dns'
  if(code==='ECONNREFUSED')return 'connection_refused'
  if(code==='ECONNRESET'||code==='EPIPE')return 'connection_reset'
  if(['ENETUNREACH','EHOSTUNREACH'].includes(code))return 'network_unreachable'
  if(code==='ETIMEDOUT'||['cloud_pairing_timeout','cloud_pairing_response_expired'].includes(String(e?.message)))return 'timeout'
  if(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code))return 'tls_certificate'
  if(/TLS|SSL/.test(code))return 'tls_protocol'
  if(e?.name==='AbortError'||code==='ABORT_ERR')return 'cancelled'
  return e?.cause?cloudTransportCause(e.cause,depth+1):'unknown'
}

/** Fixed categories only; exception messages, paths and process output never
 * enter a report. This observes failures without changing storage protections. */
export function cloudStorageCause(error:unknown,depth=0):CloudDiagnosticStep['cause'] {
  if(depth>3)return 'unknown'
  if(error instanceof AggregateError&&error.errors.length)return cloudStorageCause(error.errors[0],depth+1)
  const e=error as {reason?:unknown;message?:unknown;code?:unknown;cause?:unknown}|null
  const reason=typeof e?.reason==='string'?e.reason:e?.message
  if(reason==='registration_busy'||reason==='cloud_pairing_storage_busy')return 'busy'
  if(reason==='registration_lock_lost')return 'lock_lost'
  if(['registration_format','registration_file','registration_capacity'].includes(String(reason)))return 'record_invalid'
  if(['registration_guard','registration_reparse','registration_path','cloud_pairing_unsafe_legacy_path'].includes(String(reason)))return 'unsafe_path'
  if(e?.code==='DSH_PROTECTION_FAILED')return 'protection_failed'
  if(['EACCES','EPERM'].includes(String(e?.code)))return 'access_denied'
  if(e?.code==='ENOSPC')return 'disk_full'
  if(['EIO','EROFS','EMFILE','ENFILE'].includes(String(e?.code)))return 'io_failed'
  if(reason==='cloud_pairing_storage_unavailable')return 'unavailable'
  return e?.cause?cloudStorageCause(e.cause,depth+1):'unknown'
}

/** Bounded local observations; never copies exception messages, short codes,
 * addresses, names, tokens or requests into feedback. */
export class CloudPairingProgress {
  private entry:PairingEntryObservation=emptyEntry()
  observeUI(event:EntryEvent):boolean{return observeEntryEvent(this.entry,event)}
  replaceUI(entry:PairingEntryObservation):void{if(validEntry(entry))this.entry={...entry}}
  private start:number
  private readonly monoStart:number
  private id=randomBytes(16).toString('base64url')
  private carriedElapsed=0
  private readonly steps:CloudDiagnosticStep[]=[]
  private first:CloudDiagnosticStep|null=null
  private last:CloudDiagnosticStep|null=null
  constructor(private readonly version:string,private readonly environment:'PRODUCTION'|'SANDBOX',
    private readonly now=Date.now,private readonly monotonic=()=>performance.now()){
    this.start=now();this.monoStart=monotonic()
  }
  restore(body:CloudDiagnosticBody):void{
    if(!validCloudDiagnosticBody(body)||body.role!=='desktop'||body.environment!==this.environment)throw Error('cloud_pairing_diagnostic_invalid')
    this.entry=body.entry?{...body.entry}:emptyEntry()
    this.start=body.startedAtMs;this.id=body.operationId
    this.carriedElapsed=Math.min(86400000,Math.max(body.elapsedMs,this.now()-body.startedAtMs))
    this.steps.splice(0,this.steps.length,...body.steps.map(s=>({...s})))
    this.first=body.firstFailure?{...body.firstFailure}:null;this.last=body.lastFailure?{...body.lastFailure}:null
  }
  private elapsed():number{return Math.max(0,Math.min(86400000,Math.floor(this.carriedElapsed+this.monotonic()-this.monoStart)))}
  /** At least once in this diagnostic stream; polling and restored views do not
   * create new interaction counts or replace the first observation time. */
  observeEntry(stage:'entry_ready'|'claim_submit'):void {
    if(this.steps.some(s=>s.stage===stage&&s.outcome==='completed'))return
    this.observe(stage,'completed')
  }
  observe(stage:string,outcome:'started'|'completed'|'failed'|'unknown',error?:unknown,operation?:CloudDiagnosticStep['operation']):void {
    if(!CLOUD_DIAGNOSTIC_STAGES.includes(stage as typeof CLOUD_DIAGNOSTIC_STAGES[number]))return
    const elapsed=this.elapsed()
    const old=this.steps.find(s=>s.stage===stage)
    const reason=['started','completed'].includes(outcome)?'none':cloudFailureReason(error)
    if(!CLOUD_DIAGNOSTIC_REASONS.includes(reason as typeof CLOUD_DIAGNOSTIC_REASONS[number]))return
    const failed=outcome==='failed'||outcome==='unknown'
    const step:CloudDiagnosticStep={stage,outcome,reason,
      ...(failed&&operation&&CLOUD_OPERATIONS.includes(operation)?{operation}:{}),
      ...(failed&&['network','tls','timeout','cancelled'].includes(reason)?{transport:cloudTransportCause(error)}:{}),
      ...(['storage','storage_busy'].includes(reason)?{cause:cloudStorageCause(error)}:{}),
      elapsedMs:elapsed,attempts:Math.min(1000,(old?.attempts??0)+(outcome==='started'||!old?1:0))}
    if(old)this.steps[this.steps.indexOf(old)]=step;else this.steps.push(step)
    if(outcome==='failed'||outcome==='unknown'){this.first??={...step};this.last={...step}}
  }
  packet(source:{attemptId:string;claimId:string;revision:number;state:string;publicKey:string;privateKey:string}):CloudDiagnosticPacket {
    const body=this.body(source)
    return {body,publicKey:source.publicKey,signature:cloudSign('DIAGNOSTIC',body,registrationPrivateKey(source.privateKey,source.publicKey))}
  }
  body(source:{attemptId:string;claimId:string;revision:number;state:string}={attemptId:'',claimId:'',revision:0,state:'unknown'}):CloudDiagnosticBody{
    const body:CloudDiagnosticBody={contract:'dshos-cloud-pairing-diagnostic-v4',entry:{...this.entry},product:'harmony-dsh',environment:this.environment,
      role:'desktop',operationId:this.id,attemptId:source.attemptId,claimId:source.claimId,version:this.version,startedAtMs:this.start,
      elapsedMs:this.elapsed(),revision:source.revision,state:source.state,
      steps:this.steps.map(s=>({...s})),firstFailure:this.first?{...this.first}:null,lastFailure:this.last?{...this.last}:null}
    // Preserve the existing size ceiling. Prefer first/last failure detail if
    // an unusually long trace has no room for every repeated storage cause.
    if(Buffer.byteLength(JSON.stringify(body))>6144)for(const step of body.steps){delete step.cause;delete step.operation;delete step.transport}
    if(!validCloudDiagnosticBody(body))throw Error('cloud_pairing_diagnostic_invalid')
    return body
  }
}
