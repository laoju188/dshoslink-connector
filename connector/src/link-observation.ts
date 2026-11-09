import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { registrationTranscript } from './dsh-registration-contract.js'
import { LINK_OBSERVATION_CONTRACT, LINK_OBSERVATION_DOMAIN, validLinkObservation,
  type LinkObservationPacket, type LinkConnectionObservation } from './link-observation-contract.js'
import type { CloudDiagnosticBody } from './cloud-pairing-diagnostic.js'
import type { DshQueueIdentityLease } from './dsh-message-queue-identity.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'

export type LinkObserver = (packet:LinkObservationPacket)=>void
export interface LinkSigningIdentity { publicKey:string; key:KeyObject }
export class CloudLinkReporter {
  private stream = ''
  private reportId = ''
  private sequence = 0
  private fingerprint = ''
  private startedAt = 0
  private temporary?:LinkSigningIdentity
  constructor(private readonly send:LinkObserver|undefined,private readonly now=Date.now) {}
  report(cloud:CloudDiagnosticBody,identity?:LinkSigningIdentity):void {
    if(!this.send)return
    try {
      if(!identity){
        if(!this.temporary){const key=generateKeyPairSync('ed25519');this.temporary={key:key.privateKey,publicKey:key.publicKey.export({format:'jwk'}).x!}}
        identity=this.temporary
      }
      const stream=identity.publicKey+':'+cloud.operationId
      if(this.stream!==stream){this.stream=stream;this.reportId=randomBytes(16).toString('base64url');this.sequence=0;this.fingerprint='';this.startedAt=this.now()}
      // Periodic status reads/saves do not create more diagnostic traffic.
      const fingerprint=JSON.stringify([cloud.state,cloud.attemptId,cloud.claimId,
        cloud.steps.filter(s=>!['status','identity_save'].includes(s.stage)).map(s=>[s.stage,s.outcome,s.reason,s.cause,s.operation,s.transport]),
        cloud.entry??null,cloud.firstFailure&&[cloud.firstFailure.stage,cloud.firstFailure.reason,cloud.firstFailure.cause,cloud.firstFailure.operation,cloud.firstFailure.transport],
        cloud.lastFailure&&[cloud.lastFailure.stage,cloud.lastFailure.reason,cloud.lastFailure.cause,cloud.lastFailure.operation,cloud.lastFailure.transport]])
      if(this.fingerprint===fingerprint||this.sequence>=64)return
      const body:LinkObservationPacket['body']={contract:LINK_OBSERVATION_CONTRACT,attemptId:this.reportId,publicKey:identity.publicKey,
        sequence:this.sequence+1,startedAtMs:this.startedAt,version:cloud.version,environment:cloud.environment,
        cloud:structuredClone(cloud),connection:null}
      const packet:LinkObservationPacket={body,signature:sign(null,registrationTranscript(LINK_OBSERVATION_DOMAIN,body),identity.key).toString('base64url')}
      if(!validLinkObservation(packet,this.now()))return
      this.sequence++;this.fingerprint=fingerprint;this.send(packet)
    } catch { /* Optional diagnostics cannot change a pairing result. */ }
  }
}

/** Success evidence is emitted at most once per five-minute bucket, binding,
 * transport and kind. No request path, session identifier or operation count. */
export class LinkUsageReporter {
  private closed=false
  private readonly buckets=new Map<string,number>()
  private pending=0
  constructor(private readonly load:()=>Promise<DshQueueIdentityLease>,
    private readonly current:()=>PairingAuthorizationBinding|undefined,
    private readonly observer:()=>LinkObserver|undefined,private readonly version:string,
    private readonly environment:'PRODUCTION'|'SANDBOX',private readonly now=Date.now) {}
  captureAuthentication(pairingId:string,transport:'lan'|'relay'):(()=>void)|undefined {
    if(this.current()?.pairingId!==pairingId)return
    return this.capture(transport,'authenticated')
  }
  capture(transport:'lan'|'relay',evidence:Exclude<LinkConnectionObservation['evidence'],'diagnostic'>='business_request'):(()=>void)|undefined {
    if(this.closed)return
    const send=this.observer(),binding=this.current()
    if(!send||!binding)return
    const same=()=>{const active=this.current();return !this.closed&&active?.pairingId===binding.pairingId&&active.mobilePublicKeyRaw===binding.mobilePublicKeyRaw}
    let used=false
    return ()=>{
      if(used||!same()||this.pending>=2)return
      used=true
      const at=this.now(),bucket=Math.floor(at/300000),key=binding.pairingId+':'+transport+':'+evidence
      if(this.buckets.get(key)===bucket)return
      this.buckets.set(key,bucket)
      while(this.buckets.size>16)this.buckets.delete(this.buckets.keys().next().value!)
      this.pending++
      void this.load().then(lease=>{
        lease.assertCurrent()
        if(!same()||lease.identity.pairingId!==binding.pairingId)return
        const body:LinkObservationPacket['body']={contract:LINK_OBSERVATION_CONTRACT,attemptId:randomBytes(16).toString('base64url'),
          publicKey:lease.identity.memberPublicKey,sequence:1,startedAtMs:at,version:this.version,environment:this.environment,
          cloud:null,connection:{memberId:lease.identity.memberId,pairingId:lease.identity.pairingId,transport,evidence}}
        const packet:LinkObservationPacket={body,signature:sign(null,registrationTranscript(LINK_OBSERVATION_DOMAIN,body),lease.memberKey).toString('base64url')}
        if(validLinkObservation(packet,this.now()))send(packet)
      }).catch(()=>{}).finally(()=>{this.pending--})
    }
  }
  close():void {this.closed=true;this.buckets.clear()}
}

/** Capture at the actual challenge/handshake, then report only on its success.
 * Preserve the existing pairing diagnostic callback even if optional reporting fails. */
export function linkAuthenticationObserver(usage:()=>LinkUsageReporter|undefined,
  previous:((pairingId:string)=>(()=>void)|undefined)|undefined,transport:'lan'|'relay') {
  return (pairingId:string):(()=>void)=>{
    let old:(()=>void)|undefined,observed:(()=>void)|undefined,done=false
    try{old=previous?.(pairingId)}catch{/* Optional. */}
    try{observed=usage()?.captureAuthentication(pairingId,transport)}catch{/* Optional. */}
    return ()=>{
      if(done)return
      done=true
      try{old?.()}catch{/* Preserve the other independent observer. */}
      try{observed?.()}catch{/* Never alter authentication. */}
    }
  }
}
