// Mirrored in the service. Diagnostic references confer no pairing/account authority.
import { createHash } from 'node:crypto'
import { validTraceDetail, type TraceDetail } from './pairing-trace-detail.js'
import { SUPPORT_OBSERVATION_CONTRACT, SUPPORT_ERRORS, supportFields, supportId, validSupportBody,
  validSupportSignature, validDesktopDiagnostic, validFeedbackContent, validDesktopFeedback,
  type SupportObservationBody, type SupportError, type DesktopDiagnostic, type DesktopFeedbackPacket } from './pairing-support-contract.js'

export const TRACE_CONTRACT = 'dshos-pairing-observation-v3'
export const DETAILED_TRACE_CONTRACT = 'dshos-pairing-observation-v4'
export const TRACE_DOMAIN = 'PAIRING-OBSERVATION-TRACE'
export const TRACE_FEEDBACK_CONTRACT = 'dshos-desktop-feedback-v2'
export const ACCESS_TRACE_FEEDBACK_CONTRACT = 'dshos-desktop-feedback-v3'
export const TRACE_FEEDBACK_DOMAIN = 'DESKTOP-FEEDBACK-TRACE'
export const PREPARATION_STAGES = ['preparation_lock','preparation_recovery','preparation_read','preparation_check',
  'preparation_directory','preparation_save','preparation_service','preparation_invitation','preparation_release'] as const
export type PreparationStage = typeof PREPARATION_STAGES[number]
export const TRACE_STAGES = ['none','startup',...PREPARATION_STAGES,'preparation','qr_display','bootstrap','secure_channel','desktop_check',
  'request_validation','phone_start','computer_confirmation','phone_confirmation','registration','activation','authentication'] as const
export type TraceStage = typeof TRACE_STAGES[number]
export interface PairingTrace {
  detail?: TraceDetail
  operationId: string
  parentAttemptId: string
  trigger: 'user' | 'refresh'
  invitationRef: string
  display: 'unknown' | 'shown' | 'failed'
  address: 'unknown' | 'current' | 'changed'
  // Listener-wide, unattributed observations. Never evidence that THIS phone arrived.
  listenerSignals: number
  lastSuccess: TraceStage
  blockingStage: TraceStage
  blockingError: SupportError
  recoveredErrors: number
  timings: [TraceStage, number][]
}
export interface TraceObservationBody extends Omit<SupportObservationBody, 'contract'> {
  contract: typeof TRACE_CONTRACT | typeof DETAILED_TRACE_CONTRACT
  trace: PairingTrace
}
export interface TraceObservationPacket { body: TraceObservationBody; signature: string }
export interface TraceFeedbackBody {
  contract: typeof TRACE_FEEDBACK_CONTRACT | typeof ACCESS_TRACE_FEEDBACK_CONTRACT
  requestId: string
  observation: TraceObservationPacket
  diagnostic: DesktopDiagnostic
  content: string
  submittedAtMs: number
}
export interface TraceFeedbackPacket { body: TraceFeedbackBody; signature: string }
export type AnyDesktopFeedbackPacket = DesktopFeedbackPacket | TraceFeedbackPacket
export const LISTENER_SIGNALS = { bootstrapServed: 1, bootstrapRejected: 2, tlsEstablished: 4, tlsFailed: 8,
  capabilityServed: 16, capabilityRejected: 32, requestRejected: 64, requestAborted: 128 } as const

// SHA-256(domain UTF-8 + NUL + raw 16-byte sid + raw 32-byte member public key).
// All inputs already public. The QR secret is deliberately NOT an input.
export function pairingInvitationRef(sid: string, memberPublicKey: string): string {
  if (!supportId(sid) || !supportId(memberPublicKey,32)) throw Error('invalid_invitation_reference')
  return createHash('sha256').update('DSHOS-LINK/PAIRING-REFERENCE/V1\0')
    .update(Buffer.from(sid,'base64url')).update(Buffer.from(memberPublicKey,'base64url')).digest('base64url')
}
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number)>=0 && (value as number)<=max
export function validPairingTrace(value: unknown, elapsedMs: number): value is PairingTrace {
  const detailed = value !== null && typeof value === 'object' && 'detail' in value
  if (!supportFields(value,['operationId','parentAttemptId','trigger','invitationRef','display','address','listenerSignals',
    'lastSuccess','blockingStage','blockingError','recoveredErrors','timings',...(detailed?['detail']:[])])) return false
  if (detailed && !validTraceDetail(value.detail,elapsedMs)) return false
  if (!supportId(value.operationId) || !['user','refresh'].includes(value.trigger as string)
    || (value.trigger==='user' ? value.parentAttemptId!=='' : !supportId(value.parentAttemptId))
    || value.invitationRef!=='' && !supportId(value.invitationRef,32)
    || !['unknown','shown','failed'].includes(value.display as string) || !['unknown','current','changed'].includes(value.address as string)
    || !integer(value.listenerSignals,255) || !TRACE_STAGES.includes(value.lastSuccess as TraceStage)
    || !TRACE_STAGES.includes(value.blockingStage as TraceStage) || !SUPPORT_ERRORS.includes(value.blockingError as SupportError)
    || (value.blockingStage==='none') !== (value.blockingError==='none') || !integer(value.recoveredErrors,32)
    || !Array.isArray(value.timings) || value.timings.length>TRACE_STAGES.length-1) return false
  const stages = new Set<string>()
  let previous = -1
  for (const item of value.timings) {
    if (!Array.isArray(item) || item.length!==2 || !TRACE_STAGES.includes(item[0]) || item[0]==='none'
      || stages.has(item[0]) || !integer(item[1],elapsedMs) || item[1]<previous) return false
    previous=item[1];stages.add(item[0])
  }
  const furthest=TRACE_STAGES.filter(stage=>stages.has(stage)).at(-1)??'none'
  return value.lastSuccess===furthest
}
export function validTraceObservation(value: unknown, now: number): value is TraceObservationPacket {
  if (!supportFields(value,['body','signature']) || !supportFields(value.body,
    ['contract','attemptId','publicKey','identityType','sequence','seen','outcome','error','errorStage','elapsedMs','mode','pluginVersion','startedAtMs','trace'])) return false
  const b=value.body
  const detailed=b.contract===DETAILED_TRACE_CONTRACT
  // v4 counts signed local revisions, not uploads: explicit feedback may capture
  // new facts after automatic reporting is capped. Legacy sequence limits stay.
  if(detailed&&(!integer(b.sequence,Number.MAX_SAFE_INTEGER)||b.sequence<1))return false
  const core={contract:SUPPORT_OBSERVATION_CONTRACT,attemptId:b.attemptId,publicKey:b.publicKey,identityType:b.identityType,
    sequence:detailed?1:b.sequence,seen:b.seen,outcome:b.outcome,error:b.error,errorStage:b.errorStage,elapsedMs:b.elapsedMs,
    mode:b.mode,pluginVersion:b.pluginVersion,startedAtMs:b.startedAtMs}
  return [TRACE_CONTRACT,DETAILED_TRACE_CONTRACT].includes(b.contract as typeof TRACE_CONTRACT)
    && validSupportBody(core,now) && validPairingTrace(b.trace,core.elapsedMs)
    && (b.contract===DETAILED_TRACE_CONTRACT)===(b.trace.detail!==undefined)
    && (core.identityType!=='temporary' || b.trace.invitationRef==='')
    && (core.outcome!=='connected' || b.trace.blockingStage==='none')
    && Buffer.byteLength(JSON.stringify(value))<=(b.contract===DETAILED_TRACE_CONTRACT?4096:2048)
    && validSupportSignature(TRACE_DOMAIN,b,core.publicKey,value.signature)
}
export function validAnyDesktopFeedback(value: unknown, now: number): value is AnyDesktopFeedbackPacket {
  if (validDesktopFeedback(value,now)) return true
  if (!supportFields(value,['body','signature']) || !supportFields(value.body,
    ['contract','requestId','observation','diagnostic','content','submittedAtMs'])) return false
  const b=value.body
  return [TRACE_FEEDBACK_CONTRACT,ACCESS_TRACE_FEEDBACK_CONTRACT].includes(b.contract as string)
    && (b.contract===ACCESS_TRACE_FEEDBACK_CONTRACT)===(b.diagnostic!==null&&typeof b.diagnostic==='object'&&'serviceAccess' in b.diagnostic)
    && supportId(b.requestId) && validTraceObservation(b.observation,now)
    && validDesktopDiagnostic(b.diagnostic) && validFeedbackContent(b.content) && integer(b.submittedAtMs,Number.MAX_SAFE_INTEGER)
    // An explicit retry keeps the exact signed request and its idempotency key.
    // The legacy v1 contract keeps its original ten-minute window.
    && b.submittedAtMs<=now+600000 && now-b.submittedAtMs<=86400000
    && validSupportSignature(TRACE_FEEDBACK_DOMAIN,b,b.observation.body.publicKey,value.signature)
}
