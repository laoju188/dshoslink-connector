import type { SupportReceipt, SupportStatus } from '../pairing-support.js'
type Result<T>={ok:true;value:T}|{ok:false;error:unknown}
export interface PairingSupportRemoteClient {checkLan?():Promise<Result<{message:string;nextStep:string}>>;status():Promise<Result<SupportStatus>>;send(clientUpdateFailureAtMs?:number,clientRequestId?:string):Promise<Result<SupportReceipt>>}
export interface FeedbackButtonState {busy:boolean;retryAt:number;message:string}
export class FeedbackButtonController {
  private value:FeedbackButtonState={busy:false,retryAt:0,message:''}
  private listeners=new Set<()=>void>()
  private serial=0
  private statusSequence=0
  private pendingSend=false
  private clientRequestId:string|undefined
  constructor(private readonly remote:PairingSupportRemoteClient,private readonly now=Date.now){}
  snapshot():FeedbackButtonState{return this.value}
  subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>{this.listeners.delete(fn)}}
  private set(value:FeedbackButtonState):void{this.value=value;for(const fn of this.listeners)fn()}
  async refresh():Promise<void>{const own=this.serial,sequence=++this.statusSequence;try{const r=await this.remote.status();if(own!==this.serial||sequence!==this.statusSequence||!r.ok)return
    // Cooldown is shared across views. Delivery is not: an old host receipt
    // cannot acknowledge a click whose RPC never arrived at the host.
    const matches=this.serial===0||this.clientRequestId!==undefined&&r.value.clientRequestId===this.clientRequestId
    this.set({...this.value,busy:this.pendingSend||r.value.outcome==='sending',retryAt:Math.max(this.value.retryAt,r.value.retryAfterMs>0?this.now()+r.value.retryAfterMs:0),
      message:!matches||r.value.outcome==='idle'?this.value.message:this.message(r.value.outcome)})}catch{}}
  private message(outcome:SupportStatus['outcome']):string {
    return outcome==='sent'?'反馈已收到，谢谢。我们会据此排查和改进。'
      :outcome==='resumable'?'上次反馈尚未确认送达，点发送可继续提交同一份反馈。'
      :outcome==='recovery_unavailable'?'暂时无法读取上次反馈，资料已保留。请重开 DSH 后再试，或加入下方抖音群联系我们。'
      :outcome==='expired'?'上次反馈已超过续传时间，是否送达仍未确认。稍后可发送当前连接情况。'
      :outcome==='limited'?'反馈发送较频繁，请稍后再试。'
      :outcome==='preparing'?'正在整理连接情况，请稍后再试。'
      :outcome==='unconfirmed'?'暂未确认送达，请稍后重试。':''
  }
  async send():Promise<void>{if(this.value.busy||this.value.retryAt>this.now())return
    const own=++this.serial;this.clientRequestId=undefined;this.pendingSend=true;this.set({busy:true,retryAt:this.now()+60000,message:''})
    try{
      this.clientRequestId=Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')
      const r=await this.remote.send(undefined,this.clientRequestId);if(own!==this.serial)return
      ++this.statusSequence
      this.set({...this.value,busy:false,message:r.ok?this.message('sent'):this.message('unconfirmed')})
    }catch{if(own===this.serial){++this.statusSequence;this.set({...this.value,busy:false,message:this.message('unconfirmed')})}}
    finally{if(own===this.serial){this.pendingSend=false;await this.refresh()}}
  }
}
const states=new WeakMap<PairingSupportRemoteClient,FeedbackButtonController>()
export function feedbackButtonState(remote:PairingSupportRemoteClient):FeedbackButtonController {
  let state=states.get(remote);if(!state){state=new FeedbackButtonController(remote);states.set(remote,state)}return state
}
