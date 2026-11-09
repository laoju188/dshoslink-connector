import {useEffect,useRef,useState} from 'react'
import type {ServiceAccessView} from '../service-access.js'
type ServiceAccessResult={readonly ok:true;readonly value:ServiceAccessView}|{readonly ok:false;readonly error:unknown}
export interface ServiceAccessRemoteClient {status():Promise<ServiceAccessResult>;refresh():Promise<ServiceAccessResult>}
export function ServiceAccessPanel({remote}:{remote:ServiceAccessRemoteClient}):JSX.Element|null{
  const [view,setView]=useState<ServiceAccessView|null>(null),[busy,setBusy]=useState(false)
  const epoch=useRef(0)
  useEffect(()=>{let ended=false,pending=false;const generation=++epoch.current
    const read=async()=>{if(ended||pending||document.hidden)return;pending=true
      try{const result=await remote.status();if(result.ok&&!ended&&!document.hidden&&generation===epoch.current)setView(result.value)}catch{}finally{pending=false}}
    void read();const timer=setInterval(()=>void read(),1000)
    document.addEventListener('visibilitychange',read)
    return()=>{ended=true;epoch.current++;clearInterval(timer);document.removeEventListener('visibilitychange',read)}
  },[remote])
  if(!view?.needsCheck)return null
  const refresh=async()=>{if(busy||document.hidden||view.retryAfterMs>0)return;const generation=epoch.current;setBusy(true)
    try{const result=await remote.refresh();if(result.ok&&generation===epoch.current&&!document.hidden)setView(result.value)}catch{}
    finally{if(generation===epoch.current)setBusy(false)}}
  return <section aria-label="云服务状态" style={{padding:16,marginBottom:16,border:'1px solid var(--dsw-alias-border-l3, #777)',borderRadius:12}}>
    <p role="status">{view.message}</p>
    <button disabled={busy||view.checking||view.retryAfterMs>0} onClick={()=>void refresh()}>
      {busy||view.checking?'正在核对…':view.retryAfterMs>0?`${Math.ceil(view.retryAfterMs/1000)}秒后可核对`:'重新核对服务状态'}
    </button>
    <p>需要复核处理时，可使用下方“发送连接反馈”。请勿在公开群聊中发送账号凭据或私人资料。</p>
  </section>
}
