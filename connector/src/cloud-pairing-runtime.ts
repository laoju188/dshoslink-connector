import type {EntryEvent} from './pairing-entry-observation.js'
import { CloudLinkReporter, type LinkObserver } from './link-observation.js'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { CloudDesktopPairing } from './cloud-pairing-client.js'
import { CloudDesktopVault, type CloudDesktopVaultOptions } from './cloud-pairing-vault.js'
import { cloudHistoricalReply, type CloudDesktopRecord } from './cloud-pairing-record.js'
import { cloudBindingReceipt, readCloudCurrent } from './cloud-pairing-current.js'
import { cloudSign, cloudDigest, type CloudPayload, type CloudRequest } from './cloud-pairing-contract.js'
import { registrationPrivateKey } from './dsh-registration-contract.js'
import { postCloudPairing } from './cloud-pairing-http.js'
import type { PairingTrustStore } from './pairing-trust-store.js'
import { CloudPairingProgress } from './cloud-pairing-progress.js'
import { CONNECTOR_VERSION } from './connector-metadata.js'
import {validCloudPreparation,type CloudDiagnosticPacket,type CloudDiagnosticBody,type CloudDiagnosticStep} from './cloud-pairing-diagnostic.js'
import type { CloudRelayKey, CloudRelayPacket } from './cloud-pairing-relay.js'
import { decryptCloudRelayPacket } from './cloud-pairing-relay-key.js'
import type { RelayRootKeyStore } from './relay-root-key-store.js'
import type { RelayConnectorCredentialStore } from './relay-connector-credential.js'

export interface CloudDesktopRuntimeOptions extends CloudDesktopVaultOptions {
  name: string
  linkObserver?: () => LinkObserver | undefined
  now?: () => number
  monotonic?: () => number
  post?: typeof postCloudPairing
  observe(stage:string,outcome:'started'|'completed'|'unknown'|'failed',error?:unknown): void
}
/** Owns only cloud enrollment. Runtime construction does not start LAN, render a
 * QR, touch the phone, or change a live desktop installation. */
export class CloudDesktopRuntime {
  private readonly vault: CloudDesktopVault
  private record: CloudDesktopRecord | null=null
  private flow: CloudDesktopPairing | null=null
  private closed=false
  private connecting=false
  private controller: AbortController | null=null
  private high=-1
  private highMono=-1
  private readonly now:()=>number
  private readonly mono:()=>number
  private progress:CloudPairingProgress
  private reporter:CloudLinkReporter
  private diagnosticCheckpoint:string|null=null
  private refusedPrepareAttempt: string | null = null
  private unreadablePrepareMarker = false
  constructor(private readonly options:CloudDesktopRuntimeOptions){
    this.now=options.now??Date.now;this.mono=options.monotonic??(()=>performance.now())
    this.reporter=new CloudLinkReporter(options.linkObserver?.(),this.now)
    this.progress=new CloudPairingProgress(CONNECTOR_VERSION,options.environment,this.now,this.mono)
    this.vault=new CloudDesktopVault({...options,assertCurrent:()=>this.check()})
  }
  private observe(stage:string,outcome:'started'|'completed'|'unknown'|'failed',error?:unknown,operation?:CloudDiagnosticStep['operation']):void {
    try{this.progress.observe(stage,outcome,error,operation);this.options.observe(stage,outcome,error)}catch{/* Reporting cannot change authorization. */}
  }
  diagnostic():CloudDiagnosticPacket|null {
    const r=this.record;if(!r)return null
    return this.progress.packet({attemptId:r.journal?.attemptId??'',claimId:r.journal?.claimId??'',revision:r.journal?.revision??0,
      state:r.journal?.last?.state as string??'unknown',publicKey:r.desktop.registrationPublicKey,privateKey:r.registrationPrivateKey})
  }
  preparationDiagnostic():CloudDiagnosticBody|null{
    const body=this.progress.body();return validCloudPreparation(body)?body:null
  }
  recordCodeInput(outcome:'completed'|'failed',error?:unknown):void{if(!this.closed)this.observe('code_input',outcome,error)}
  recordUI(event:EntryEvent):void{if(!this.closed&&!this.record?.journal)this.progress.observeUI(event)}
  replaceUI(entry:import('./pairing-entry-observation.js').PairingEntryObservation):void{if(!this.closed&&!this.record?.journal)this.progress.replaceUI(entry)}
  recordEntry(stage:'entry_ready'|'claim_submit'):void {
    // Reopening a retained/ended attempt must not rewrite its historical trace.
    // An explicit restart clears the journal before recording the new intent.
    try{this.check();if(!this.record?.journal)this.progress.observeEntry(stage)}catch{/* Optional observation only. */}
  }
  recordAuthentication(pairingId:string):void{
    if(!this.closed&&this.record?.savedReplyText&&this.record.desktop.pairingId===pairingId)this.observe('first_authentication','completed')
  }
  async checkpointDiagnostic():Promise<boolean>{
    if(this.closed||!this.record)return false
    try{const packet=this.diagnostic();if(!packet)return false
      // Passage of time alone is not a new observation. Persist and report changes
      // to steps/reasons/authority, not every panel or maintenance read.
      const observed=JSON.stringify({...packet.body,elapsedMs:0})
      if(observed===this.diagnosticCheckpoint)return true
      try{this.reporter.report(packet.body,{publicKey:this.record.desktop.registrationPublicKey,
        key:registrationPrivateKey(this.record.registrationPrivateKey,this.record.desktop.registrationPublicKey)})}catch{/* Optional. */}
      await this.vault.saveDiagnostic(this.record,packet);this.diagnosticCheckpoint=observed;return true}
    catch{return false} // Optional evidence cannot invent an identity-save failure.
  }
  private check():void{
    this.options.assertCurrent(); const now=this.now(),mono=this.mono()
    if(this.closed||!Number.isSafeInteger(now)||now<this.high||!Number.isFinite(mono)||mono<this.highMono)throw Error('cloud_pairing_context_ended')
    this.high=now;this.highMono=mono
  }
  private async save(next:CloudDesktopRecord):Promise<void>{
    this.check();this.observe('identity_save','started')
    try{await this.vault.write(next,this.record!);this.check();this.record=structuredClone(next);this.observe('identity_save','completed')}
    catch(error){this.observe('identity_save','failed',error);throw error}
  }
  async open():Promise<CloudDesktopPairing>{
    this.check();if(this.flow)throw Error('cloud_pairing_already_open')
    this.observe('identity_read','started')
    try{this.record=await this.vault.open(this.options.name);this.check()
      try{const previous=await this.vault.readDiagnostic(this.record);this.check();if(previous)this.progress.restore(previous.body)}
      catch{this.check()} // Optional evidence is not the pairing identity.
      this.observe('identity_read','completed')}
    catch(error){this.observe('identity_read','failed',error);throw error}
    const record=this.record
    const journal=record.journal
    if (journal?.attemptId && ['authorized','expired'].includes(String(journal.last?.state))) {
      try {
        if (await this.vault.readPrepareConflict(record,journal.attemptId)) this.refusedPrepareAttempt=journal.attemptId
      } catch {
        // An unreadable marker may describe a refused prepare for this attempt.
        // Only signed status and cancellation may resolve that uncertainty.
        this.refusedPrepareAttempt=journal.attemptId
        this.unreadablePrepareMarker=true
      }
      this.check()
    }
    this.flow=new CloudDesktopPairing({environment:record.environment,desktop:record.desktop,
      registrationPrivateKey:record.registrationPrivateKey,memberPrivateKey:record.memberPrivateKey,serviceKey:this.options.trust,
      read:async()=>{this.check();const current=await this.vault.read();this.check()
        if(JSON.stringify(current)!==JSON.stringify(this.record))throw Error('cloud_pairing_source_changed')
        return current?.journal??null},
      write:async journal=>{await this.save({...this.record!,journal})},
      post:this.options.post??postCloudPairing,
      saveBinding:async status=>{
        const current=this.record!
        if(!current.journal?.replyText||JSON.stringify(current.journal.last)!==JSON.stringify(status))throw Error('cloud_pairing_saved_proof_missing')
        if(current.savedReplyText){const saved=cloudHistoricalReply(current.savedReplyText,this.options.trust,current)
          if(JSON.stringify(saved.binding)!==JSON.stringify(status.binding))throw Error('cloud_pairing_saved_binding_changed');return}
        await this.save({...current,savedReplyText:current.journal.replyText})},
      assertCurrent:()=>this.check(),now:this.now,monotonic:this.mono,observe:(stage,outcome,error)=>this.observe(stage,outcome,error)})
    return this.flow
  }
  snapshot():CloudDesktopRecord|null{return this.record?structuredClone(this.record):null}
  get prepareConflictAttempt(): string | null { return this.refusedPrepareAttempt }
  get prepareConflictUnreadable(): boolean { return this.unreadablePrepareMarker }
  async rememberPrepareConflict(attemptId: string | null | undefined): Promise<void> {
    const record = this.record, journal = record?.journal
    if (this.closed || !record || !attemptId || journal?.attemptId !== attemptId ||
      journal.last?.state !== 'authorized' || journal.pending?.operation !== 'prepare') return
    this.refusedPrepareAttempt=attemptId
    try { await this.vault.savePrepareConflict(record,attemptId) }
    catch { /* In this process still stop submitting the refused prepare. */ }
  }
  async restart():Promise<void>{
    this.check();const old=this.record
    if(!old?.journal?.replyText||old.journal.pending||old.savedReplyText||this.connecting||this.flow?.activeOperation||
      !['cancelled','rejected','expired','unused'].includes(old.journal.last?.state as string)||old.journal.last?.binding!==null)
      throw Error('cloud_pairing_original_result_required')
    // Only a signed pre-commit terminal result permits another attempt. Retain
    // that evidence and all original keys; unknown/registered results never reset.
    await this.save({...old,journal:null,previousReplyText:old.journal.replyText})
    this.refusedPrepareAttempt=null
    this.unreadablePrepareMarker=false
    this.progress=new CloudPairingProgress(CONNECTOR_VERSION,this.options.environment,this.now,this.mono)
    this.reporter=new CloudLinkReporter(this.options.linkObserver?.(),this.now)
  }
  async connect(trustStore:PairingTrustStore,invalidatePrevious:()=>void,offer?:CloudPayload):Promise<CloudPayload>{
    this.check();if(this.connecting||!this.record?.savedReplyText)throw Error('cloud_pairing_saved_proof_missing')
    this.connecting=true;const controller=new AbortController();this.controller=controller
    let timedOut=false;const started=this.mono();const timer=setTimeout(()=>{timedOut=true;controller.abort()},8000)
    let stage=offer?'publish':'connect';let operation:CloudDiagnosticStep['operation']='request'
    try{
      const record=this.record,receipt=cloudBindingReceipt(cloudHistoricalReply(record.savedReplyText!,this.options.trust,record)),now=this.now()
      const payload:CloudPayload=offer?{receipt,offer:{...offer,issuedAt:now,expiresAt:now+300000}}:{receipt}
      const body:Omit<CloudRequest,'signature'>={contract:'dshos-cloud-pairing-v3',product:'harmony-dsh',environment:record.environment,
        role:'desktop',operation:offer?'publish':'connect',requestId:randomBytes(16).toString('base64url'),attemptId:receipt.manifest.attemptId as string,
        publicKey:record.desktop.registrationPublicKey,issuedAt:now,expiresAt:now+60000,payload}
      const request:CloudRequest={...body,signature:cloudSign('REQUEST',body,registrationPrivateKey(record.registrationPrivateKey,record.desktop.registrationPublicKey))}
      this.observe(stage,'started')
      const text=await (this.options.post??postCloudPairing)(JSON.stringify(request),controller.signal);this.check()
      if(controller.signal.aborted||this.mono()-started>=8000)throw Error('cloud_pairing_response_expired')
      clearTimeout(timer);const received=this.mono();operation='verify_response'
      const current=readCloudCurrent(text,request,receipt,this.options.trust,this.now())
      this.observe(stage,'completed');stage='desktop_activation';this.observe(stage,'started')
      const assertFresh=()=>{this.check();if(controller.signal.aborted||this.mono()-received>=20000||this.now()>=(current.expiresAt as number))throw Error('cloud_pairing_current_expired')}
      assertFresh();await this.vault.activate(record,request,text,this.now,assertFresh,trustStore,invalidatePrevious);assertFresh()
      this.observe('desktop_activation','completed');return current
    }catch(error){
      const failure=timedOut&&!this.closed?new Error('cloud_pairing_timeout',{cause:error}):error
      this.observe(stage,stage==='desktop_activation'?'failed':'unknown',failure,stage==='desktop_activation'?undefined:operation);throw failure
    }finally{clearTimeout(timer);controller.abort();this.controller=null;this.connecting=false}
  }
  async relayPublicKey():Promise<CloudRelayKey>{
    this.check();if(!this.record?.savedReplyText)throw Error('cloud_pairing_saved_proof_missing')
    const key=await this.vault.loadRelayKey(this.record);this.check()
    if(this.record.relayKeyId===undefined)await this.save({...this.record,relayKeyId:key.keyId})
    return {keyId:key.keyId,publicKey:key.publicKey}
  }
  private async relayRequest(operation:'relay-read'|'relay-ack',extra:CloudPayload={}):Promise<CloudPayload>{
    this.check();const record=this.record
    if(!record?.savedReplyText)throw Error('cloud_pairing_saved_proof_missing')
    const receipt=cloudBindingReceipt(cloudHistoricalReply(record.savedReplyText,this.options.trust,record)),now=this.now()
    const body:Omit<CloudRequest,'signature'>={contract:'dshos-cloud-pairing-v3',product:'harmony-dsh',environment:record.environment,
      role:'desktop',operation,requestId:randomBytes(16).toString('base64url'),attemptId:receipt.manifest.attemptId as string,
      publicKey:record.desktop.registrationPublicKey,issuedAt:now,expiresAt:now+60000,payload:{receipt,...extra}}
    const request:CloudRequest={...body,signature:cloudSign('REQUEST',body,registrationPrivateKey(record.registrationPrivateKey,record.desktop.registrationPublicKey))}
    const controller=new AbortController();this.controller=controller
    let timedOut=false;const start=this.mono(),timer=setTimeout(()=>{timedOut=true;controller.abort()},8000)
    try{
      const text=await(this.options.post??postCloudPairing)(JSON.stringify(request),controller.signal);this.check()
      if(controller.signal.aborted||this.mono()-start>=8000)throw Error('cloud_pairing_response_expired')
      return readCloudCurrent(text,request,receipt,this.options.trust,this.now())
    }catch(error){
      if(timedOut&&!this.closed)throw new Error('cloud_pairing_timeout',{cause:error})
      throw error
    }finally{clearTimeout(timer);controller.abort();if(this.controller===controller)this.controller=null}
  }
  async provisionRelay(trustStore:PairingTrustStore,rootStore:RelayRootKeyStore,credentialStore:RelayConnectorCredentialStore):Promise<void>{
    this.check();if(this.connecting)throw Error('cloud_pairing_busy');this.connecting=true
    let operation:CloudDiagnosticStep['operation']='read_relay'
    try{
      const current=await this.relayRequest('relay-read'),relay=current.relay as {state:string;packet:CloudRelayPacket|null}
      if(!relay.packet||relay.state==='acknowledged')return
      this.observe('relay_bootstrap','started')
      const start=this.mono(),body=current.body as CloudPayload
      const binding={pairingId:body.newPairingId as string,mobilePublicKeyRaw:body.newMobilePublicKey as string}
      const reauthorize=()=>{
        this.check();const trust=trustStore.read()
        if(this.now()>=(current.expiresAt as number)||this.now()>=relay.packet!.header.expiresAt||this.mono()-start>=20000||
          trust?.status!=='active'||trust.pairingId!==binding.pairingId||trust.mobilePublicKeyRaw!==binding.mobilePublicKeyRaw)return
        return binding
      }
      if(!reauthorize())throw Error('cloud_pairing_current_expired')
      operation='read_relay_key';const key=await this.vault.loadRelayKey(this.record!);if(!reauthorize())throw Error('cloud_pairing_current_expired')
      operation='decrypt_relay';const secrets=decryptCloudRelayPacket(key,relay.packet,current,this.now())
      try{
        operation='save_relay_root';const root=await rootStore.provision(secrets.root,binding,reauthorize)
        if(!['stored','unchanged'].includes(root))throw Error('cloud_pairing_relay_root_'+root)
        operation='save_relay_credential';const credential=await credentialStore.provision(secrets.credential,binding,reauthorize,true)
        if(!['stored','unchanged'].includes(credential))throw Error('cloud_pairing_relay_credential_'+credential)
        if(!reauthorize())throw Error('cloud_pairing_current_expired')
        operation='acknowledge';if(relay.state!=='acknowledged')await this.relayRequest('relay-ack',{packetDigest:cloudDigest(relay.packet)})
        this.observe('relay_bootstrap','completed')
      }finally{secrets.root.fill(0);secrets.credential.fill(0)}
    }catch(error){this.observe('relay_bootstrap','failed',error,operation);throw error}
    finally{this.connecting=false}
  }
  close():void{this.closed=true;this.controller?.abort();this.flow?.close()}
}
