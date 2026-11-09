// Mirrored byte-for-byte in the server. No pairing or account authority is granted by this contract.
import {validAuthenticationTrace,type AuthenticationTrace} from './authentication-trace.js'
import { createPublicKey, verify } from 'node:crypto'
import { validStartupDiagnostic, type StartupDiagnostic } from './startup-diagnostic.js'
import {validWindowsLanDiagnostic,type WindowsLanDiagnostic} from './windows-lan-diagnostic-contract.js'
import { validMaintenanceDiagnostic, type MaintenanceDiagnostic } from './maintenance-diagnostic.js'
import { validCloudDiagnostic, validCloudPreparation,type CloudDiagnosticBody,type CloudDiagnosticPacket } from './cloud-pairing-diagnostic.js'

export const SUPPORT_OBSERVATION_CONTRACT = 'dshos-pairing-observation-v2'
export const SUPPORT_OBSERVATION_DOMAIN = 'PAIRING-OBSERVATION-DETAIL'
export const DESKTOP_FEEDBACK_CONTRACT = 'dshos-desktop-feedback-v1'
export const DESKTOP_FEEDBACK_DOMAIN = 'DESKTOP-FEEDBACK'
export const SUPPORT_OUTCOMES = ['open', 'cancelled', 'replaced', 'expired', 'interrupted', 'connected', 'failed', 'not_started'] as const
export const SUPPORT_ERRORS = ['none', 'pin_mismatch', 'unauthorized', 'invalid_request', 'expired', 'clock', 'identity_conflict', 'busy', 'unavailable', 'other', 'timeout'] as const
export const SUPPORT_STAGES = ['none', 'startup', 'preparation', 'request_validation', 'phone_start', 'computer_confirmation', 'phone_confirmation', 'registration', 'activation', 'authentication'] as const
export type SupportStage = typeof SUPPORT_STAGES[number]
export type SupportError = typeof SUPPORT_ERRORS[number]
export interface SupportObservationBody {
  contract: typeof SUPPORT_OBSERVATION_CONTRACT
  attemptId: string
  publicKey: string
  identityType: 'member' | 'temporary'
  sequence: number
  seen: number
  outcome: typeof SUPPORT_OUTCOMES[number]
  error: SupportError
  errorStage: SupportStage
  elapsedMs: number
  mode: 'initial' | 'resume' | 'unknown'
  pluginVersion: string
  startedAtMs: number
}
export interface SupportObservationPacket { body: SupportObservationBody; signature: string }
export const CONNECTION_STAGES = ['relay_binding','relay_ticket','relay_key','relay_socket','relay_peer','relay_handshake','relay_session','relay_notify','relay_notify_delivery','notification','access','startup','pairing_state_refresh'] as const
export const CONNECTION_RESULTS = ['ok','waiting','unavailable','unauthorized','rate_limited','failed','closed','retry_exhausted','expired','paused','timeout','not_required','replaced','legacy'] as const
export const NOTIFICATION_CAUSES = ['dns','connection_refused','connection_reset','network_unreachable','timeout','tls_certificate','tls_protocol','cancelled','unknown','heartbeat_lost','protocol_invalid','peer_closed','server_busy','credential_missing','identity_changed','host_stopped','authorization_rejected','service_restricted','replaced'] as const
export interface NotificationDetail { cause: typeof NOTIFICATION_CAUSES[number]; recovery: 'connecting'|'ready'|'retry_scheduled'|'wait_identity'|'wait_policy'|'stopped'; retryInMs?: number }
export function validNotificationDetail(v:unknown):v is NotificationDetail {
  return (supportFields(v,['cause','recovery'])||supportFields(v,['cause','recovery','retryInMs']))
    &&NOTIFICATION_CAUSES.includes(v.cause as NotificationDetail['cause'])
    &&['connecting','ready','retry_scheduled','wait_identity','wait_policy','stopped'].includes(v.recovery as string)
    &&(v.recovery==='retry_scheduled'?Number.isSafeInteger(v.retryInMs)&&(v.retryInMs as number)>=0&&(v.retryInMs as number)<=330000:!('retryInMs' in v))
}
export interface ConnectionEvent { detail?: NotificationDetail; stage: typeof CONNECTION_STAGES[number]; result: typeof CONNECTION_RESULTS[number]; atMs: number; routeId?: string }
export interface ConnectionSnapshot { events: ConnectionEvent[]; firstFailure: ConnectionEvent | null; lastFailure: ConnectionEvent | null }
function validConnectionEvent(value: unknown): value is ConnectionEvent {
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const v=value as Record<string,unknown>
  return supportFields(v,['stage','result','atMs',...('routeId' in v?['routeId']:[]),...('detail' in v?['detail']:[])])
    &&(!('detail' in v)||v.stage==='relay_notify'&&validNotificationDetail(v.detail))
    &&(!('routeId' in v)||typeof v.routeId==='string'&&/^[A-Za-z0-9_-]{22}$/.test(v.routeId)
      &&Buffer.from(v.routeId,'base64url').toString('base64url')===v.routeId&&typeof v.stage==='string'&&v.stage.startsWith('relay_'))
    &&CONNECTION_STAGES.includes(v.stage as ConnectionEvent['stage'])&&CONNECTION_RESULTS.includes(v.result as ConnectionEvent['result'])
    &&Number.isSafeInteger(v.atMs)&&(v.atMs as number)>=0
}
export function validConnectionSnapshot(value: unknown): value is ConnectionSnapshot {
  return supportFields(value, ['events','firstFailure','lastFailure']) && Array.isArray(value.events) && value.events.length <= 8
    && value.events.every(validConnectionEvent) && (value.firstFailure === null || validConnectionEvent(value.firstFailure))
    && (value.lastFailure === null || validConnectionEvent(value.lastFailure))
}
export interface DesktopPairingContext {
  newPairing: 'code'
  localBinding: 'loaded' | 'not_loaded'
}
export interface DesktopDiagnostic {
  authTraces?: AuthenticationTrace[]
  startup?: StartupDiagnostic
  networkDiscovery?: NetworkDiscoveryDiagnostic
  serviceAccess?: {mode:string;reason:string;caseId:string}
  lanCandidates?: LanCandidateDiagnostic
  pairingContext?: DesktopPairingContext
  windowsLan?: WindowsLanDiagnostic
  cloud?: CloudDiagnosticPacket
  cloudPreparation?: CloudDiagnosticBody
  maintenance?: MaintenanceDiagnostic
  connection?: ConnectionSnapshot
  dshVersion: string
  windowsVersion: string
  connectorState: 'PAUSED' | 'READY' | 'PORT_CONFLICT' | 'NO_PRIVATE_ADDRESS' | 'DSH_UNAVAILABLE' | 'REPAIRING' | 'RESTART_REQUIRED' | 'FAILED'
  failureStage: 'ACCESS_CONTROL' | 'NONE' | 'PAIRING_HTTPS' | 'BOOTSTRAP_HTTP' | 'CONFIGURATION' | 'NO_AVAILABLE_PAIR' | 'UNKNOWN' | 'SECURE_STORAGE_TIMEOUT' | 'SECURE_STORAGE' | 'IDENTITY' | 'STORAGE' | 'REGISTRATION'
}
export interface NetworkDiscoveryDiagnostic {
  result: 'ready'|'no_private_address'|'query_failed'|'invalid_result'|'timeout'
  candidateCount: number
  checkedAtMs: number
  detail?: {
    reason: keyof typeof NETWORK_DISCOVERY_REASONS
    addressClasses?: { private:number;shared:number;linkLocal:number;otherIpv4:number;nodeIpv6:number }
    counts?: { reportedAdapters:number;upAdapters:number;hardwareAdapters:number;ipv4:number;privateIpv4:number }
  }
}
export const NETWORK_DISCOVERY_REASONS = {
  candidates_ready:'已取得符合条件的局域网地址',no_connected_config:'系统没有返回联网的非虚拟网卡配置',
  no_active_adapter:'查询返回的网卡均未处于启用连接状态',no_active_hardware:'已连接配置中没有符合条件的实体网卡',
  no_ipv4:'符合条件的网卡没有IPv4地址',no_private_ipv4:'网卡有IPv4地址，但没有局域网私有地址',
  address_snapshot_mismatch:'系统返回的私有地址不在本进程当前网卡快照中',query_access_denied:'系统拒绝读取网卡配置',
  query_unavailable:'系统网卡查询命令不可用',query_failed:'系统网卡查询未完成，未取得更具体原因',
  query_timeout:'系统网卡查询等待超时',invalid_result:'系统网卡查询结果不符合格式或大小限制',
  interface_snapshot_failed:'本进程读取网卡快照失败'
} as const
export function validNetworkDiscoveryDiagnostic(value:unknown):value is NetworkDiscoveryDiagnostic {
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'detail' in value){
    const {detail,...base}=value
    if(!validNetworkDiscoveryDiagnostic(base)||detail===null||typeof detail!=='object'||Array.isArray(detail))return false
    const d=detail as Record<string,unknown>,keys=Object.keys(d).sort().join(',')
    if(!['reason','counts,reason','addressClasses,reason','addressClasses,counts,reason'].includes(keys)||typeof d.reason!=='string'||!Object.hasOwn(NETWORK_DISCOVERY_REASONS,d.reason))return false
    const allowed=base.result==='ready'?['candidates_ready']:base.result==='timeout'?['query_timeout']:base.result==='invalid_result'?['invalid_result']
      :base.result==='query_failed'?['query_access_denied','query_unavailable','query_failed','interface_snapshot_failed']
      :['no_connected_config','no_active_adapter','no_active_hardware','no_ipv4','no_private_ipv4','address_snapshot_mismatch']
    if(!allowed.includes(d.reason))return false
    if(d.addressClasses!==undefined){
      if(!supportFields(d.addressClasses,['private','shared','linkLocal','otherIpv4','nodeIpv6']))return false
      const a=d.addressClasses as unknown as NonNullable<NonNullable<NetworkDiscoveryDiagnostic['detail']>['addressClasses']>
      if(!Object.values(a).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=256)||a.private+a.shared+a.linkLocal+a.otherIpv4>64)return false
      if(d.counts&&((d.counts as {ipv4:number}).ipv4!==a.private+a.shared+a.linkLocal+a.otherIpv4||(d.counts as {privateIpv4:number}).privateIpv4!==a.private))return false
    }
    if(d.counts!==undefined){
      if(!supportFields(d.counts,['reportedAdapters','upAdapters','hardwareAdapters','ipv4','privateIpv4']))return false
      const c=d.counts as unknown as NonNullable<NonNullable<NetworkDiscoveryDiagnostic['detail']>['counts']>
      if(!Object.values(c).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=256)||c.ipv4>64||c.privateIpv4>c.ipv4||c.upAdapters>c.reportedAdapters
        ||c.hardwareAdapters>c.upAdapters||c.hardwareAdapters===0&&c.ipv4>0||base.candidateCount>c.privateIpv4)return false
      const reason=base.candidateCount>0?'candidates_ready':c.reportedAdapters===0?'no_connected_config':c.upAdapters===0?'no_active_adapter'
        :c.hardwareAdapters===0?'no_active_hardware':c.ipv4===0?'no_ipv4':c.privateIpv4===0?'no_private_ipv4':'address_snapshot_mismatch'
      if(d.reason!==reason)return false
    }
    return true
  }
  return supportFields(value,['result','candidateCount','checkedAtMs'])
    && ['ready','no_private_address','query_failed','invalid_result','timeout'].includes(value.result as string)
    && Number.isSafeInteger(value.candidateCount) && (value.candidateCount as number)>=0 && (value.candidateCount as number)<=3
    && (value.result==='ready' ? (value.candidateCount as number)>0 : value.candidateCount===0)
    && Number.isSafeInteger(value.checkedAtMs) && (value.checkedAtMs as number)>=0
}
export interface LanCandidateDiagnostic {
  candidateCount: number
  listeningCount: number
  lastFailure: 'none'|'port_conflict'|'address_unavailable'|'unknown'
  checkedAtMs: number
}
export function validLanCandidateDiagnostic(value:unknown):value is LanCandidateDiagnostic {
  if(!supportFields(value,['candidateCount','listeningCount','lastFailure','checkedAtMs']))return false
  const d=value as unknown as LanCandidateDiagnostic
  return Number.isSafeInteger(d.candidateCount)&&d.candidateCount>=0&&d.candidateCount<=3
    &&Number.isSafeInteger(d.listeningCount)&&d.listeningCount>=0&&d.listeningCount<=d.candidateCount
    &&['none','port_conflict','address_unavailable','unknown'].includes(d.lastFailure)
    &&Number.isSafeInteger(d.checkedAtMs)&&d.checkedAtMs>=0
}
export interface DesktopFeedbackBody {
  contract: typeof DESKTOP_FEEDBACK_CONTRACT
  requestId: string
  observation: SupportObservationPacket
  diagnostic: DesktopDiagnostic
  content: string
  submittedAtMs: number
}
export interface DesktopFeedbackPacket { body: DesktopFeedbackBody; signature: string }
export function supportFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === fields.join(',')
}
export function supportId(value: unknown, bytes = 16): value is string {
  return typeof value === 'string' && value.length === Math.ceil(bytes * 8 / 6) && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').length === bytes && Buffer.from(value, 'base64url').toString('base64url') === value
}
export function supportTranscript(domain: string, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value)), size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  return Buffer.concat([Buffer.from(`DSHOS-LINK/V2/${domain}\0`), size, body])
}
export function validSupportSignature(domain: string, body: unknown, publicKey: string, signature: unknown): boolean {
  try {
    return supportId(signature, 64) && verify(null, supportTranscript(domain, body),
      createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: publicKey } }), Buffer.from(signature, 'base64url'))
  } catch { return false }
}
const integer = (v: unknown, low: number, high: number): v is number => Number.isSafeInteger(v) && (v as number) >= low && (v as number) <= high
const version = (v: unknown): v is string => typeof v === 'string' && v.length <= 40
  && /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[a-zA-Z0-9.-]{1,20})?$/.test(v)
export function validSupportObservation(value: unknown, now: number): value is SupportObservationPacket {
  if (!supportFields(value, ['body', 'signature']) || !supportFields(value.body,
    ['contract','attemptId','publicKey','identityType','sequence','seen','outcome','error','errorStage','elapsedMs','mode','pluginVersion','startedAtMs'])) return false
  return validSupportBody(value.body, now)
    && validSupportSignature(SUPPORT_OBSERVATION_DOMAIN, value.body, value.body.publicKey, value.signature)
}
export function validSupportBody(value: unknown, now: number): value is SupportObservationBody {
  if (!supportFields(value, ['contract','attemptId','publicKey','identityType','sequence','seen','outcome','error','errorStage','elapsedMs','mode','pluginVersion','startedAtMs'])) return false
  const b = value
  if (b.contract !== SUPPORT_OBSERVATION_CONTRACT || !supportId(b.attemptId) || !supportId(b.publicKey, 32)
    || !['member','temporary'].includes(b.identityType as string) || !integer(b.sequence, 1, 48) || !integer(b.seen, 0, 127)
    || !SUPPORT_OUTCOMES.includes(b.outcome as SupportObservationBody['outcome']) || !SUPPORT_ERRORS.includes(b.error as SupportError)
    || !SUPPORT_STAGES.includes(b.errorStage as SupportStage) || !integer(b.elapsedMs, 0, 600000)
    || !['initial','resume','unknown'].includes(b.mode as string) || !version(b.pluginVersion)
    || !integer(b.startedAtMs, 0, Number.MAX_SAFE_INTEGER) || Math.abs(now - b.startedAtMs) > 86400000) return false
  const seen = b.seen
  // 64 means an identified START arrived; 2 means the signed START was accepted.
  if ((seen & 64) && !(seen & 1) || (seen & 2) && (seen & 65) !== 65 || (seen & 12) && !(seen & 2)
    || (seen & 16) && (seen & 15) !== 15 || (seen & 32) && seen !== 127
    || (b.outcome === 'connected') !== (seen === 127)
    || b.identityType === 'temporary' && (seen !== 0 || b.mode !== 'unknown')
    || b.identityType === 'member' && (!(seen & 1) && !(seen === 0 && b.outcome === 'not_started' && b.mode === 'resume') || b.mode === 'unknown')
    || (b.error === 'none') !== (b.errorStage === 'none')
    || b.outcome === 'failed' && (seen !== 0 || b.error === 'none')
    || b.outcome === 'not_started' && seen !== 0) return false
  return true
}
export function validDesktopDiagnostic(value: unknown): value is DesktopDiagnostic {
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'authTraces' in value){
    const {authTraces,...base}=value
    return Array.isArray(authTraces)&&authTraces.length<=3&&authTraces.every(t=>validAuthenticationTrace(t)&&t.role==='desktop')&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'startup' in value){
    const {startup,...base}=value
    return validStartupDiagnostic(startup)&&validDesktopDiagnostic(base)&&base.connectorState==='FAILED'&&base.failureStage!=='NONE'
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'networkDiscovery' in value){
    const {networkDiscovery,...base}=value
    return validNetworkDiscoveryDiagnostic(networkDiscovery)&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'serviceAccess' in value){
    const {serviceAccess,...base}=value
    return validServiceAccessDiagnostic(serviceAccess)&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'lanCandidates' in value){
    const {lanCandidates,...base}=value
    return validLanCandidateDiagnostic(lanCandidates)&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'pairingContext' in value){
    const {pairingContext,...base}=value
    return supportFields(pairingContext,['newPairing','localBinding'])&&pairingContext.newPairing==='code'
      &&['loaded','not_loaded'].includes(pairingContext.localBinding as string)&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'windowsLan' in value){
    const {windowsLan,...base}=value
    return validWindowsLanDiagnostic(windowsLan)&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'cloudPreparation' in value){
    const {cloudPreparation,...base}=value
    return !('cloud' in base)&&validCloudPreparation(cloudPreparation)&&cloudPreparation.role==='desktop'&&validDesktopDiagnostic(base)
  }
  if(value!==null&&typeof value==='object'&&!Array.isArray(value)&&'cloud' in value){
    const {cloud,...base}=value
    return validCloudDiagnostic(cloud)&&cloud.body.role==='desktop'&&validDesktopDiagnostic(base)
  }
  if (!supportFields(value, ['dshVersion','windowsVersion','connectorState','failureStage'])
    && !supportFields(value, ['dshVersion','windowsVersion','connectorState','failureStage','connection'])
    && !supportFields(value, ['dshVersion','windowsVersion','connectorState','failureStage','maintenance'])
    && !supportFields(value, ['dshVersion','windowsVersion','connectorState','failureStage','connection','maintenance'])) return false
  if ('maintenance' in value && !validMaintenanceDiagnostic(value.maintenance)) return false
  if ('connection' in value && !validConnectionSnapshot(value.connection)) return false
  return (version(value.dshVersion) || ['UNAVAILABLE','UNSUPPORTED'].includes(value.dshVersion as string))
    && typeof value.windowsVersion === 'string' && (value.windowsVersion === 'UNAVAILABLE'
      || /^[0-9]{1,5}(?:\.[0-9]{1,6}){1,3}$/.test(value.windowsVersion))
    && ['PAUSED','READY','PORT_CONFLICT','NO_PRIVATE_ADDRESS','DSH_UNAVAILABLE','REPAIRING','RESTART_REQUIRED','FAILED'].includes(value.connectorState as string)
    && ['ACCESS_CONTROL','NONE','PAIRING_HTTPS','BOOTSTRAP_HTTP','CONFIGURATION','NO_AVAILABLE_PAIR','UNKNOWN','SECURE_STORAGE_TIMEOUT','SECURE_STORAGE','IDENTITY','STORAGE','REGISTRATION'].includes(value.failureStage as string)
}
export function validFeedbackContent(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2000 && value.trim() === value
    && /[\p{L}\p{N}\p{P}\p{S}]/u.test(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
}
export function validDesktopFeedback(value: unknown, now: number): value is DesktopFeedbackPacket {
  if (!supportFields(value, ['body','signature']) || !supportFields(value.body,
    ['contract','requestId','observation','diagnostic','content','submittedAtMs'])) return false
  const b = value.body
  if (b.contract!==DESKTOP_FEEDBACK_CONTRACT || !supportId(b.requestId) || !validSupportObservation(b.observation, now)
    || !validDesktopDiagnostic(b.diagnostic) || !validFeedbackContent(b.content)
    || !integer(b.submittedAtMs, 0, Number.MAX_SAFE_INTEGER) || Math.abs(now - b.submittedAtMs) > 600000) return false
  if(b.contract===DESKTOP_FEEDBACK_CONTRACT&&b.diagnostic.serviceAccess!==undefined)return false
  return validSupportSignature(DESKTOP_FEEDBACK_DOMAIN, b, b.observation.body.publicKey, value.signature)
}
export function validServiceAccessDiagnostic(value:unknown):value is {mode:string;reason:string;caseId:string}{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='caseId,mode,reason')return false
  const v=value as {mode:unknown;reason:unknown;caseId:unknown}
  return ['relay_paused','pairing_and_relay_paused'].includes(v.mode as string)&&
    ['verified_abuse','account_security','legal_requirement'].includes(v.reason as string)&&
    typeof v.caseId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v.caseId)
}
