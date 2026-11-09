import {join} from 'node:path'
import {CloudPairingFile} from './cloud-pairing-storage.js'
import {registrationDirectory,registrationLock,registrationProtector,type RegistrationProtector,type RegistrationLease} from './dsh-registration-storage.js'
import {validAnyDesktopFeedback,type TraceFeedbackPacket} from './pairing-trace-contract.js'
import {supportFields} from './pairing-support-contract.js'

interface OutboxRecord {version:1; packet:TraceFeedbackPacket|null; expiresAt:number; nextSendAt:number}
export interface SupportOutbox {
  pending():Promise<TraceFeedbackPacket|null>
  save(packet:TraceFeedbackPacket):Promise<void>
  accepted(packet:TraceFeedbackPacket):Promise<void>
  discardExpired(now:number):Promise<void>
  cooldownUntil(now?:number):Promise<number>
  reserve(now:number):Promise<number>
}
function valid(v:unknown):v is OutboxRecord {
  if(!supportFields(v,['version','packet','expiresAt','nextSendAt'])||v.version!==1||!Number.isSafeInteger(v.expiresAt)||(v.expiresAt as number)<0||!Number.isSafeInteger(v.nextSendAt)||(v.nextSendAt as number)<0)return false
  if(v.packet===null)return v.expiresAt===0
  const packet=v.packet as TraceFeedbackPacket
  return typeof packet?.body?.submittedAtMs==='number'&&validAnyDesktopFeedback(packet,packet.body.submittedAtMs)
    &&v.expiresAt===Math.min(packet.body.submittedAtMs+23*3600000,packet.body.observation.body.startedAtMs+23*3600000)
}
const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b)
/** Dedicated profile-local, CurrentUser-protected file. Only user-submitted,
 * already-signed packets are stored; no signing keys or unfinished previews. */
export class ProtectedSupportOutbox implements SupportOutbox {
  private readonly file:CloudPairingFile<OutboxRecord>
  constructor(private readonly directory:string,protector:RegistrationProtector=registrationProtector('SUPPORT-OUTBOX/V1'),
    private readonly prepare=registrationDirectory,private readonly lock=registrationLock){
    this.file=new CloudPairingFile(join(directory,'pending-feedback.bin'),protector,valid,(old,next)=>
      old?.packet==null||next.packet===null||same(old.packet,next.packet))
  }
  private async withFile<T>(fn:(lease:RegistrationLease,old:OutboxRecord|null)=>Promise<T>):Promise<T>{
    await this.prepare(this.directory);const lease=await this.lock(this.directory)
    try{return await fn(lease,await this.file.read(lease))}finally{await lease.release()}
  }
  pending():Promise<TraceFeedbackPacket|null>{return this.withFile(async(_lease,old)=>old?.packet??null)}
  private async normalizeCooldown(lease:RegistrationLease,old:OutboxRecord|null,now:number):Promise<OutboxRecord|null>{
    if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(now+60000))throw Error('support_clock')
    // A saved wall-clock deadline must never make a one-minute local throttle
    // last for hours after a clock correction. Preserve the signed packet.
    if(old&&old.nextSendAt>now+60000){
      const next={...old,nextSendAt:now+60000};await this.file.write(next,old,lease);return next
    }
    return old
  }
  cooldownUntil(now=Date.now()):Promise<number>{return this.withFile(async(lease,old)=>(await this.normalizeCooldown(lease,old,now))?.nextSendAt??0)}
  reserve(now:number):Promise<number>{return this.withFile(async(lease,old)=>{
    old=await this.normalizeCooldown(lease,old,now)
    if(old&&old.nextSendAt>now)return old.nextSendAt
    await this.file.write({...old,version:1,packet:old?.packet??null,expiresAt:old?.expiresAt??0,nextSendAt:now+60000},old,lease)
    return 0
  })}
  save(packet:TraceFeedbackPacket):Promise<void>{return this.withFile(async(lease,old)=>{
    if(old?.packet&&!same(old.packet,packet))throw Error('support_pending_conflict')
    const next:OutboxRecord={version:1,packet,expiresAt:Math.min(packet.body.submittedAtMs+23*3600000,packet.body.observation.body.startedAtMs+23*3600000),nextSendAt:old?.nextSendAt??0}
    await this.file.write(next,old,lease)
  })}
  accepted(packet:TraceFeedbackPacket):Promise<void>{return this.withFile(async(lease,old)=>{
    if(old?.packet==null)return
    if(!same(old.packet,packet))throw Error('support_pending_conflict')
    await this.file.write({version:1,packet:null,expiresAt:0,nextSendAt:old.nextSendAt},old,lease)
  })}
  discardExpired(now:number):Promise<void>{return this.withFile(async(lease,old)=>{
    if(old?.packet==null)return
    if(!Number.isSafeInteger(now)||now<old.expiresAt)throw Error('support_pending_conflict')
    await this.file.write({version:1,packet:null,expiresAt:0,nextSendAt:old.nextSendAt},old,lease)
  })}
}
