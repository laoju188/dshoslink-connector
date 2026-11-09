// This entry uses only Node built-ins: it also works when the connector cannot load.
// Read only fixed metadata, never identity/configuration/credentials or host logs.
import {lstatSync,readFileSync} from 'node:fs'
import {join,resolve,isAbsolute} from 'node:path'
import {homedir} from 'node:os'
import {randomBytes} from 'node:crypto'

const version=v=>typeof v==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[A-Za-z0-9.-]{1,40})?$/.test(v)?v:'unknown'
const errorCategory=e=>['EACCES','EPERM'].includes(e?.code)?'access_denied':e?.code==='ENOENT'?'not_found':e?.code==='ENOSPC'?'disk_full':'read_failed'
function inspect(root,parts,json=false){
  try{
    let path=root
    const parent=lstatSync(root)
    if(!parent.isDirectory()||parent.isSymbolicLink())return {state:'path_indirection'}
    for(let i=0;i<parts.length;i++){
      path=join(path,parts[i]);const stat=lstatSync(path)
      if(stat.isSymbolicLink())return {state:'path_indirection'}
      if(i<parts.length-1&&!stat.isDirectory())return {state:'invalid_type'}
      if(i===parts.length-1){
        if(!stat.isFile())return {state:'invalid_type'}
        if(!json)return {state:'present'}
        if(stat.size>4096)return {state:'too_large'}
        let value
        try{value=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''))}catch(e){return {state:e instanceof SyntaxError?'invalid_json':errorCategory(e)}}
        return {state:'present',value}
      }
    }
  }catch(e){return {state:errorCategory(e)}}
}
function safeInstallEvent(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined
  if(!['install','recovery'].includes(value.stage)||!['ok','failed'].includes(value.result)
    ||!['none','release_age','timeout','dns','network','process_crash','package','policy','verification'].includes(value.reason)
    ||(value.result==='ok')!==(value.reason==='none')||!Number.isSafeInteger(value.atMs)||value.atMs<0)return undefined
  return {stage:value.stage,result:value.result,reason:value.reason,atMs:value.atMs,version:version(value.version)}
}
export function collectDiagnostics(home,source='explicit'){
  const profile=join(resolve(home),'profiles','desktop')
  const profileManifest=inspect(profile,['package.json'],true)
  const installed=inspect(profile,['node_modules','@dshos-link','connector','package.json'],true)
  const runtime=inspect(profile,['node_modules','@dshos-link','connector','dist','index.js'])
  const recovery=inspect(profile,['.dshos-link','desktop-installer','balance-recovery-required.json'])
  const history=inspect(profile,['.dshos-link','desktop-installer','install-diagnostic-v1.json'],true)
  const reason=recovery.state==='present'?'dependency_recovery_required':installed.state==='not_found'?'connector_not_found'
    :installed.state==='present'&&runtime.state==='not_found'?'runtime_not_found':'needs_host_evidence'
  return {contract:'dshos-local-install-diagnostic-v1',reportId:randomBytes(12).toString('hex'),atMs:Date.now(),
    scope:source,profile:'desktop',reason,
    profileManifest:profileManifest.state,installedManifest:installed.state,installedVersion:version(installed.value?.version),
    runtime:runtime.state,recoveryMarker:recovery.state,installerHistory:history.state,
    ...safeInstallEvent(history.value?.last)?{lastInstall:safeInstallEvent(history.value.last)}:{},
    ...safeInstallEvent(history.value?.lastFailure)?{lastInstallFailure:safeInstallEvent(history.value.lastFailure)}:{},
    guidance:reason==='dependency_recovery_required'?'先退出DSH，再用原升级入口恢复依赖；不要删除配对资料。'
      :reason==='connector_not_found'?'未在所选目录找到插件；核对是否为实际DSH数据目录。'
      :reason==='runtime_not_found'?'插件目录缺少运行入口；保留资料并核对安装是否完成。'
      :'此报告仅检查固定安装资料；加载错误还需对应宿主的故障编号。路径引用等未检查项不代表安装损坏。',
    delivery:'仅生成本地脱敏报告，尚未发送。可将本报告提供给现有支持渠道；不要提供完整DSH日志或私钥。'}
}
export function diagnoseArguments(args=[],env=process.env){
  if(args.length!==0&&(args.length!==2||args[0]!=='--dsh-home'||!args[1]||/[\r\n\0]/.test(args[1])||!isAbsolute(args[1])))
    throw Error('诊断用法：diagnose [--dsh-home 原DSH数据目录的完整路径]')
  return collectDiagnostics(args[1]||env.DSH_HOME||join(homedir(),'.dsh'),args.length?'explicit':env.DSH_HOME?'environment':'default')
}
