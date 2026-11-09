import { useEffect, useRef, useState } from 'react'
import { feedbackButtonState, type PairingSupportRemoteClient } from './feedback-button-state.js'
export type { PairingSupportRemoteClient } from './feedback-button-state.js'

export function PairingSupportPanel({remote}:{remote:PairingSupportRemoteClient}):JSX.Element {
  const controller=feedbackButtonState(remote)
  const [state,setState]=useState(controller.snapshot())
  const [now,setNow]=useState(Date.now())
  const [checking,setChecking]=useState(false)
  const [lanMessage,setLanMessage]=useState('')
  const checkEpoch=useRef(0)
  useEffect(()=>{checkEpoch.current++;setChecking(false);setLanMessage('');return()=>{checkEpoch.current++}},[remote])
  const checkLan=async()=>{
    if(checking||!remote.checkLan)return
    const epoch=checkEpoch.current
    setChecking(true)
    try{
      const result=await remote.checkLan()
      if(epoch!==checkEpoch.current)return
      if(!result.ok)throw Error('check_unavailable')
      setLanMessage(result.value.message+' '+result.value.nextStep)
    }catch{if(epoch===checkEpoch.current)setLanMessage('暂未完成只读检查，可发送连接反馈。原配对保持，不会更改防火墙。')}
    finally{if(epoch===checkEpoch.current)setChecking(false)}
  }
  useEffect(()=>{
    setState(controller.snapshot())
    const unsubscribe=controller.subscribe(()=>setState(controller.snapshot()))
    void controller.refresh()
    const timer=setInterval(()=>{setNow(Date.now());if(controller.snapshot().busy)void controller.refresh()},1000)
    return()=>{unsubscribe();clearInterval(timer)}
  },[controller])
  const seconds=Math.min(60,Math.max(0,Math.ceil((state.retryAt-now)/1000))),disabled=state.busy||seconds>0
  return <section aria-label="连接问题反馈" style={{padding:16,marginTop:16,borderRadius:12,
    border:'1px solid var(--dsw-alias-border-l3, #cbd5df)',color:'var(--dsw-alias-label-primary, #253344)'}}>
    <p style={{margin:'0 0 12px',lineHeight:1.6}}>配对或连接遇到问题？点一下，把连接情况反馈给我们，帮助我们排查和改进。</p>
    <button type="button" disabled={disabled} onClick={()=>void controller.send()} style={{minHeight:36,padding:'6px 16px',borderRadius:8,
      border:'1px solid var(--dsw-alias-border-l3, #cbd5df)',background:'var(--dsw-alias-bg-layer-1, #eaf0f6)',color:'inherit',cursor:disabled?'default':'pointer'}}>
      {state.busy?'正在发送…':seconds>0?`${seconds}秒后可再发送`:'发送连接反馈'}
    </button>
    {remote.checkLan&&<button type="button" disabled={checking} onClick={()=>void checkLan()}
      style={{marginLeft:12,minHeight:36,padding:'6px 12px',borderRadius:8,border:'1px solid var(--dsw-alias-border-l3, #cbd5df)',background:'transparent',color:'inherit'}}>
      {checking?'正在只读检查…':'检查局域网连接'}
    </button>}
    {lanMessage&&<p role="status" aria-live="polite" style={{fontSize:13,lineHeight:1.6}}>{lanMessage}</p>}
    {state.message&&<p role="status" aria-live="polite" style={{margin:'10px 0 0',fontSize:13,lineHeight:1.5}}>{state.message}</p>}
    <div style={{marginTop:20,paddingTop:16,borderTop:'1px solid var(--dsw-alias-border-l3, #cbd5df)',lineHeight:1.6}}>
      <p style={{margin:'0 0 6px',fontWeight:600}}>抖音群交流与反馈</p>
      <p style={{margin:'0 0 6px'}}>抖音群号：659852356847</p>
      <p style={{margin:0,fontSize:13}}>欢迎加入抖音群，反馈使用问题、提出需求和改进建议，我们会查看并回复。</p>
    </div>
  </section>
}
