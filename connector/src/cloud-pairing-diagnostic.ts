import {validEntry,type PairingEntryObservation} from './pairing-entry-observation.js';
import {validAuthenticationTrace,type AuthenticationTrace} from './authentication-trace.js';
import { cloudFields, cloudVerify } from './cloud-pairing-contract.js';
import { registrationId } from './dsh-registration-contract.js';

export const CLOUD_DIAGNOSTIC_STAGES = ['capabilities','login','service_trust','identity_read','identity_key','identity_save',
  'code_received','code_visible','entry_ready','claim_submit','code_input','create','recover','resolve','claim','status','approve','reject','cancel','prepare','proof','finalize','saved','current',
  'publish','connect','desktop_activation','relay_bootstrap','relay_authentication','first_authentication','local_activation'] as const;
export const CLOUD_DIAGNOSTIC_REASONS = ['none','network','timeout','tls','login','rate_limited','storage','storage_busy','identity_conflict',
  'proof','expired','cancelled','service','unavailable','invalid_code','active_attempt_exists','unknown'] as const;
export const CLOUD_STORAGE_CAUSES = ['busy','lock_lost','record_invalid','unsafe_path','protection_failed','access_denied','disk_full','io_failed','unavailable','unknown'] as const;
export const CLOUD_OPERATIONS = ['request','verify_response','read_relay','read_relay_key','decrypt_relay','save_relay_root','save_relay_credential','acknowledge'] as const;
export const CLOUD_TRANSPORT_CAUSES = ['dns','connection_refused','connection_reset','network_unreachable','timeout','tls_certificate','tls_protocol','cancelled','unknown'] as const;
export interface CloudDiagnosticStep { operation?: typeof CLOUD_OPERATIONS[number]; transport?: typeof CLOUD_TRANSPORT_CAUSES[number]; cause?: typeof CLOUD_STORAGE_CAUSES[number]; stage: string; outcome: string; reason: string; elapsedMs: number; attempts: number; }
export interface CloudDiagnosticBody {
  contract: 'dshos-cloud-pairing-diagnostic-v1'|'dshos-cloud-pairing-diagnostic-v2'|'dshos-cloud-pairing-diagnostic-v3'|'dshos-cloud-pairing-diagnostic-v4'; product: 'harmony-dsh'; environment: 'PRODUCTION'|'SANDBOX';
  role: 'phone'|'desktop'; operationId: string; attemptId: string; claimId: string; version: string;
  startedAtMs: number; elapsedMs: number; revision: number; state: string;
  entry?: PairingEntryObservation;
  authTrace?: AuthenticationTrace;
  steps: CloudDiagnosticStep[]; firstFailure: CloudDiagnosticStep|null; lastFailure: CloudDiagnosticStep|null;
}
export interface CloudDiagnosticPacket { body: CloudDiagnosticBody; publicKey: string; signature: string; }
const integer=(v:unknown,max:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=0&&(v as number)<=max;
function step(v:unknown,elapsed:number,details:boolean):v is CloudDiagnosticStep {
  const detailed=details&&typeof v==='object'&&v!==null&&Object.hasOwn(v,'cause');
  const operation=details&&typeof v==='object'&&v!==null&&Object.hasOwn(v,'operation');
  const transport=details&&typeof v==='object'&&v!==null&&Object.hasOwn(v,'transport');
  return cloudFields(v,['stage','outcome','reason','elapsedMs','attempts',...(detailed?['cause']:[]),...(operation?['operation']:[]),...(transport?['transport']:[])])&&
    (!operation||(['failed','unknown'].includes(v.outcome as string)&&['publish','connect','relay_bootstrap'].includes(v.stage as string)&&CLOUD_OPERATIONS.includes(v.operation as typeof CLOUD_OPERATIONS[number])))&&
    (!transport||(['failed','unknown'].includes(v.outcome as string)&&['network','tls','timeout','cancelled'].includes(v.reason as string)&&CLOUD_TRANSPORT_CAUSES.includes(v.transport as typeof CLOUD_TRANSPORT_CAUSES[number])))&&
    (!detailed||(['storage','storage_busy'].includes(v.reason as string)&&CLOUD_STORAGE_CAUSES.includes(v.cause as typeof CLOUD_STORAGE_CAUSES[number])))&&
    CLOUD_DIAGNOSTIC_STAGES.includes(v.stage as typeof CLOUD_DIAGNOSTIC_STAGES[number])&&
    (!['entry_ready','claim_submit','code_received'].includes(v.stage as string)||v.outcome==='completed'&&v.attempts===1)&&
    ['started','completed','failed','unknown'].includes(v.outcome as string)&&
    CLOUD_DIAGNOSTIC_REASONS.includes(v.reason as typeof CLOUD_DIAGNOSTIC_REASONS[number])&&
    (['started','completed'].includes(v.outcome as string)?v.reason==='none':v.reason!=='none')&&
    integer(v.elapsedMs,elapsed)&&integer(v.attempts,1000)&&(v.attempts as number)>0;
}
export function validCloudDiagnosticBody(v:unknown):v is CloudDiagnosticBody {
  const auth=(v as {contract?:unknown}|null)?.contract==='dshos-cloud-pairing-diagnostic-v3';
  const entry=(v as {contract?:unknown}|null)?.contract==='dshos-cloud-pairing-diagnostic-v4';
  const details=entry||(v as {contract?:unknown}|null)?.contract==='dshos-cloud-pairing-diagnostic-v2';
  if(!cloudFields(v,['contract','product','environment','role','operationId','attemptId','claimId','version','startedAtMs',
    'elapsedMs','revision','state','steps','firstFailure','lastFailure',...(auth?['authTrace']:[]),...(entry?['entry']:[])])||(!details&&!auth&&v.contract!=='dshos-cloud-pairing-diagnostic-v1')||details&&v.role!=='desktop'||entry&&!validEntry(v.entry)||
    auth&&(v.role!=='phone'||!validAuthenticationTrace(v.authTrace as AuthenticationTrace)||(v.authTrace as AuthenticationTrace).role!=='phone')||
    v.product!=='harmony-dsh'||!['PRODUCTION','SANDBOX'].includes(v.environment as string)||!['phone','desktop'].includes(v.role as string)||
    !registrationId(v.operationId)||v.attemptId!==''&&!registrationId(v.attemptId)||
    v.claimId!==''&&!registrationId(v.claimId)||v.role==='phone'&&v.claimId!==''||
    typeof v.version!=='string'||!/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[A-Za-z0-9.-]{1,20})?$/.test(v.version)||
    !integer(v.startedAtMs,Number.MAX_SAFE_INTEGER)||!integer(v.elapsedMs,86400000)||!integer(v.revision,Number.MAX_SAFE_INTEGER)||
    !['unknown','waiting','claimed','authorized','registered','paired','cancelled','rejected','expired','revoked','unused','connected'].includes(v.state as string)||
    !Array.isArray(v.steps)||v.steps.length>CLOUD_DIAGNOSTIC_STAGES.length||!v.steps.every(x=>step(x,v.elapsedMs as number,details))||
    v.role!=='desktop'&&v.steps.some(x=>['entry_ready','claim_submit'].includes(x.stage))||
    v.role!=='phone'&&v.steps.some(x=>x.stage==='code_received')||
    new Set(v.steps.map(x=>x.stage)).size!==v.steps.length) return false;
  const failures=[v.firstFailure,v.lastFailure];
  if(failures.some(f=>f!==null&&(!step(f,v.elapsedMs as number,details)||!['failed','unknown'].includes(f.outcome))))return false;
  if((v.firstFailure===null)!==(v.lastFailure===null)||v.firstFailure!==null&&
    (v.firstFailure as CloudDiagnosticStep).elapsedMs>(v.lastFailure as CloudDiagnosticStep).elapsedMs)return false;
  return Buffer.byteLength(JSON.stringify(v))<=(auth||entry?6144:4096);
}
/** A signature establishes the reporting key, not that every client statement
 * is true. Administrators separately compare it with authoritative events. */
export function validCloudDiagnostic(v:unknown):v is CloudDiagnosticPacket {
  return cloudFields(v,['body','publicKey','signature'])&&validCloudDiagnosticBody(v.body)&&registrationId(v.publicKey,32)&&
    cloudVerify('DIAGNOSTIC',v.body,v.publicKey,v.signature);
}

// Preparation can fail before a pairing signing key exists. The enclosing
// authenticated feedback identifies its reporter, never a pairing participant.
export function validCloudPreparation(v:unknown):v is CloudDiagnosticBody {
  const stages=['capabilities','login','service_trust','identity_read','identity_key','identity_save','code_input','entry_ready','claim_submit'];
  return validCloudDiagnosticBody(v)&&v.attemptId===''&&v.claimId===''&&v.revision===0&&v.state==='unknown'&&
    (v.steps.length>0||Boolean(v.entry&&(v.entry.visible||v.entry.blockedReason!=='none')))&&v.steps.every(s=>stages.includes(s.stage))&&
    (v.lastFailure!==null?stages.includes(v.lastFailure.stage)&&(v.firstFailure===null||stages.includes(v.firstFailure.stage)):
      v.role==='desktop'&&(v.steps.some(s=>s.stage==='entry_ready'||s.stage==='claim_submit')||Boolean(v.entry&&(v.entry.visible||v.entry.blockedReason!=='none'))));
}
