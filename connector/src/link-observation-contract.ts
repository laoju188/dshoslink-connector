import { createPublicKey, verify } from 'node:crypto';
import { registrationFields as exactFields, registrationId as isRegistrationId, registrationTranscript } from './dsh-registration-contract.js';
function verifyRegistrationSignature(domain:string,body:object,key:string,signature:unknown):boolean {
  return isRegistrationId(signature,64) && verify(null,registrationTranscript(domain,body),
    createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:key}}),Buffer.from(signature,'base64url'));
}
import { validCloudDiagnosticBody, type CloudDiagnosticBody } from './cloud-pairing-diagnostic.js';

import {validAuthenticationTrace,type AuthenticationTrace} from './authentication-trace.js';
import {validNotificationDetail,CONNECTION_RESULTS,type NotificationDetail,type ConnectionEvent} from './pairing-support-contract.js';
export const LINK_OBSERVATION_CONTRACT = 'dshos-link-observation-v1';
export const LINK_DIAGNOSTIC_CONTRACT = 'dshos-link-observation-v2';
export type LinkDiagnostic = {kind:'authentication';trace:AuthenticationTrace} |
  {kind:'notification';result:ConnectionEvent['result'];atMs:number;detail:NotificationDetail};
export function validLinkDiagnostic(v:unknown,now:number):v is LinkDiagnostic {
  if(exactFields(v,['kind','trace'])&&v.kind==='authentication')
    return validAuthenticationTrace(v.trace as AuthenticationTrace)&&(v.trace as AuthenticationTrace).role==='desktop';
  return exactFields(v,['kind','result','atMs','detail'])&&v.kind==='notification'
    &&CONNECTION_RESULTS.includes(v.result as ConnectionEvent['result'])&&validNotificationDetail(v.detail)
    &&Number.isSafeInteger(v.atMs)&&(v.atMs as number)>=0&&(v.atMs as number)<=now+30000&&now-(v.atMs as number)<=86400000;
}
export const LINK_OBSERVATION_DOMAIN = 'LINK-OBSERVATION';
export const LINK_OBSERVATION_BYTES = 8192;
export interface LinkConnectionObservation {
  memberId: string;
  pairingId: string;
  transport: 'lan' | 'relay';
  evidence: 'authenticated' | 'business_request' | 'diagnostic';
  diagnostic?: LinkDiagnostic;
}
export interface LinkObservationBody {
  contract: typeof LINK_OBSERVATION_CONTRACT | typeof LINK_DIAGNOSTIC_CONTRACT;
  // This is a report-stream ID, not a count of pairing attempts or people.
  attemptId: string;
  publicKey: string;
  sequence: number;
  startedAtMs: number;
  version: string;
  environment: 'PRODUCTION' | 'SANDBOX';
  cloud: CloudDiagnosticBody | null;
  connection: LinkConnectionObservation | null;
}
export interface LinkObservationPacket { body: LinkObservationBody; signature: string; }
export function validLinkObservation(value: unknown, now: number): value is LinkObservationPacket {
  try {
    if (!exactFields(value, ['body', 'signature']) || !exactFields(value.body,
      ['contract','attemptId','publicKey','sequence','startedAtMs','version','environment','cloud','connection'])) return false;
    const b = value.body;
    if (![LINK_OBSERVATION_CONTRACT,LINK_DIAGNOSTIC_CONTRACT].includes(b.contract as string) || !isRegistrationId(b.attemptId) || !isRegistrationId(b.publicKey, 32)
      || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(b.startedAtMs)
      || (b.startedAtMs as number) < 0 || (b.startedAtMs as number) > now + 30000 || now - (b.startedAtMs as number) > 86400000
      || !Number.isInteger(b.sequence) || (b.sequence as number) < 1 || (b.sequence as number) > 64
      || typeof b.version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[A-Za-z0-9.-]{1,20})?$/.test(b.version)
      || !['PRODUCTION','SANDBOX'].includes(b.environment as string) || (b.cloud === null) === (b.connection === null)) return false;
    if (b.cloud !== null && (!validCloudDiagnosticBody(b.cloud) || b.cloud.role !== 'desktop'
      || b.cloud.environment !== b.environment || b.cloud.version !== b.version)) return false;
    const diagnostic=b.contract===LINK_DIAGNOSTIC_CONTRACT;
    if(diagnostic&&(b.cloud!==null||b.connection===null))return false;
    if (b.connection !== null && (!exactFields(b.connection, ['memberId','pairingId','transport','evidence',...(diagnostic?['diagnostic']:[])])
      || !isRegistrationId(b.connection.memberId) || !isRegistrationId(b.connection.pairingId)
      || !['lan','relay'].includes(b.connection.transport as string)
      || (diagnostic ? b.connection.evidence!=='diagnostic'||!validLinkDiagnostic(b.connection.diagnostic,now)
        : !['authenticated','business_request'].includes(b.connection.evidence as string))
      || b.sequence !== 1)) return false;
    return Buffer.byteLength(JSON.stringify(value)) <= LINK_OBSERVATION_BYTES
      && verifyRegistrationSignature(LINK_OBSERVATION_DOMAIN, b, b.publicKey, value.signature);
  } catch { return false; }
}
