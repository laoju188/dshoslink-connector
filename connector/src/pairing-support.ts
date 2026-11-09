import { randomBytes } from 'node:crypto'
import type {SupportOutbox} from './support-outbox.js'
import {windowsLanSummary,type WindowsLanDiagnostic} from './windows-lan-diagnostic-contract.js'
import { connectionEventText } from './connection-summary.js'
import { STARTUP_STEP_LABELS, STARTUP_REASON_LABELS, STARTUP_STORAGE_RECORD_LABELS, STARTUP_STORAGE_STEP_LABELS } from './startup-diagnostic.js'
import { Service, type Context } from '@deepseek-ai/cordis'
import { CONNECTOR_VERSION } from './connector-metadata.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { PairingSupportObservation } from './pairing-support-observation.js'
import { desktopTraceProgress } from './pairing-trace-progress.js'
import type { PairingDiagnostics } from './pairing-diagnostics.js'
import { validDesktopDiagnostic, type DesktopDiagnostic } from './pairing-support-contract.js'
import { TRACE_FEEDBACK_CONTRACT as DESKTOP_FEEDBACK_CONTRACT, TRACE_FEEDBACK_DOMAIN as DESKTOP_FEEDBACK_DOMAIN,
  validAnyDesktopFeedback as validDesktopFeedback, type TraceFeedbackPacket as DesktopFeedbackPacket,
  type TraceObservationPacket as SupportObservationPacket } from './pairing-trace-contract.js'

export interface SupportPreview { previewId: string; caseCode: string; summary: string }
export interface SupportStatus { retryAfterMs:number; outcome:'idle'|'sending'|'sent'|'unconfirmed'|'expired'|'limited'|'preparing'|'resumable'|'recovery_unavailable'; clientRequestId?:string }
export const SUPPORT_COOLDOWN_MS=60000
export interface SupportReceipt { accepted: true; feedbackId: string; attemptId: string }
interface PreviewEntry {
  observation: PairingSupportObservation; packet: SupportObservationPacket; diagnostic: DesktopDiagnostic; expires: number
  request?: DesktopFeedbackPacket; receipt?: SupportReceipt; operation?: Promise<SupportReceipt>
}
const errors: Record<string,string> = { none:'尚未记录具体错误',pin_mismatch:'验证码不一致',unauthorized:'请求未通过验证',
  invalid_request:'请求格式不符合要求',expired:'本次配对已过期',clock:'时间检查未通过',identity_conflict:'已有配对资料需要核对',
  busy:'连接器正在处理其他操作',unavailable:'连接服务暂时不可用',other:'未能完成此步骤',timeout:'这一步等待超时' }
const outcomes: Record<string,string> = { open:'尚未确认完成',cancelled:'已取消',replaced:'已开始另一轮配对',
  expired:'已过期',interrupted:'已中断',connected:'已完成连接',failed:'未能生成二维码',not_started:'本次未开始配对' }
const states: Record<DesktopDiagnostic['connectorState'],string> = {PAUSED:'已在本机暂停手机访问',READY:'可用',PORT_CONFLICT:'端口被占用',
  NO_PRIVATE_ADDRESS:'未找到局域网地址',DSH_UNAVAILABLE:'DSH 暂不可用',REPAIRING:'正在修复',RESTART_REQUIRED:'需要重启 DSH',FAILED:'启动未完成'}
const startupStages: Record<DesktopDiagnostic['failureStage'],string> = {ACCESS_CONTROL:'保存或读取暂停状态',NONE:'暂无',PAIRING_HTTPS:'建立配对连接服务',
  BOOTSTRAP_HTTP:'建立扫码连接服务',CONFIGURATION:'读取连接设置',NO_AVAILABLE_PAIR:'寻找可用端口',UNKNOWN:'尚未确定',SECURE_STORAGE_TIMEOUT:'读取安全存储超时',SECURE_STORAGE:'读取安全存储',IDENTITY:'验证电脑身份',STORAGE:'读写连接资料',REGISTRATION:'读取配对登记'}
export function supportSummary(packet: SupportObservationPacket, diagnostic: DesktopDiagnostic): string {
  const b=packet.body
  const startup=diagnostic.startup
  const startupLines=startup?[`初始化最后成功：${STARTUP_STEP_LABELS[startup.lastSuccess]}`,
    `初始化失败步骤：${STARTUP_STEP_LABELS[startup.step]}`,
    `初始化错误类别：${STARTUP_REASON_LABELS[startup.reason]}`,
    ...(startup.storage?[`本地资料操作：${STARTUP_STORAGE_RECORD_LABELS[startup.storage.record]}／${STARTUP_STORAGE_STEP_LABELS[startup.storage.step]}`]:[])]:[]
  const progress=desktopTraceProgress(b)
  const version = (value: string) => value === 'UNAVAILABLE' ? '暂未读取到' : value === 'UNSUPPORTED' ? '暂不支持' : value
  if(diagnostic.cloud||diagnostic.cloudPreparation||diagnostic.pairingContext&&b.seen===0&&b.outcome==='not_started'){
    const cloud=diagnostic.cloud?.body??diagnostic.cloudPreparation
    return [`故障编号：DSH-${b.attemptId}`,`插件版本：${b.pluginVersion}`,`电脑连接服务：${states[diagnostic.connectorState]}`,
      `启动出错步骤：${startupStages[diagnostic.failureStage]}`,
      ...startupLines,
      ...(diagnostic.pairingContext?[diagnostic.pairingContext.localBinding==='loaded'?'电脑当前已载入配对资料。':'本次未载入可用配对资料。']:[]),
      cloud?`已附带配对码流程的 ${cloud.steps.length} 项步骤记录。`:'没有当前配对尝试的完整步骤；不能据此判断尚未配对。',
      '载入资料不代表手机在线或聊天可用；手机本地错误以手机主动反馈为准。',
      ...(diagnostic.connection?['本次连接步骤：'+(diagnostic.connection.events.map(connectionEventText).join(' → ')||'暂无')]:[]),
      '仅包含连接诊断，不包含聊天、文件、配对码或密钥。'].join('\n')
  }
  return [`故障编号：DSH-${b.attemptId}`,`插件版本：${b.pluginVersion}`,`DSH版本：${version(diagnostic.dshVersion)}`,
    `Windows版本：${version(diagnostic.windowsVersion)}`,`记录时间：${new Date(b.startedAtMs).toLocaleString('zh-CN', { hour12: false })}`,
    `电脑连接服务：${states[diagnostic.connectorState]}`,`启动出错步骤：${startupStages[diagnostic.failureStage]}`,
    ...startupLines,
    ...(diagnostic.windowsLan?[`Windows 局域网检查：${windowsLanSummary(diagnostic.windowsLan).observation}`]:[]),
    ...(diagnostic.connection ? ['本次桌面运行的跨网与通知步骤：'+(diagnostic.connection.events.map(connectionEventText).join(' → ') || '暂无'),
      ...(diagnostic.connection.lastFailure ? [`最近记录的连接问题：${connectionEventText(diagnostic.connection.lastFailure)}；不代表目前仍存在。`] : [])] : []),
    `二维码：${b.seen&1?'已生成':'未生成'}`,`手机请求：${b.seen&2?'已接受':b.seen&64?'已到达电脑，尚未接受':'尚未记录到达电脑'}`,
    `结果：${outcomes[b.outcome]}`,`最后成功：${progress.lastSuccessfulStep}`,`未完成步骤：${progress.unfinishedStep}`,
    `结束情况：${progress.endingReason}`,`已确认故障：${progress.confirmedFailure?'有':'尚无已确认故障'}`,
    `情况：${errors[b.trace.blockingError]}`,`已恢复的问题：${b.trace.recoveredErrors}`,
    ...(progress.firstFailure ? [`最先记录的问题：${progress.firstFailure.step}；${progress.firstFailure.reason}`] : []),
    ...(progress.storageDetail ? [`本机资料步骤：${progress.storageDetail.record}／${progress.storageDetail.step}；本步骤用时 ${progress.storageDetail.stepMilliseconds} 毫秒；${progress.storageDetail.reason}`] : []),
    ...(progress.readCounts ? [`资料读取 ${progress.readCounts.fileReads} 次，解密 ${progress.readCounts.decryptions} 次，复用已校验结果 ${progress.readCounts.reusedValidatedReads} 次。`] : []),
    ...(progress.orderedEvents.length ? ['最近步骤：'+progress.orderedEvents.map(e=>`${e.step}（${e.result==='ok'?'已完成':e.reason}）`).join(' → ')] : []),
    ...(progress.omittedEvents ? [`更早的 ${progress.omittedEvents} 条步骤未附带；最先记录的问题仍保留。`] : []),
    `二维码显示：${b.trace.display==='shown'?'已显示':b.trace.display==='failed'?'显示失败':'尚无显示结果'}`,
    progress.evidenceGap,
    '电脑服务访问记录不等于本次手机已到达；未观察到不能推断没有扫码。',
    '仅包含连接诊断，不包含聊天、文件、验证码或二维码内容。'].join('\n')
}
export function desktopFeedbackSender(baseUrl: string): (packet: DesktopFeedbackPacket, signal: AbortSignal) => Promise<SupportReceipt> {
  if (!['https://dshoslink.cn','https://dshoslink.cn/sandbox'].includes(baseUrl)) throw Error('support_destination')
  return async (packet,signal) => {
    const response=await fetch(baseUrl+'/v2/desktop-feedback',{method:'POST',redirect:'error',signal,
      headers:{'content-type':'application/json'},body:JSON.stringify(packet)})
    if (response.status!==202) { await response.body?.cancel();throw Error(response.status===429?'support_limit':'support_unavailable') }
    const reader=response.body?.getReader()
    if (!reader) throw Error('support_unavailable')
    const chunks: Uint8Array[]=[];let bytes=0
    try { while (true) { const part=await reader.read();if(part.done)break;bytes+=part.value.length
      if(bytes>1024)throw Error('support_response');chunks.push(part.value) } }
    finally { await reader.cancel().catch(()=>{});reader.releaseLock() }
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (Object.keys(value).sort().join(',')!=='accepted,attemptId,feedbackId' || value.accepted!==true
      || !/^[a-f0-9]{32}$/.test(value.feedbackId) || value.attemptId!==packet.body.observation.body.attemptId) throw Error('support_response')
    return value
  }
}
export class PairingSupport {
  async checkLan():Promise<{message:string;nextStep:string}> {
    if(this.disposed)throw Error('support_unavailable')
    const snapshot=await this.collectWindowsLan?.()
    if(this.disposed)throw Error('support_unavailable')
    const summary=windowsLanSummary(snapshot)
    return {message:summary.observation,nextStep:'nextInvestigation' in summary?summary.nextInvestigation:
      '检查暂不可用，可使用发送连接反馈；原配对不变。'}
  }
  private previews=new Map<string,PreviewEntry>()
  private controllers=new Set<AbortController>()
  private disposed=false
  private selected:string|undefined
  private sendOperation:Promise<SupportReceipt>|undefined
  private nextSendAt=0
  private lastCooldownClock:number|undefined
  private cooldownNormalization:Promise<void>|undefined
  private outcome:SupportStatus['outcome']='idle' 
  private clientRequestId:string|undefined
  private clientReceipt:SupportReceipt|undefined
  readonly ready:Promise<void>
  private recoveryFailed=false
  constructor(private readonly diagnostics: Pick<PairingDiagnostics,'currentSupport'>,
    private readonly diagnostic:()=>DesktopDiagnostic,
    private readonly send=desktopFeedbackSender(SERVICE_ENDPOINTS.baseUrl), private readonly now=Date.now,
    private readonly collectWindowsLan?:()=>Promise<WindowsLanDiagnostic>,
    private readonly readManualIdentity?:(signal:AbortSignal)=>Promise<{publicKey:string;privateKey:string}|undefined>,
    private readonly outbox?:SupportOutbox) {
    this.ready=Promise.resolve().then(async()=>{
      const pending=await this.outbox?.pending()
      const cooldown=await this.outbox?.cooldownUntil(this.now())
      if(this.disposed)return
      this.nextSendAt=Math.max(this.nextSendAt,cooldown??0)
      if(pending){
        if(this.expired(pending)){
          // Retire an expired payload on the next load; do not retain it until
          // another submission, or claim that its delivery was confirmed.
          await this.outbox?.discardExpired(this.now())
          if(!this.disposed)this.outcome='expired'
        }else this.outcome='resumable'
      }
    }).catch(()=>{this.recoveryFailed=true;if(!this.disposed)this.outcome='recovery_unavailable'})
  }
  private expired(packet:DesktopFeedbackPacket):boolean{return this.now()>=Math.min(packet.body.submittedAtMs+23*3600000,packet.body.observation.body.startedAtMs+23*3600000)}
  private async transmit(packet:DesktopFeedbackPacket):Promise<SupportReceipt>{
    if(this.cooldownNormalization)await this.cooldownNormalization
    if(this.disposed)throw Error('support_unavailable')
    if(this.recoveryFailed)throw Error('support_recovery_unavailable')
    if(this.expired(packet))throw Error('support_preview_expired')
    if(!validDesktopFeedback(packet,this.now()))throw Error('support_content')
    const cooldown=await this.outbox?.reserve(this.now())
    if(cooldown){this.nextSendAt=cooldown;throw Error('support_cooldown')}
    // Persist the exact signed bytes before any network side effect.
    await this.outbox?.save(packet)
    if(this.disposed)throw Error('support_unavailable')
    const controller=new AbortController();this.controllers.add(controller)
    const timer=setTimeout(()=>controller.abort(),10000);timer.unref()
    try{const receipt=await this.send(packet,controller.signal);await this.outbox?.accepted(packet);return receipt}
    finally{clearTimeout(timer);this.controllers.delete(controller)}
  }
  status():SupportStatus {
    const now=this.now()
    if(this.lastCooldownClock!==undefined&&now<this.lastCooldownClock){
      this.nextSendAt=Math.min(this.nextSendAt,now+SUPPORT_COOLDOWN_MS)
      if(this.outbox&&!this.disposed){
        // Normalize the persisted deadline when the rollback is observed, not
        // one minute later at the next click (which would add another wait).
        this.cooldownNormalization=(this.cooldownNormalization??this.ready).then(async()=>{
          if(!this.disposed)await this.outbox!.cooldownUntil(now)
        }).catch(()=>{this.recoveryFailed=true;if(!this.disposed)this.outcome='recovery_unavailable'})
      }
    }
    this.lastCooldownClock=now
    return {retryAfterMs:Math.min(SUPPORT_COOLDOWN_MS,Math.max(0,this.nextSendAt-now)),outcome:this.outcome,
    ...(this.clientRequestId===undefined?{}:{clientRequestId:this.clientRequestId})}}
  sendCurrent(clientUpdateFailureAtMs?:number,clientRequestId?:string):Promise<SupportReceipt> {
    if(this.disposed)return Promise.reject(Error('support_unavailable'))
    if(clientRequestId!==undefined&&(typeof clientRequestId!=='string'||!/^[a-f0-9]{32}$/.test(clientRequestId)))return Promise.reject(Error('support_request'))
    // This local UI identity is not sent to the server and cannot replace the
    // frozen signed request. Only the same invocation may share its receipt.
    if(this.sendOperation)return clientRequestId===this.clientRequestId?this.sendOperation:Promise.reject(Error('support_busy'))
    if(clientRequestId!==undefined&&clientRequestId===this.clientRequestId&&this.clientReceipt)return Promise.resolve(this.clientReceipt)
    if(this.status().retryAfterMs>0)return Promise.reject(Error('support_cooldown'))
    // The cooldown belongs to the service, so remounts and multiple UI entries
    // cannot bypass it. An unknown response keeps the exact signed request.
    this.nextSendAt=this.now()+SUPPORT_COOLDOWN_MS
    this.clientRequestId=clientRequestId;this.clientReceipt=undefined
    const retireExpired=this.outcome==='expired'
    this.outcome='sending'
    this.sendOperation=Promise.resolve().then(async()=>{
      await this.ready
      if(this.disposed)throw Error('support_unavailable')
      if(this.recoveryFailed)throw Error('support_recovery_unavailable')
      this.outcome='sending'
      if(retireExpired)await this.outbox?.discardExpired(this.now())
      const retained=await this.outbox?.pending()
      if(retained)return this.transmit(retained)
      if(!this.selected){
        this.selected=this.preview().previewId
        const frozen=this.previews.get(this.selected)!
        if(this.readManualIdentity && frozen.packet.body.outcome==='not_started' && frozen.packet.body.identityType==='temporary'){
          const controller=new AbortController();this.controllers.add(controller)
          const timer=setTimeout(()=>controller.abort(),8000)
          let onAbort:()=>void=()=>{}
          const aborted=new Promise<never>((_resolve,reject)=>{
            onAbort=()=>reject(Error('support_identity_unavailable'));controller.signal.addEventListener('abort',onAbort,{once:true})})
          try{
            const identity=await Promise.race([this.readManualIdentity(controller.signal),aborted])
            controller.signal.throwIfAborted()
            if(this.disposed)throw Error('support_unavailable')
            if(identity){frozen.observation.attachManualIdentity(identity);frozen.packet=frozen.observation.snapshot()}
          }catch{/* Missing/unavailable identity remains anonymous; never invent an account. */}
          finally{clearTimeout(timer);controller.signal.removeEventListener('abort',onAbort);this.controllers.delete(controller)}
        }
        if(this.disposed)throw Error('support_unavailable')
        // Freeze the intended pairing report BEFORE the asynchronous read. A
        // retry reuses it, and local inspection failure must not lose feedback.
        if(this.collectWindowsLan){
          const item=this.previews.get(this.selected)!
          const unavailable:WindowsLanDiagnostic={version:1,checkedAtMs:this.now(),check:'unavailable',checkStage:'none',
            listener:'unknown',profile:'unknown',firewall:'unknown',inboundPolicy:'unknown',matchingBlockRules:0,matchingAllowRules:0}
          item.diagnostic={...item.diagnostic,windowsLan:unavailable}
          try{const windowsLan=await this.collectWindowsLan()
            const next={...item.diagnostic,windowsLan}
            if(validDesktopDiagnostic(next))item.diagnostic=next
          }catch{/* Keep explicit unknown; optional inspection cannot block a report. */}
        }
        // An explicit report can carry a fixed UI-bridge failure even when that
        // failed RPC could not reach the host checker. No caller-provided text.
        if(Number.isSafeInteger(clientUpdateFailureAtMs)&&clientUpdateFailureAtMs!>=0&&Math.abs(this.now()-clientUpdateFailureAtMs!)<86400000){
          const item=this.previews.get(this.selected)!
          item.diagnostic={...item.diagnostic,maintenance:{...item.diagnostic.maintenance,updateUi:{atMs:clientUpdateFailureAtMs!,reason:'host_bridge'}}}
        }
      }
      return this.submit(this.selected,'')
    }).then(receipt=>{this.outcome='sent';this.clientReceipt=receipt;this.selected=undefined;return receipt}).catch(error=>{
      this.outcome=error instanceof Error&&error.message==='support_preview_expired'?'expired'
        :error instanceof Error&&error.message==='support_recovery_unavailable'?'recovery_unavailable'
        :error instanceof Error&&error.message==='support_limit'?'limited'
        :error instanceof Error&&error.message==='support_preparing'?'preparing':'unconfirmed'
      // Only a later, explicit click starts a new report after expiry. Never
      // silently replace an in-flight/unknown request with a second submission.
      if(this.outcome==='expired')this.selected=undefined
      throw error
    }).finally(()=>{this.sendOperation=undefined})
    return this.sendOperation
  }
  preview(): SupportPreview {
    if (this.disposed) throw Error('support_unavailable')
    const diagnostic=this.diagnostic()
    if (!validDesktopDiagnostic(diagnostic)) throw Error('support_unavailable')
    let observation=this.diagnostics.currentSupport()
    if (observation?.preparing) throw Error('support_preparing')
    if (observation && Math.abs(this.now()-observation.snapshot().body.startedAtMs)>=23*3600000) observation=undefined
    if (!observation) {
      // Explicit local preview only. Never enqueue a fabricated automatic pairing attempt.
      observation=new PairingSupportObservation(CONNECTOR_VERSION,()=>{},this.now())
      observation.manualSnapshot(!['READY','PAUSED'].includes(diagnostic.connectorState))
    }
    const packet=observation.snapshot(), previewId=randomBytes(16).toString('base64url')
    for (const [id,item] of this.previews) if(item.expires<=this.now()&&!item.operation)this.previews.delete(id)
    if(this.previews.size>=4) {
      const evict=[...this.previews].find(([,item])=>!item.operation)
      if(!evict)throw Error('support_busy')
      this.previews.delete(evict[0])
    }
    // Keep a bounded frozen request across a delayed manual retry. A new pairing
    // must not silently replace the failure that the user intended to report.
    this.previews.set(previewId,{observation,packet,diagnostic,expires:packet.body.startedAtMs+23*3600000})
    return { previewId,caseCode:'DSH-'+packet.body.attemptId,summary:supportSummary(packet,diagnostic) }
  }
  submit(previewId: string, content: string): Promise<SupportReceipt> {
    const item=this.previews.get(previewId)
    if(this.disposed)return Promise.reject(Error('support_unavailable'))
    if(typeof content!=='string')return Promise.reject(Error('support_content'))
    const text=content.trim()||'配对或连接问题'
    // Crossing the local preview deadline cannot erase an accepted receipt or
    // replay an already-running request. Only a new send is subject to expiry.
    if(item?.operation) return item.request?.body.content===text ? item.operation : Promise.reject(Error('support_busy'))
    if(item?.request?.body.content===text && item.receipt)return Promise.resolve(item.receipt)
    if(!item||item.expires<=this.now())return Promise.reject(Error('support_preview_expired'))
    if(!item.request||item.request.body.content!==text) {
      const body:DesktopFeedbackPacket['body']={contract:item.diagnostic.serviceAccess?'dshos-desktop-feedback-v3':DESKTOP_FEEDBACK_CONTRACT,requestId:randomBytes(16).toString('base64url'),
        observation:item.packet,diagnostic:item.diagnostic,content:text,submittedAtMs:this.now()}
      item.request={body,signature:item.observation.sign(DESKTOP_FEEDBACK_DOMAIN,body)};item.receipt=undefined
    }
    if(!validDesktopFeedback(item.request,this.now()))return Promise.reject(Error('support_content'))
    item.operation=Promise.resolve().then(()=>this.transmit(item.request!)).then(receipt=>{
      item.receipt=receipt;return receipt
    }).finally(()=>{item.operation=undefined})
    return item.operation
  }
  async dispose(): Promise<void> {
    this.disposed=true;this.controllers.forEach(controller=>controller.abort())
    await Promise.allSettled([...this.previews.values()].map(item=>item.operation))
    await this.sendOperation?.catch(()=>{})
    await this.cooldownNormalization
    this.previews.clear()
    this.clientReceipt=undefined;this.clientRequestId=undefined
  }
}
export class PairingSupportRemote extends Service {
  readonly typertRemote:{service:PairingSupportRemote;serviceKey:'dshosSupport';namespace:'dshosSupport'}
  constructor(ctx:Context,private readonly support:PairingSupport) {
    super(ctx,'dshosSupport');this.typertRemote=Object.freeze({service:this,serviceKey:'dshosSupport',namespace:'dshosSupport'})
  }
  async status():Promise<SupportStatus> {await this.support.ready;return this.support.status()}
  checkLan():Promise<{message:string;nextStep:string}>{return this.support.checkLan()}
  send(clientUpdateFailureAtMs?:number,clientRequestId?:string):Promise<SupportReceipt> {return this.support.sendCurrent(clientUpdateFailureAtMs,clientRequestId)}
}
