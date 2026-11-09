// Fixed, bounded facts only; never raw exceptions, URLs, commands or paths.
export const UPDATE_REASONS = ['none','timeout','dns','connection','tls','http','rate_limited','redirect','response','unknown'] as const
export type UpdateReason = typeof UPDATE_REASONS[number]
export interface UpdateEvent { atMs:number; result:'ok'|'failed'; reason:UpdateReason; attempts:number; elapsedMs:number }
export interface InstallEvent { stage:'install'|'recovery'; result:'ok'|'failed'; reason:'none'|'release_age'|'timeout'|'dns'|'network'|'process_crash'|'package'|'policy'|'verification'; atMs:number; elapsedMs:number; exitCode:number; version:string }
export interface MaintenanceHistory<T> { last:T; lastFailure:T|null }
export interface MaintenanceDiagnostic { updateUi?:{atMs:number;reason:'host_bridge'}; update?:MaintenanceHistory<UpdateEvent>; install?:MaintenanceHistory<InstallEvent> }
const fields=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',')
const integer=(v:unknown,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=max
export function validUpdateEvent(v:unknown):v is UpdateEvent {
  return fields(v,['atMs','result','reason','attempts','elapsedMs'])&&integer(v.atMs)&&['ok','failed'].includes(v.result as string)
    &&UPDATE_REASONS.includes(v.reason as UpdateReason)&&(v.result==='ok')===(v.reason==='none')
    &&integer(v.attempts,2)&&(v.attempts as number)>=1&&integer(v.elapsedMs,30000)
}
export function validInstallEvent(v:unknown):v is InstallEvent {
  return fields(v,['stage','result','reason','atMs','elapsedMs','exitCode','version'])&&['install','recovery'].includes(v.stage as string)
    &&['ok','failed'].includes(v.result as string)&&['none','release_age','timeout','dns','network','process_crash','package','policy','verification'].includes(v.reason as string)
    &&(v.result==='ok')===(v.reason==='none')&&integer(v.atMs)&&integer(v.elapsedMs,3600000)
    &&Number.isSafeInteger(v.exitCode)&&Math.abs(v.exitCode as number)<=4294967295&&typeof v.version==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v.version)
}
export function validHistory<T extends {result:string}>(v:unknown,valid:(v:unknown)=>v is T):v is MaintenanceHistory<T> {
  return fields(v,['last','lastFailure'])&&valid(v.last)&&(v.lastFailure===null||valid(v.lastFailure)&&v.lastFailure.result==='failed')
}
export function validMaintenanceDiagnostic(v:unknown):v is MaintenanceDiagnostic {
  if(!v||typeof v!=='object'||Array.isArray(v))return false
  const keys=Object.keys(v)
  return keys.length>0&&keys.every(k=>k==='update'||k==='install'||k==='updateUi')
    &&(!('updateUi' in v)||fields(v.updateUi,['atMs','reason'])&&integer(v.updateUi.atMs)&&v.updateUi.reason==='host_bridge')
    &&(!('update' in v)||validHistory(v.update,validUpdateEvent))&&(!('install' in v)||validHistory(v.install,validInstallEvent))
}
