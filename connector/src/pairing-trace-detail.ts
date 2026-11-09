// Mirrored in the service. Fixed diagnostic vocabulary, never authorization.
import { supportFields, SUPPORT_ERRORS, type SupportError } from './pairing-support-contract.js'
import { TRACE_STAGES, type TraceStage } from './pairing-trace-contract.js'
export const TRACE_CAUSES = ['none','unknown','address_changed','protection_failed','unsafe_path','record_invalid','access_denied',
  'deadline_or_cancel','phone_key_changed','unconfirmed_restart','nonce_replay','record_mismatch','recovery_required',
  'instance_in_use','invalid_signature','expired','clock','busy','service_unavailable'] as const
export type TraceCause = typeof TRACE_CAUSES[number]
export interface TraceDetail {
  first: [TraceStage, SupportError, TraceCause, number] | null
  events: [number, TraceStage, 'ok' | 'failed', TraceCause, number][]
  omitted: number
  storage: [string, string, number, number, string, TraceCause] | null
  reads: number
  decryptions: number
  reused: number
}
export function traceCause(error: unknown): TraceCause {
  const message = error instanceof Error ? error.message : ''
  const known: Record<string,TraceCause> = {enrollment_address_changed:'address_changed',registration_windows:'protection_failed',
    registration_reparse:'unsafe_path',registration_format:'record_invalid',enrollment_cancelled:'deadline_or_cancel',registration_timeout:'deadline_or_cancel',
    enrollment_scope_phone_key:'phone_key_changed',enrollment_scope_unconfirmed_restart:'unconfirmed_restart',
    enrollment_scope_nonce_replay:'nonce_replay',enrollment_scope:'record_mismatch',
    enrollment_recovery_required:'recovery_required',enrollment_dsh_instance_in_use:'instance_in_use',
    enrollment_unauthorized:'invalid_signature',enrollment_expired:'expired',enrollment_clock:'clock',
    enrollment_busy:'busy',enrollment_unavailable:'service_unavailable'}
  return known[message] ?? 'unknown'
}
const integer=(v:unknown,max:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=max
export function validTraceDetail(v:unknown, elapsed:number):v is TraceDetail {
  if (!supportFields(v,['first','events','omitted','storage','reads','decryptions','reused'])
    || !integer(v.omitted,65535) || !integer(v.reads,65535) || !integer(v.decryptions,65535) || !integer(v.reused,65535)
    || !Array.isArray(v.events) || v.events.length>8) return false
  const first=v.first
  if(first!==null&&(!Array.isArray(first)||first.length!==4||!TRACE_STAGES.includes(first[0])||first[0]==='none'
    ||!SUPPORT_ERRORS.includes(first[1])||first[1]==='none'||!TRACE_CAUSES.includes(first[2])||first[2]==='none'||!integer(first[3],elapsed)))return false
  let n=v.omitted,at=0
  for(const e of v.events){
    if(!Array.isArray(e)||e.length!==5||e[0]!==++n||!TRACE_STAGES.includes(e[1])||e[1]==='none'
      ||!['ok','failed'].includes(e[2])||!TRACE_CAUSES.includes(e[3])||(e[2]==='ok')!==(e[3]==='none')
      ||e[2]==='failed'&&(first===null||e[4]<first[3])||!integer(e[4],elapsed)||e[4]<at)return false
    at=e[4]
  }
  const s=v.storage
  return s===null || Array.isArray(s)&&s.length===6
    &&['material','source','intent','pairing_intent','registry','activation','recovery'].includes(s[0])
    &&['path','read','decode','decrypt','validate','encrypt','write'].includes(s[1])
    &&integer(s[2],600000)&&integer(s[3],8000)&&['pending','ok','cached','failed'].includes(s[4])&&TRACE_CAUSES.includes(s[5])
    &&(s[4]==='failed')!==(s[5]==='none')
}
