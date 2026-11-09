import {emptyEntry,validEntry,validEntryEvent,type EntryEvent,type PairingEntryObservation} from './pairing-entry-observation.js'
import { CloudLinkReporter, type LinkObserver } from './link-observation.js'
import type { CloudDesktopRuntime } from './cloud-pairing-runtime.js'
import type { CloudDesktopJournal, CloudDesktopPairing } from './cloud-pairing-client.js'
import { CloudPairingHttpError } from './cloud-pairing-http.js'
import {validCloudPreparation,type CloudDiagnosticPacket,type CloudDiagnosticBody} from './cloud-pairing-diagnostic.js'
import { normalizeCloudCode } from './cloud-pairing-contract.js'
import { cloudFailureReason,CloudPairingProgress } from './cloud-pairing-progress.js'
import { CONNECTOR_VERSION } from './connector-metadata.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { observeConnection,type ConnectionObserver } from './connection-observations.js'
import { ServiceAccessFailure, type ServiceAccessDiagnostic } from './service-access.js'

const computerConflictGuidance='当前电脑的配对身份与账号已有的记录不一致，原配对仍保留。若仍用原电脑，请打开原来的 DSH 配置。要改用当前电脑，请在手机“电脑 → 连接与安全 → 管理电脑配对”核对并解除原配对，再获取新的配对码。'

export interface CloudPairingView {
  available:boolean
  phase:'loading'|'disabled'|'ready'|'waiting'|'completing'|'paired'|'connected'|'ended'|'problem'
  message:string
  canEnter:boolean
  canCancel:boolean
  retryAfterMs:number
}
/** Optional facts from the actual click, carried only over the local DSH bridge. */
export interface CloudPairingEntryReceipt {cycle:number;observation:PairingEntryObservation}
export interface CloudPairingHostOptions {
  supported(signal:AbortSignal):Promise<boolean>
  retained():boolean
  available?():boolean
  create(signal:AbortSignal):Promise<CloudDesktopRuntime>
  activate(runtime:CloudDesktopRuntime):Promise<void>
  maintain?(runtime:CloudDesktopRuntime):Promise<void>
  assertNoQrOperation():void
  monotonic():number
  schedule?(task:()=>void,delay:number):()=>void
  observeConnection?:ConnectionObserver
  linkObserver?:()=>LinkObserver|undefined
}
/** Host UI coordinator. Its public view contains no keys, requests, receipts or
 * pairing codes. A submitted attempt may finish for at most ten minutes without
 * an open panel. Page leases fence late reads/mutations independently of it. */
export class CloudPairingHost {
  private runtime:CloudDesktopRuntime|null=null
  private flow:CloudDesktopPairing|null=null
  private abort:AbortController|null=null
  private work:Promise<CloudPairingView>|null=null
  private mutation:Promise<CloudPairingView>|null=null
  private epoch=0
  private disposed=false
  private enabled:boolean|null=null
  private pollAt=0
  private mutationAt=0
  private entryOwner:number|null=null
  private entryCycle=0
  private owner:number|null=null
  private issuedView=0
  private lastView=0
  private backgroundUntil=0
  private stopBackground:(()=>void)|null=null
  private activated=false
  private refreshAt=0
  private refreshRevision=0
  private maintainAt=0
  private authenticatedPairing:string|null=null
  private lastDiagnostic:CloudDiagnosticPacket|null=null
  private preparation:CloudDiagnosticBody|null=null
  private entryProblem:{journal:string;message:string}|null=null
  private retirementRefresh=false
  private servicePause:ServiceAccessFailure|null=null
  private serviceClaimAt=0
  private readonly early:CloudPairingProgress
  private earlyReporter:CloudLinkReporter|undefined
  private view:CloudPairingView={available:true,phase:'loading',message:'正在准备电脑配对…',canEnter:false,canCancel:false,retryAfterMs:0}
  constructor(private readonly options:CloudPairingHostOptions){this.early=new CloudPairingProgress(CONNECTOR_VERSION,
    SERVICE_ENDPOINTS.registrationDirectoryName==='registration-sandbox'?'SANDBOX':'PRODUCTION',Date.now,options.monotonic)}
  openView():number{if(this.disposed)throw Error('cloud_pairing_context_ended');return ++this.issuedView}
  observeEntry(owner:number,event:EntryEvent,cycle=1):{recorded:boolean}{
    if(this.disposed||this.owner!==owner||!validEntryEvent(event)||!Number.isSafeInteger(cycle)||cycle<1)return {recorded:false}
    // Live input facts never amend an old/sent journal. The explicit claim
    // carries an immutable snapshot after a permitted terminal restart.
    if(this.mutation||this.runtime?.snapshot()?.journal)return {recorded:false}
    if(this.entryOwner===owner&&cycle<this.entryCycle)return {recorded:false}
    try{
      if(this.entryOwner!==owner||cycle>this.entryCycle){this.entryOwner=owner;this.entryCycle=cycle;this.early.replaceUI(emptyEntry());this.runtime?.replaceUI(emptyEntry())}
      this.early.observeUI(event);this.runtime?.recordUI(event)
      this.earlyReporter??=new CloudLinkReporter(this.options.linkObserver?.())
      const preparation=this.preparationDiagnostic();if(preparation)this.earlyReporter.report(preparation)
      // Established runtimes persist through the existing serialized checkpoint.
      return {recorded:true}
    }catch{return {recorded:false}}
  }
  snapshot():CloudPairingView{return {...this.view,retryAfterMs:Math.max(0,Math.ceil(this.pollAt-this.options.monotonic()))}}
  diagnostic():CloudDiagnosticPacket|null{return this.runtime?.diagnostic()??this.lastDiagnostic}
  serviceAccessDiagnostic():ServiceAccessDiagnostic|undefined{
    const access=this.servicePause?.access
    return access?{mode:access.mode,reason:access.reason,caseId:access.caseId}:undefined
  }
  preparationDiagnostic():CloudDiagnosticBody|null{
    if(this.diagnostic())return null
    const body=this.early.body()
    const prepared=this.runtime?.preparationDiagnostic()??this.preparation
    // Later UI observations must not hide a specific identity/open failure.
    if(prepared)return prepared.contract==='dshos-cloud-pairing-diagnostic-v4'
      ?{...prepared,entry:{...body.entry!}}:prepared
    return validCloudPreparation(body)?body:null
  }
  /** Captured at challenge start: a stale challenge cannot mark a new binding connected. */
  observeAuthentication(pairingId:string):(()=>void)|undefined{
    if(this.runtime?.snapshot()?.desktop.pairingId!==pairingId)return
    const runtime=this.runtime
    return ()=>{if(this.runtime===runtime&&this.runtime?.snapshot()?.desktop.pairingId===pairingId){
      this.authenticatedPairing=pairingId;runtime?.recordAuthentication(pairingId);this.present()
      // AUTH can arrive between panel polls. Preserve that observed stage even
      // if the user sends feedback or closes the panel before the next poll.
      // Reuse the host work queue so the checkpoint cannot race enrollment IO.
      void this.run(async()=>{})
    }}
  }
  private check(epoch:number):void{if(this.disposed||epoch!==this.epoch||this.abort?.signal.aborted)throw Error('cloud_pairing_context_ended')}
  private idleTerminal():boolean{
    const record=this.runtime?.snapshot(),journal=record?.journal
    // The vault has verified this signed pre-commit result. Keep its runtime
    // and diagnostic deduplication idle; never discard pending or saved work.
    return record?.savedReplyText===null&&journal?.pending===null&&Boolean(journal.replyText)&&
      journal.last?.binding===null&&['cancelled','rejected','expired','unused'].includes(String(journal.last?.state))
  }
  private scheduleBackground():void{
    this.stopBackground?.();this.stopBackground=null
    if(this.disposed)return
    if(this.options.available?.()===false){this.suspend();return}
    if(this.idleTerminal()&&!this.mutation){this.backgroundUntil=0;return}
    const record=this.runtime?.snapshot(),saved=Boolean(record?.savedReplyText&&record.journal?.last?.state!=='revoked')
    const now=this.options.monotonic(),remaining=this.backgroundUntil-now
    if(!saved&&(remaining<=0||this.view.phase==='ended'&&!this.mutation)){if(this.owner===null)this.suspend();else this.backgroundUntil=0;return}
    const epoch=this.epoch,task=()=>{
      this.stopBackground=null
      if(epoch!==this.epoch||this.disposed)return
      // This detached observer can join a rejected foreground reservation.
      // Consume its derived rejection; the public operation still rejects.
      void this.advance().finally(()=>{if(epoch===this.epoch)this.scheduleBackground()}).catch(()=>{})
    }
    // Offers expire after five minutes. Retained pairing is serviced independently
    // of the panel, at bounded cadence; no relay tickets are acquired here.
    const fast=!saved||remaining>0&&this.authenticatedPairing===null
    const delay=saved?Math.max(fast?5000:30000,this.pollAt-now):Math.min(remaining,Math.max(5000,this.pollAt-now))
    if(this.options.schedule)this.stopBackground=this.options.schedule(task,delay)
    else{const timer=setTimeout(task,delay);timer.unref();this.stopBackground=()=>clearTimeout(timer)}
  }
  private allowCompletion():void{
    if(this.backgroundUntil===0)this.backgroundUntil=this.options.monotonic()+600000
    this.scheduleBackground()
  }
  resumeRetained():void{
    if(this.disposed||this.options.available?.()===false||!this.options.retained()||this.runtime||this.work||this.stopBackground)return
    // An unfinished accepted operation gets its original bounded continuation.
    // Saved pairings start with the slower maintenance cadence after restart.
    void this.advance().finally(()=>this.scheduleBackground()).catch(()=>{})
  }
  refreshConnection():void{
    if(this.disposed||this.options.available?.()===false)return
    if(this.idleTerminal())return
    if(!this.runtime){this.resumeRetained();return}
    this.refreshRevision++;this.refreshAt=0;this.pollAt=0
    void this.advance().finally(()=>this.scheduleBackground()).catch(()=>{})
  }
  private hasComputerConflict(j:CloudDesktopJournal|null|undefined):boolean{
    return !!j?.attemptId&&j.attemptId===this.runtime?.prepareConflictAttempt&&
      (j.last?.state==='authorized'||j.last?.state==='expired')
  }
  private present():void{
    const record=this.runtime?.snapshot(),j=record?.journal,s=j?.last,state=s?.state
    const refused=Boolean(j?.claimRefusal||this.flow?.hasObservedClaimRefusal)
    const paired=state!=='revoked'&&record?.savedReplyText!==null&&record?.savedReplyText!==undefined
    const connected=paired&&this.authenticatedPairing===record?.desktop.pairingId
    const ended=['cancelled','rejected','expired','revoked','unused'].includes(String(state))
    this.view={available:this.enabled!==false||Boolean(record),phase:connected?'connected':paired?'paired':ended?'ended':
      state==='authorized'||state==='registered'?'completing':j?'waiting':this.enabled?'ready':'disabled',
      message:connected?'配对和首次连接已完成。可在手机开始使用；请保持 DSH 运行。':paired?(s?.phoneSaved===true?'手机和电脑已保存配对，正在建立连接。无需重新配对，请查看手机上的连接提示。':'电脑已保存配对，正在等待手机完成。请保持 DSH 和手机配对页面打开，暂时不要退出。'):
        state==='revoked'?'这次配对已解除，原资料已保留。':state==='unused'?'这次未建立配对，请重新输入手机上的配对码。':
        state==='expired'?'配对码已过期。请在手机重新开始，再输入新的配对码。':
        state==='rejected'?'手机已拒绝本次连接。如需继续，请在手机重新开始配对。':
        state==='cancelled'?'本次配对已取消。如需继续，请输入手机上的新配对码。':ended?'本次配对已结束。':
        state==='authorized'||state==='registered'?'手机已确认，正在安全保存配对。请保持 DSH 和手机配对页面打开，暂时不要退出。':j?(state==='claimed'?'请在手机端确认是否连接这台电脑。确认前，请核对电脑名称。':'正在核对配对请求，请稍候。请保持 DSH 和手机配对页面打开。'):
        this.enabled?'电脑插件已准备就绪，等待输入配对码。请在手机打开“配对 DSH”，将 8 位配对码填到下方。':'配对服务暂时无法使用，请稍后重试。已有配对不受影响。',
      canEnter:this.enabled===true&&(!j||refused||ended&&!paired&&state!=='revoked'),
      canCancel:Boolean(j&&!refused&&!paired&&!ended),retryAfterMs:0}
    if(!paired&&this.hasComputerConflict(j)){
      if(this.runtime?.prepareConflictUnreadable){
        if(state!=='expired')this.view={...this.view,phase:'problem',
          message:'电脑暂时无法读取本次配对的恢复记录。你可以取消本次配对，再从手机获取新的配对码。原配对资料会保留。'}
      }else this.view={...this.view,phase:state==='expired'?'ended':'problem',message:computerConflictGuidance}
    }
    if(this.entryProblem){
      if(paired||this.entryProblem.journal!==JSON.stringify(j??null))this.entryProblem=null
      else this.view={...this.view,phase:'problem',message:this.entryProblem.message}
    }
  }
  active():boolean{return Boolean(this.work||this.runtime?.snapshot()?.journal&&
    !['cancelled','rejected','expired','revoked','unused'].includes(String(this.runtime.snapshot()?.journal?.last?.state)))}
  private async open(epoch:number,allowCreate=false):Promise<void>{
    if(this.flow){
      const record=this.runtime?.snapshot(),state=record?.journal?.last?.state
      // A retained idle identity may have been opened before admission changed.
      // Refresh only new-entry availability; accepted requests still drain.
      if(record?.savedReplyText||record?.journal&&
        !['cancelled','rejected','expired','unused'].includes(String(state)))return
    }else this.abort=new AbortController()
    this.earlyReporter??=new CloudLinkReporter(this.options.linkObserver?.())
    this.early.observe('capabilities','started')
    try{const enabled=await this.options.supported(this.abort!.signal);this.check(epoch);this.enabled=enabled;this.early.observe('capabilities','completed')}
    catch(error){this.check(epoch);this.lastDiagnostic=null;this.early.observe('capabilities','failed',error);const body=this.early.body();if(validCloudPreparation(body))this.preparation=body;throw error}
    if(this.flow){this.present();return}
    if(!this.enabled&&!this.options.retained()){this.present();return}
    if(!allowCreate&&!this.options.retained()){this.present();return}
    this.options.assertNoQrOperation()
    this.early.observe('service_trust','started')
    let runtime:CloudDesktopRuntime
    try{runtime=await this.options.create(this.abort!.signal)}
    catch(error){this.check(epoch);this.lastDiagnostic=null;this.early.observe('service_trust','failed',error);const body=this.early.body();if(validCloudPreparation(body))this.preparation=body;throw error}
    try{this.check(epoch);this.early.observe('service_trust','completed');this.runtime=runtime;
      // Retain entry evidence across identity initialization, including an open
      // failure. No new pairing identity or request is created for diagnostics.
      try{for(const s of this.early.body().steps)if(s.stage==='entry_ready'||s.stage==='claim_submit')this.noteEntry(s.stage)}catch{/* Optional. */}
      const flow=await runtime.open();this.check(epoch);this.flow=flow
      const entry=this.early.body().entry
      try{if(entry&&!runtime.snapshot()?.journal){if(entry.visible)runtime.recordUI('visible');if(entry.inputStarted)runtime.recordUI('input');if(entry.inputValid)runtime.recordUI('valid');if(entry.submitClicked)runtime.recordUI('click');runtime.recordUI(`blocked:${entry.blockedReason}`)}}catch{/* Optional UI evidence cannot abort identity initialization. */}}
    catch(error){if(epoch===this.epoch&&!this.disposed&&!this.abort?.signal.aborted){
        this.lastDiagnostic=runtime.diagnostic();this.preparation=runtime.preparationDiagnostic()??this.preparation}
      runtime.close();if(this.runtime===runtime){this.runtime=null;this.flow=null}throw error}
    this.present()
  }
  private run(action:(epoch:number)=>Promise<void>,reserve?:{previous:Promise<CloudPairingView>|null;validate:()=>void}):Promise<CloudPairingView>{
    if(this.disposed)return Promise.reject(Error('cloud_pairing_context_ended'))
    if(this.work&&reserve===undefined)return this.work
    const epoch=this.epoch
    const work=(async()=>{
      // Publish the reserved work before yielding to the preceding read. New
      // reads join this work instead of replacing the accepted write intent.
      // Reservation failures reject before an action or diagnostic write starts.
      if(reserve){await reserve.previous;reserve.validate()}
      try{if(reserve)this.entryProblem=null;await action(epoch);this.check(epoch);
        if(reserve||this.runtime?.snapshot()?.savedReplyText)this.servicePause=null
        this.present()
        if(this.servicePause)this.view={...this.view,message:'上次请求：'+this.servicePause.message+' 如已解除，请重新输入手机上的配对码。'}
        if(!reserve)this.observeRetirementRefresh('ok')}
      catch(error){if(epoch===this.epoch&&!this.disposed){
        if(!reserve)this.observeRetirementRefresh('failed')
        this.present()
        const reason=cloudFailureReason(error),retry=(error as {retryAfterMs?:number}).retryAfterMs
        if(reason==='rate_limited')this.mutationAt=this.options.monotonic()+(typeof retry==='number'?Math.min(300000,Math.max(5000,retry)):5000)
        this.pollAt=Math.max(this.pollAt,this.options.monotonic()+(typeof retry==='number'?Math.min(300000,Math.max(5000,retry)):5000))
        const old=this.view
        if(!this.hasComputerConflict(this.runtime?.snapshot()?.journal))
          this.view={...old,phase:old.phase==='paired'?'paired':'problem',message:old.phase==='paired'?'电脑已保存配对，暂时无法继续核对手机状态。请保持两端运行，无需重新配对。':reason==='invalid_code'?'配对码无效或已失效，请核对手机上的配对码。':
          reason==='storage'?'电脑暂时无法读取或保存配对资料，原内容会保留。':
          reason==='storage_busy'?'电脑的连接资料暂时被占用，请稍后重试，原内容会保留。':
          reason==='identity_conflict'?'已有配对资料需要核对，原内容会保留。':
          reason==='rate_limited'?'请求较多，请稍后再试。':reason==='proof'?'暂时无法核对配对结果，原内容会保留。':
          '暂时无法完成这一步，正在核对原请求。',canEnter:reason==='storage_busy'?old.canEnter:!this.runtime?.snapshot()?.journal&&this.enabled===true}
        if(error instanceof ServiceAccessFailure){
          this.view={...old,phase:'problem',message:error.message,canEnter:old.canEnter}
          if(error.access!==null){this.servicePause=error;this.serviceClaimAt=this.options.monotonic()+10000;this.pollAt=this.options.monotonic()+300000}
        }
        if(reserve&&reason==='storage_busy'&&old.phase!=='paired'&&old.phase!=='connected')
          this.entryProblem={journal:JSON.stringify(this.runtime?.snapshot()?.journal??null),message:this.view.message}
      }}
      if(epoch===this.epoch&&!this.disposed){
        if(this.owner!==null&&this.view.canEnter&&this.options.available?.()!==false)this.noteEntry('entry_ready')
        await this.runtime?.checkpointDiagnostic()
        const prep=this.preparationDiagnostic();if(prep)this.earlyReporter?.report(prep)
      }
      return this.snapshot()
    })()
    this.work=work
    const clear=()=>{if(this.work===work)this.work=null}
    void work.then(clear,clear)
    return work
  }
  status(owner:number):Promise<CloudPairingView>{
    if(!Number.isSafeInteger(owner)||owner<1||owner>this.issuedView)return Promise.reject(Error('cloud_pairing_page_changed'))
    if(owner<this.lastView||owner===this.lastView&&this.owner!==owner)return Promise.resolve(this.snapshot())
    this.lastView=owner;this.owner=owner
    return this.advance()
  }
  private advance():Promise<CloudPairingView>{
    if(this.work)return this.work
    if(this.options.available?.()===false)return Promise.resolve(this.snapshot())
    if(this.options.monotonic()<this.pollAt)return Promise.resolve(this.snapshot())
    return this.run(async epoch=>{
      this.pollAt=this.options.monotonic()+5000
      await this.open(epoch);this.check(epoch)
      const j=this.runtime?.snapshot()?.journal
      if(!this.flow||!j)return
      if(!['cancelled','rejected','expired','revoked','unused'].includes(String(j.last?.state))){
        if(!this.runtime!.snapshot()!.savedReplyText)this.allowCompletion()
        // Saved receipts remain usable for fresh authority after invitation pruning.
        if(!this.runtime!.snapshot()!.savedReplyText){
          // Durable writes can finish after the host's earlier UI deadline.
          // Respect the protocol's remaining cooldown instead of showing its
          // poll_wait guard as a connection failure. No request is sent here.
          const delay=this.flow.pollDelayMs
          if(delay>0){this.pollAt=Math.max(this.pollAt,this.options.monotonic()+delay);return}
          await this.flow.poll();this.check(epoch)
        }
        const current=this.runtime!.snapshot()!.journal
        if(!current?.last?.desktopSaved&&!this.hasComputerConflict(current)){
          try{await this.flow.advance();this.check(epoch)}
          catch(error){
            // This is a specific refusal of an uncommitted prepare, not an
            // unknown response. Keep signed status/cancel and committed recovery.
            if(epoch===this.epoch&&error instanceof CloudPairingHttpError&&error.status===409&&
              error.reason==='existing_computer_mismatch')
              await this.runtime?.rememberPrepareConflict(current?.attemptId)
            throw error
          }
        }
        if(this.runtime!.snapshot()!.savedReplyText&&(!this.activated||this.options.monotonic()>=this.refreshAt)){
          const revision=this.refreshRevision
          await this.options.activate(this.runtime!);this.check(epoch);this.activated=true
          this.refreshAt=revision===this.refreshRevision?this.options.monotonic()+120000:0
        }
        if(this.activated&&this.options.monotonic()>=this.maintainAt){
          const fast=this.backgroundUntil>this.options.monotonic()&&this.authenticatedPairing===null
          this.maintainAt=this.options.monotonic()+(fast?5000:30000)
          await this.options.maintain?.(this.runtime!);this.check(epoch)
        }
      }
    })
  }
  private mutate(owner:number,action:(epoch:number)=>Promise<void>):Promise<CloudPairingView>{
    if(this.owner!==owner)return Promise.reject(Error('cloud_pairing_page_changed'))
    if(this.mutation)return Promise.reject(Error('cloud_pairing_busy'))
    const epoch=this.epoch,reading=this.work
    const mutation=this.run(action,{previous:reading,validate:()=>{
      this.check(epoch)
      if(this.owner!==owner)throw Error('cloud_pairing_page_changed')
      if(this.options.monotonic()<this.mutationAt)throw Error('cloud_pairing_rate_limited')
    }})
    this.mutation=mutation
    const clear=()=>{if(this.mutation===mutation)this.mutation=null}
    void mutation.then(clear,clear)
    return mutation
  }
  private noteEntry(stage:'entry_ready'|'claim_submit'):void {
    try{
      if(this.runtime)this.runtime.recordEntry(stage)
      else this.early.observeEntry(stage)
    }catch{/* Diagnostics cannot block the original action. */}
  }
  claim(code:string,owner:number,entry?:CloudPairingEntryReceipt):Promise<CloudPairingView>{
    if(this.owner!==owner)return Promise.reject(Error('cloud_pairing_page_changed'))
    // Receipt by the local host is not evidence of a server-accepted claim.
    if(!this.disposed&&this.view.canEnter&&this.options.available?.()!==false)this.noteEntry('claim_submit')
    if(this.servicePause&&this.options.monotonic()<this.serviceClaimAt)return Promise.resolve(this.snapshot())
    const normalized=normalizeCloudCode(code)
    const receipt=entry&&Number.isSafeInteger(entry.cycle)&&entry.cycle>0&&validEntry(entry.observation)
      ?{cycle:entry.cycle,observation:{...entry.observation}}:undefined
    return this.mutate(owner,async epoch=>{
      // Snapshot is evidence of this click, never reconstructed from an old
      // page cache or host readiness. Older callers remain valid with unknown UI facts.
      if(receipt){this.entryOwner=owner;this.entryCycle=receipt.cycle}
      this.early.replaceUI(receipt?.observation??emptyEntry())
      this.earlyReporter=new CloudLinkReporter(this.options.linkObserver?.())
      if(!normalized){
        const error=Error('cloud_pairing_invalid_code')
        if(this.runtime)this.runtime.recordCodeInput('failed',error)
        else{this.early.observe('code_input','failed',error);const body=this.early.body();if(validCloudPreparation(body))this.preparation=body}
        throw error
      }
      this.allowCompletion()
      await this.open(epoch,true);this.check(epoch);this.options.assertNoQrOperation()
      if(!this.flow||!this.runtime||!this.enabled)throw Error('cloud_pairing_unavailable')
      if(this.runtime.snapshot()?.journal?.claimRefusal||this.flow.hasObservedClaimRefusal){
        const original=await this.flow.resolveRefusedClaim();this.check(epoch)
        // A lost earlier reply may already have claimed or committed pairing.
        // Finish that original attempt, never replace it with the entered code.
        if(!['cancelled','rejected','expired','unused'].includes(String(original.state)))return
      }
      if(this.runtime.snapshot()?.journal)await this.runtime.restart()
      this.check(epoch);this.pollAt=this.options.monotonic()+5000
      this.runtime.replaceUI(receipt?.observation??emptyEntry())
      // An explicitly restarted terminal attempt has a new diagnostic stream.
      // Preserve this same user intent there; never synthesize it on recovery.
      if(this.view.canEnter)this.noteEntry('entry_ready')
      this.noteEntry('claim_submit')
      this.runtime.recordCodeInput('completed')
      try{await this.flow.start(normalized);this.check(epoch)}
      finally{if(epoch===this.epoch&&this.runtime.snapshot()?.journal)this.allowCompletion()}
    })
  }
  cancel(owner:number):Promise<CloudPairingView>{
    return this.mutate(owner,async epoch=>{if(!this.view.canCancel||!this.flow)return
      await this.flow.cancel();this.check(epoch)})
  }
  detach(owner:number):void{
    if(owner!==this.owner)return
    this.owner=null
    // A just-submitted new claim can still have the preceding ended page view.
    // Closing that page must not cancel the accepted mutation.
    if(this.idleTerminal()||this.runtime?.snapshot()?.savedReplyText&&this.runtime.snapshot()?.journal?.last?.state!=='revoked'
      ||this.backgroundUntil>this.options.monotonic()&&(this.mutation||!['connected','ended'].includes(this.view.phase)))this.scheduleBackground()
    else this.suspend()
  }
  private observeRetirementRefresh(result:'ok'|'failed'|'closed'):void{
    if(!this.retirementRefresh)return
    if(result!=='failed')this.retirementRefresh=false
    observeConnection(this.options.observeConnection,'pairing_state_refresh',result)
  }
  /** Verified external retirement invalidates runtime work, not a still-open
   * settings page. Hidden/replaced pages keep their existing lease fences. */
  invalidateRetiredPairing():void{
    if(this.disposed)return
    const owner=this.owner
    this.resetRuntime()
    this.owner=owner
    if(owner!==null){this.retirementRefresh=true
      observeConnection(this.options.observeConnection,'pairing_state_refresh','waiting')}
  }
  suspend():void{
    this.observeRetirementRefresh('closed')
    this.resetRuntime()
  }
  private resetRuntime():void{
    this.earlyReporter=undefined
    this.retirementRefresh=false
    this.stopBackground?.();this.stopBackground=null;this.backgroundUntil=0
    this.lastDiagnostic=this.diagnostic();this.epoch++;this.abort?.abort();this.runtime?.close();this.runtime=null;this.flow=null
    this.activated=false;this.refreshAt=0;this.maintainAt=0;this.work=null;this.pollAt=0
    this.owner=null;this.entryOwner=null;this.entryCycle=0
    this.authenticatedPairing=null;this.entryProblem=null
    this.servicePause=null;this.serviceClaimAt=0
    this.view={available:true,phase:'loading',message:'正在核对电脑配对…',canEnter:false,canCancel:false,retryAfterMs:0}
  }
  dispose():void{this.suspend();this.disposed=true}
}
