import { useEffect, useState, useRef } from 'react'
import type { ConnectorUpdateSnapshot } from '../connector-update.js'

import { connectorUpdateState, knownUpdate, type ConnectorUpdateRemoteClient } from './connector-update-state.js'
import { isNewerStableVersion } from './update-version.js'
export type { ConnectorUpdateRemoteClient } from './connector-update-state.js'

export function ConnectorUpdateNotice({ remote, floating = false }: {
  readonly remote: ConnectorUpdateRemoteClient; readonly floating?: boolean
}): JSX.Element | null {
  const store=connectorUpdateState(remote)
  const [state,setState]=useState<ConnectorUpdateSnapshot|null>(store.snapshot())
  const [dismissed,setDismissed]=useState(false),[instructions,setInstructions]=useState(false)
  const [upgrading,setUpgrading]=useState(false),[upgradeMessage,setUpgradeMessage]=useState('')
  const action=useRef({epoch:0,busy:false})
  useEffect(()=>{
    action.current={epoch:action.current.epoch+1,busy:false}
    setState(store.snapshot());setDismissed(false);setInstructions(false);setUpgrading(false);setUpgradeMessage('')
    const unsubscribe=store.subscribe(()=>setState(store.snapshot()))
    void store.load()
    return ()=>{action.current={epoch:action.current.epoch+1,busy:false};unsubscribe()}
  },[store])
  const busy=state?.status==='checking'
  const available=state?knownUpdate(state):false
  const currentRelease=state?.status==='current'&&state.currentVersion===state.latestVersion
  const aheadOfRelease=state?.status==='current'&&isNewerStableVersion(state.latestVersion,state.currentVersion)
  const upgrade=async()=>{
    if(action.current.busy||!remote.upgrade)return
    const epoch=action.current.epoch;action.current.busy=true
    const owns=()=>epoch===action.current.epoch
    setUpgrading(true);setUpgradeMessage('正在准备更新，请保持桌面开启…')
    try{
      const result=await remote.upgrade()
      if(!owns())return
      if(result.ok&&result.value.started){
        window.dispatchEvent(new Event('dshos-upgrade-started'))
        setUpgradeMessage('更新已开始，请查看更新进度。')
      }else {
        const reason=result.ok?result.value.reason:''
        if(['host-not-supported','host-api-unavailable','updater-not-ready'].includes(reason))setInstructions(true)
        setUpgradeMessage(reason==='restart-required'?'升级组件已安装，请正常退出 DSH 后重新打开，再点击立即更新。'
          :reason==='host-not-supported'||reason==='host-api-unavailable'?'已发现新版，但当前 DSH 暂不支持在页面内安装。请按下方步骤升级，原配对和会话会保留。'
          :reason==='host-changed'||reason==='profile-changed'?'DSH 环境发生变化，已停止自动更新。请重新打开桌面后再检查。'
          :reason==='updater-not-ready'?'升级组件暂不可用，请查看下方升级步骤；已有资料会保留。'
          :reason==='tasks-running'?'电脑仍有任务运行，请等待任务完成后再更新。'
          :reason==='pairing-busy'?'正在配对，请完成配对后再更新。'
          :reason==='journal-unavailable'?'升级记录需要检查，已停止自动安装。请查看更新进度中的说明。'
          :'暂时无法自动更新，原插件仍保留。可以稍后重试或查看原升级方式。')
      }
    }catch{if(owns())setUpgradeMessage('暂时无法确认更新结果，请先查看更新进度，不要重复安装。')}
    finally{if(owns()){action.current.busy=false;setUpgrading(false)}}
  }
  if(!state||dismissed||(floating&&busy))return null
  const buttonStyle = { minHeight: 36, padding: '6px 14px', borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l3, #cbd5df)',
    background: 'var(--dsw-alias-bg-layer-1, #eaf0f6)', color: 'inherit', cursor: 'pointer' }
  return <aside role="status" aria-live="polite" data-dshos-update={state.status} style={{
    ...(floating ? { position: 'absolute', top: 'var(--dsh-frame-overlay-top, 20px)', right: 20, zIndex: 30,
      width: 760, maxWidth: 'calc(100% - 40px)', boxSizing: 'border-box', maxHeight: 'calc(100% - var(--dsh-frame-overlay-top, 20px) - 20px)', overflowY: 'auto' } as const : {}),
    border: '1px solid var(--dsw-alias-border-l3, #cbd5df)', borderRadius: 14, padding: 16,
    background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #253344)',
    boxShadow: floating ? '0 6px 24px #0002' : undefined, marginBottom: floating ? 0 : 16,
  }}>
    <div style={{ display: floating ? 'flex' : 'block', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
    <div style={{ flex: '1 1 280px', minWidth: 0 }}>
    <strong>{available ? `DSHOS Link 有新版本 ${state.latestVersion}` : currentRelease ? 'DSHOS Link 插件目前已是最新版本' : 'DSHOS Link 更新检查'}</strong>
    <p style={{ margin: '8px 0', fontSize: 13 }}>当前 {state.currentVersion}。{busy ? '正在检查可升级版本…' :
      state.status==='unavailable' && available ? '本次检查未完成，可重试检查或查看原升级方式。' : available ? '更新时手机会短暂断开连接，配对资料和电脑会话会保留。' : currentRelease ? '本次检查未发现更新的正式版本。' :
      aheadOfRelease ? `当前版本高于正式发行版 ${state.latestVersion}，无需更新。` : state.status === 'current' ? `最新正式版本为 ${state.latestVersion}，与当前版本不同。` :
      '暂时未能获取版本信息，可以稍后重试。'}</p>
    </div>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {(!floating || state.status === 'unavailable') && <button type="button" style={buttonStyle} disabled={busy} onClick={() => void store.check()}>{busy ? '正在检查…' : '检查更新'}</button>}
      {available && !busy && remote.upgrade && <button type="button" style={buttonStyle} disabled={upgrading||state.status!=='available'} onClick={()=>void upgrade()}>{upgrading?'正在准备…':'立即更新'}</button>}
      {available && !busy && <button type="button" style={buttonStyle} disabled={upgrading}
        onClick={() => setInstructions(value => !value)}>{instructions ? '收起说明' : '查看升级步骤'}</button>}
      {floating && <button type="button" style={buttonStyle} onClick={() => setDismissed(true)}>{available ? '稍后' : '关闭'}</button>}
    </div>
    {upgradeMessage&&<p>{upgradeMessage}</p>}
    </div>
    {instructions && available && <p style={{ margin: '8px 0', fontSize: 13, lineHeight: 1.6 }}>
      结束正在运行的任务并退出 DSH 桌面版后，在终端执行以下命令。完成后重新打开桌面版，原配对和会话会保留。
      <code style={{ display: 'block', paddingTop: 8, overflowWrap: 'anywhere' }}>npx --yes @dshos-link/connector@{state.latestVersion} upgrade --profile desktop</code>
      如原安装使用了自定义数据目录，请沿用原命令的目录参数。
    </p>}
  </aside>
}
