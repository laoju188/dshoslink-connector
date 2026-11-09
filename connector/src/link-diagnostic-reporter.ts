import {randomBytes,sign} from 'node:crypto'
import {registrationTranscript} from './dsh-registration-contract.js'
import {LINK_DIAGNOSTIC_CONTRACT,LINK_OBSERVATION_DOMAIN,validLinkDiagnostic,validLinkObservation,
  type LinkDiagnostic,type LinkObservationPacket} from './link-observation-contract.js'
import type {LinkObserver} from './link-observation.js'
import type {DshQueueIdentityLease} from './dsh-message-queue-identity.js'
import type {PairingAuthorizationBinding} from './pairing-auth.js'

interface Pending {diagnostic:LinkDiagnostic;transport:'lan'|'relay';binding:PairingAuthorizationBinding;send:LinkObserver;at:number}
/** Optional metadata only. It never owns a socket, a business retry or an access decision. */
export class LinkDiagnosticReporter {
  private closed=false
  private timer?:NodeJS.Timeout
  private pending=new Map<string,Pending>()
  private history=new Map<string,number[]>()
  private fingerprints=new Map<string,string>()
  private running=false
  constructor(private readonly load:()=>Promise<DshQueueIdentityLease>,
    private readonly current:()=>PairingAuthorizationBinding|undefined,
    private readonly observer:()=>LinkObserver|undefined,private readonly version:string,
    private readonly environment:'PRODUCTION'|'SANDBOX',private readonly now=Date.now,
    private readonly monotonic=()=>performance.now()){}

  record(diagnostic:LinkDiagnostic,transport:'lan'|'relay'):void {
    try {
      if(this.closed||!validLinkDiagnostic(diagnostic,this.now()))return
      const binding=this.current(),send=this.observer()
      if(!binding||!send)return
      const key=diagnostic.kind==='authentication'?'auth:'+diagnostic.trace.id:'notification'
      if(!this.pending.has(key)&&this.pending.size>=5)return
      this.pending.set(key,{diagnostic:structuredClone(diagnostic),transport,binding:{...binding},send,at:this.now()})
      if(!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.flush()},150);this.timer.unref()}
    } catch {/* Diagnostics cannot change the operation being observed. */}
  }
  private same(p:Pending):boolean {
    const b=this.current()
    return !this.closed&&b?.pairingId===p.binding.pairingId&&b.mobilePublicKeyRaw===p.binding.mobilePublicKeyRaw
  }
  private permitted(p:Pending,commit:boolean=false):boolean {
    const key=p.binding.pairingId+':'+p.diagnostic.kind,t=this.monotonic()
    const old=(this.history.get(key)??[]).filter(v=>t>=v&&t-v<3600000)
    // Shared endpoint already has a 120/hour signing-key quota. Leave room for
    // pairing and real use: at most 12 auth summaries + 24 notification changes.
    if(old.length>=(p.diagnostic.kind==='authentication'?12:24))return false
    const fingerprint=JSON.stringify(p.diagnostic.kind==='notification'
      ?[p.diagnostic.result,p.diagnostic.detail.cause,p.diagnostic.detail.recovery,p.diagnostic.detail.retryInMs]
      :p.diagnostic)
    if(this.fingerprints.get(key)===fingerprint)return false
    if(commit){
      this.history.set(key,[...old,t]);this.fingerprints.set(key,fingerprint)
      while(this.history.size>8){const first=this.history.keys().next().value!;this.history.delete(first);this.fingerprints.delete(first)}
    }
    return true
  }
  async flush():Promise<void> {
    if(this.running||this.closed)return
    this.running=true
    try {
      const rows=[...this.pending.values()];this.pending.clear()
      for(const p of rows){
        try {
          if(!this.same(p)||!this.permitted(p))continue
          const lease=await this.load();lease.assertCurrent()
          if(!this.same(p)||lease.identity.pairingId!==p.binding.pairingId)continue
          const body:LinkObservationPacket['body']={contract:LINK_DIAGNOSTIC_CONTRACT,
            attemptId:randomBytes(16).toString('base64url'),publicKey:lease.identity.memberPublicKey,
            sequence:1,startedAtMs:p.at,version:this.version,environment:this.environment,cloud:null,
            connection:{memberId:lease.identity.memberId,pairingId:lease.identity.pairingId,
              transport:p.transport,evidence:'diagnostic',diagnostic:p.diagnostic}}
          const packet:LinkObservationPacket={body,signature:sign(null,registrationTranscript(LINK_OBSERVATION_DOMAIN,body),lease.memberKey).toString('base64url')}
          if(validLinkObservation(packet,this.now())&&this.same(p)&&this.permitted(p,true))p.send(packet)
        }catch{/* Existing queue handles delivery. No diagnostic-specific retry. */}
      }
    }finally{this.running=false;if(!this.closed&&this.pending.size&&!this.timer){this.timer=setTimeout(()=>{this.timer=undefined;void this.flush()},150);this.timer.unref()}}
  }
  close():void {this.closed=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending.clear();this.history.clear();this.fingerprints.clear()}
}
