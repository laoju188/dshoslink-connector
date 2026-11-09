import {emptyEntry,observeEntryEvent,type EntryEvent,type EntryBlockReason} from '../pairing-entry-observation.js'
import {useEffect,useRef,useState} from 'react'
import type {CloudPairingView,CloudPairingEntryReceipt} from '../cloud-pairing-host.js'

export interface CloudPairingRemoteClient {
  observeEntry?(viewId:number,event:EntryEvent,cycle?:number):Promise<{recorded:boolean}>
  openView():Promise<number>
  status(viewId:number):Promise<CloudPairingView>
  claim(viewId:number,code:string,entry?:CloudPairingEntryReceipt):Promise<CloudPairingView>
  cancel(viewId:number):Promise<CloudPairingView>
  suspend(viewId:number):Promise<{suspended:true}>
}
/** Keeps code entry local to this mounted panel; never persists it in browser storage. */
export function CloudPairingPanel({remote,blockedReason='none',blockedMessage='',paired=false,clearInput=false,onCheck}:
  {remote:CloudPairingRemoteClient;blockedReason?:EntryBlockReason;blockedMessage?:string;paired?:boolean;clearInput?:boolean;onCheck?:()=>void}):JSX.Element{
  const [view,setView]=useState<CloudPairingView|null>(null),[code,setCode]=useState(''),[busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const validCode=code.length<=24&&/^[0-9０-９]{8}$/.test(code.replace(/[ -]/g,''))
  const generation=useRef(0),pending=useRef<object|null>(null),current=useRef<CloudPairingView|null>(null)
  const readIdle=useRef<Promise<void>|null>(null),action=useRef<object|null>(null)
  const viewId=useRef(0),input=useRef<HTMLInputElement|null>(null),recheck=useRef<()=>void>(()=>{})
  const gate=useRef({blockedReason,paired,clearInput});gate.current={blockedReason,paired,clearInput}
  const inputRevision=useRef(0),entryCycle=useRef(0),entryFacts=useRef(emptyEntry()),submitted=useRef(false)
  const receiptQueue=useRef(Promise.resolve()),receipts=useRef(new Set<string>())
  const lastBlock=useRef(''),blockChanges=useRef(0)
  const nextEntry=()=>{entryCycle.current++;entryFacts.current=emptyEntry();submitted.current=false;receipts.current.clear();lastBlock.current='';blockChanges.current=0}
  const note=(event:EntryEvent)=>{
    if(document.hidden)return
    observeEntryEvent(entryFacts.current,event)
    const lease=viewId.current,epoch=generation.current,cycle=entryCycle.current,key=lease+':'+cycle+':'+event
    if(!remote.observeEntry||!lease||document.hidden)return
    const blocked=event.startsWith('blocked:')
    if(blocked){if(lastBlock.current===key||blockChanges.current>=12)return;lastBlock.current=key;blockChanges.current++}
    else{if(receipts.current.has(key))return;receipts.current.add(key)}
    receiptQueue.current=receiptQueue.current.then(async()=>{
      if(generation.current!==epoch||viewId.current!==lease||entryCycle.current!==cycle||document.hidden){receipts.current.delete(key);return}
      try{const r=await remote.observeEntry!(lease,event,cycle);if(!r.recorded)receipts.current.delete(key)}catch{receipts.current.delete(key)}
    })
  }
  // Revoke only the unsent UI intent. Do not release a read lock, cancel an
  // already sent request, or erase the host's durable pairing operation.
  useEffect(()=>{if(paired||clearInput){inputRevision.current++;nextEntry();setCode('')}},[paired,clearInput])
  useEffect(()=>{
    if(paired)return
    // A host-ready response is not a visible-input receipt. Observe real layout.
    const element=input.current
    if(!element||typeof IntersectionObserver==='undefined')return
    const observer=new IntersectionObserver(entries=>{
      if(!document.hidden&&entries.some(e=>e.isIntersecting&&e.intersectionRatio>0))note('visible')
    });observer.observe(element);return()=>observer.disconnect()
  },[remote,view,paired,blockedReason])
  const entryBlock:EntryBlockReason=error?'read_failed':blockedReason!=='none'?blockedReason:
    !view||view.phase==='loading'?'preparing':view.phase==='disabled'?'service_unavailable':
    view.phase==='problem'&&!view.canEnter&&!view.canCancel?'startup_failed':'none'
  useEffect(()=>{if(!paired)note(`blocked:${entryBlock}`)},[remote,view,paired,entryBlock])
  const apply=(value:CloudPairingView)=>{
    if(current.current?.canEnter===false&&value.canEnter)nextEntry()
    current.current=value;setView(value)
    if(!value.canEnter&&['waiting','completing','paired','connected','ended'].includes(value.phase))setCode('')}
  useEffect(()=>{
    let ended=false,timer:ReturnType<typeof setTimeout>|undefined
    const epoch=++generation.current;nextEntry();receiptQueue.current=Promise.resolve();setCode('');setError('');setView(null);setBusy(false);current.current=null
    // A replaced host owns a fresh read lane. Old completions cannot release
    // the new host's read/action gate or strand it behind a lost old bridge.
    pending.current=null;action.current=null;readIdle.current=null
    let id=0,visibilityEpoch=0;viewId.current=0
    const read=async()=>{
      if(ended||document.hidden)return
      if(pending.current||action.current){timer=setTimeout(()=>{void read()},5000);return}
      const readIntent={};pending.current=readIntent;const visibleEpoch=visibilityEpoch
      const waiting=setTimeout(()=>{if(!ended&&generation.current===epoch&&visibleEpoch===visibilityEpoch&&!document.hidden)setError('状态检查仍在等待，暂时不能提交。请稍候；持续无响应时，可重新打开插件页面。')},15000)
      let finishRead!:()=>void
      const reading=new Promise<void>(resolve=>{finishRead=resolve});readIdle.current=reading
      try{if(id===0){const lease=await remote.openView();if(ended||document.hidden||visibleEpoch!==visibilityEpoch){void remote.suspend(lease).catch(()=>{});return}id=lease;viewId.current=id}
        const value=await remote.status(id);if(!ended&&generation.current===epoch&&visibleEpoch===visibilityEpoch){apply(value);setError('')}}
      catch{if(!ended&&generation.current===epoch&&visibleEpoch===visibilityEpoch&&!document.hidden)setError('暂时无法读取配对状态。可以直接发送反馈，我们帮助排查。')}
      finally{clearTimeout(waiting);if(pending.current===readIntent)pending.current=null;if(readIdle.current===reading)readIdle.current=null;finishRead();
        if(!ended&&!document.hidden)timer=setTimeout(()=>{void read()},Math.max(5000,current.current?.retryAfterMs??0))}
    }
    const visibility=()=>{clearTimeout(timer);visibilityEpoch++;if(document.hidden){if(id)void remote.suspend(id).catch(()=>{});id=0;viewId.current=0;setBusy(false)}else{void read()}}
    recheck.current=()=>{if(pending.current||action.current)return;clearTimeout(timer);void read()}
    document.addEventListener('visibilitychange',visibility);void read()
    return()=>{ended=true;generation.current++;clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);if(id)void remote.suspend(id).catch(()=>{})}
  },[remote])
  const execute=async(task:(lease:number)=>Promise<void>,failure:string)=>{
    if(action.current||document.hidden||viewId.current===0)return
    const epoch=generation.current,lease=viewId.current,revision=inputRevision.current,intent={};action.current=intent;setBusy(true)
    const isCurrent=()=>epoch===generation.current&&lease===viewId.current&&!document.hidden
    try{
      // Retain one explicit user action while the existing read finishes. Never
      // retain it across page/visibility changes or replay an uncertain mutation.
      await readIdle.current
      if(!isCurrent()||revision!==inputRevision.current)return
      pending.current=intent;await task(lease)
    }catch{if(isCurrent())setError(failure)}
    finally{if(action.current===intent){action.current=null;if(pending.current===intent)pending.current=null;setBusy(false)}}
  }
  const run=(kind:'claim'|'cancel',task:(lease:number)=>Promise<CloudPairingView>)=>{
    const epoch=generation.current
    return execute(async lease=>{
      if(kind==='claim'?(!current.current?.canEnter||gate.current.paired||gate.current.clearInput||gate.current.blockedReason!=='none'):!current.current?.canCancel)return
      if(kind==='claim')submitted.current=true
      const value=await task(lease)
      if(epoch===generation.current&&lease===viewId.current&&!document.hidden){apply(value);setError('')}
    },'结果暂未确认，原请求已保留。请稍候。')
  }
  const entryAllowed=!paired&&!clearInput&&blockedReason==='none'&&!error&&view?.canEnter===true
  const entryVisible=!paired&&(!view||view.canEnter||['loading','disabled','ready'].includes(view.phase)||view.phase==='problem'&&!view.canCancel)
  return <section aria-label="手机配对码" style={{padding:20,border:'1px solid var(--dsw-alias-border-l2, #444)',borderRadius:12}}>
    <h3 style={{margin:'0 0 12px'}}>连接手机</h3>
    <p role="status">{blockedMessage||error||(busy?'正在提交配对操作，请保持 DSH 和手机配对页面打开。':paired&&(!view||['ready','loading','disabled'].includes(view.phase))?'原有配对资料已保留，请在手机查看连接情况。':view?.message)||'正在准备电脑配对，请稍候。配对码输入位置就在下方。'}</p>
    {entryVisible?<p>在手机打开“配对 DSH”，将手机显示的 8 位配对码输入下方。配对码不会自动传到电脑剪贴板。</p>:null}
    {entryVisible?<form onSubmit={event=>{event.preventDefault();if(validCode&&entryAllowed){note('click');const entry={cycle:entryCycle.current,observation:{...entryFacts.current}};void run('claim',lease=>remote.claim(lease,code,entry))}}}>
      <label>手机上的配对码
        <input ref={input} value={code} inputMode="numeric" autoComplete="off" maxLength={24} aria-label="手机上的 8 位配对码"
          placeholder="输入手机上的 8 位配对码" disabled={busy||!entryAllowed} onChange={event=>{if(!entryAllowed)return;if(submitted.current)nextEntry();const value=event.target.value;setCode(value);note('visible');note('input');if(value.length<=24&&/^[0-9０-９]{8}$/.test(value.replace(/[ -]/g,'')))note('valid')}}
          style={{display:'block',width:'100%',boxSizing:'border-box',padding:12,fontSize:24,margin:'8px 0 12px',color:'inherit',background:'var(--dsw-alias-bg-layer-1, #111)',border:'1px solid #777',borderRadius:8}}/>
      </label>
      <button type="submit" disabled={busy||!validCode||!entryAllowed}>{busy?'正在连接…':'连接手机'}</button>
    </form>:null}
    <button type="button" disabled={busy} onClick={()=>{onCheck?.();recheck.current()}}>重新检查</button>
    {view?.canCancel?<button type="button" disabled={busy} onClick={()=>{void run('cancel',lease=>remote.cancel(lease))}}>取消本次配对</button>:null}
  </section>
}
