import { open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { CloudPairingFile } from './cloud-pairing-storage.js'
import { registrationDirectory, registrationPath, registrationLock, registrationProtector, RegistrationFile,
  type RegistrationProtector, type RegistrationGuard, type RegistrationLease } from './dsh-registration-storage.js'
import { registrationFields as fields, registrationId as id, registrationDigest as digest,
  registrationBytes as bytes, validComputerRegistry, type ComputerRegistry, type JsonRecord } from './dsh-registration-contract.js'
import type { PairingTrustRecord, PairingTrustStore } from './pairing-trust-store.js'

// Exact owned file slots only; no directory traversal, sibling Pi files or recursive deletion.
const LEGACY=['material-v2.json','source-v2.json','intent-v2.json','pairing-intent-v2.json','activation-v2.json']
const SLOTS=['cloud-record','cloud-diagnostic','cloud-diagnostic-tmp','cloud-relay-key','cloud-relay-key-tmp',...LEGACY.map(n=>'root-'+n),...LEGACY.map(n=>'enroll-'+n)]
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('base64url')
interface Retirement {
  contract:'dshos-cloud-retirement-v3';computerId:string;proofDigest:string;beforeDigest:string;
  after:ComputerRegistry|null;trust:PairingTrustRecord|null;files:{slot:string;digest:string}[];complete:boolean;
}
const valid=(v:unknown):v is Retirement=>fields(v,['contract','computerId','proofDigest','beforeDigest','after','trust','files','complete'])&&
  v.contract==='dshos-cloud-retirement-v3'&&id(v.computerId)&&id(v.proofDigest,32)&&id(v.beforeDigest,32)&&
  (v.after===null||validComputerRegistry(v.after))&&typeof v.complete==='boolean'&&
  (v.trust===null||fields(v.trust,['pairingVersion','pairingId','mobilePublicKeyRaw','createdAt','updatedAt','status'])&&
    v.trust.pairingVersion===1&&id(v.trust.pairingId)&&id(v.trust.mobilePublicKeyRaw,32)&&v.trust.status==='active'&&
    Number.isSafeInteger(v.trust.createdAt)&&(v.trust.createdAt as number)>=0&&Number.isSafeInteger(v.trust.updatedAt)&&
    (v.trust.updatedAt as number)>=(v.trust.createdAt as number))&&Array.isArray(v.files)&&v.files.length<=SLOTS.length&&
  v.files.every((f:unknown,i:number,all:unknown[])=>fields(f,['slot','digest'])&&SLOTS.includes(f.slot as string)&&id(f.digest,32)&&
    all.findIndex(x=>(x as JsonRecord).slot===f.slot)===i)&&v.files.some(f=>(f as JsonRecord).slot==='cloud-record')
export function cloudRetirementFile(directory:string,protector:RegistrationProtector):CloudPairingFile<Retirement>{
  return new CloudPairingFile(join(directory,'retirement-v3.sealed'),protector,valid,(old,next)=>!old||old.complete||
    !old.complete&&next.complete&&bytes({...old,complete:true}).equals(bytes(next)))
}

/** Resume only an already accepted, sealed local decision before exposing AUTH.
 * A new retirement still requires the fresh signed service proof in the vault.
 * Missing network/public-key service must not delay this durable local commit. */
export async function resumeAcceptedCloudRetirement(options:{
  directory:string;registrationDirectory:string;registryDirectory:string|undefined;
  trustStore:PairingTrustStore;invalidate():void;assertCurrent():void;
  protector?:typeof registrationProtector;prepare?:(path:string)=>Promise<void>;
  lock?:(directory:string)=>Promise<RegistrationLease>;
}):Promise<void>{
  options.assertCurrent()
  let present=false
  for(const name of ['retirement-v3.sealed','retirement-v3.sealed.tmp']){
    try{await registrationPath(join(options.directory,name));present=true}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    options.assertCurrent()
  }
  if(!present)return
  if(!options.registryDirectory||!isAbsolute(options.registryDirectory))throw Error('cloud_retirement_registry_unavailable')
  const prepare=options.prepare??registrationDirectory,protect=options.protector??registrationProtector
  let lease:RegistrationLease|undefined,failure:unknown
  try{
    await prepare(options.registryDirectory);options.assertCurrent()
    lease=await(options.lock??registrationLock)(options.registryDirectory)
    const guard={assertHeld:()=>{options.assertCurrent();lease!.assertHeld()}}
    guard.assertHeld();await prepare(options.directory);guard.assertHeld()
    const registry=new RegistrationFile(join(options.registryDirectory,'computer-registry-v2.json'),
      protect('COMPUTER-REGISTRY/V1'),validComputerRegistry,'registry')
    await new CloudPairingRetirement({...options,protector:protect('CLOUD-PAIRING/V3'),registry,now:Date.now,prepare}).resume(guard)
    guard.assertHeld()
  }catch(error){failure=error}
  finally{try{await lease?.release()}catch(error){failure=failure===undefined?error:new AggregateError([failure,error],
    failure instanceof Error?failure.message:'cloud_pairing_cleanup_failed',{cause:failure})}}
  if(failure!==undefined)throw failure
}
export class CloudPairingRetirement {
  private readonly journal:CloudPairingFile<Retirement>
  private readonly archive:string
  constructor(private readonly options:{directory:string;registrationDirectory:string;protector:RegistrationProtector;
    registry:RegistrationFile<ComputerRegistry>;trustStore:PairingTrustStore;invalidate():void;now():number;
    prepare?:(path:string)=>Promise<void>}){
    this.archive=join(options.directory,'retired');this.journal=cloudRetirementFile(options.directory,options.protector)
  }
  private path(slot:string,archived:boolean):string{
    if(!SLOTS.includes(slot))throw Error('cloud_retirement_slot')
    if(archived)return join(this.archive,slot+'.sealed')
    if(slot==='cloud-record')return join(this.options.directory,'record-v3.sealed')
    if(slot==='cloud-diagnostic')return join(this.options.directory,'diagnostic-v3.sealed')
    if(slot==='cloud-diagnostic-tmp')return join(this.options.directory,'diagnostic-v3.sealed.tmp')
    if(slot==='cloud-relay-key')return join(this.options.directory,'relay-key-v3.sealed')
    if(slot==='cloud-relay-key-tmp')return join(this.options.directory,'relay-key-v3.sealed.tmp')
    return slot.startsWith('root-')?join(this.options.registrationDirectory,slot.slice(5)):
      join(this.options.registrationDirectory,'enrollment-v2',slot.slice(7))
  }
  private async read(slot:string,archived:boolean,g:RegistrationGuard):Promise<Buffer|null>{
    g.assertHeld();const path=this.path(slot,archived)
    try{await registrationPath(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
    const f=await open(path,'r');try{
      const minimum=slot.startsWith('cloud-diagnostic')?0:1
      const stat=await f.stat();if(!stat.isFile()||stat.nlink!==1||stat.size<minimum||stat.size>32768)throw Error('cloud_retirement_capacity')
      const b=Buffer.alloc(32769);let size=0
      while(size<b.length){const read=await f.read(b,size,b.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead}
      if(size<minimum||size>32768)throw Error('cloud_retirement_capacity');g.assertHeld();return b.subarray(0,size)
    }finally{await f.close()}
  }
  async resume(g:RegistrationGuard):Promise<boolean>{
    const journal=await this.journal.read(g);if(!journal||journal.complete)return false
    await this.finish(journal,g);return true
  }
  async begin(proof:JsonRecord,before:ComputerRegistry|null,after:ComputerRegistry|null,trust:PairingTrustRecord|null,g:RegistrationGuard):Promise<void>{
    // Caller obtained and verified this exact nonce/key/account removal proof.
    if(proof.contract!=='dshos-local-registration-status-result-v3'||!proof.removal||
      !fields(proof.request,['contract','computerId','registrationPublicKey','platform','memberId','memberPublicKey','nonce','accountBindingId'])||
      proof.request.platform!=='dsh'||!id(proof.request.computerId)||!id(proof.request.accountBindingId)||
      trust!==null&&(trust.status!=='active'||!this.options.trustStore.deleteRevoked))throw Error('cloud_retirement_proof')
    const fresh={assertHeld:()=>{g.assertHeld();const now=this.options.now()
      if(!Number.isSafeInteger(now)||!Number.isSafeInteger(proof.issuedAt)||!Number.isSafeInteger(proof.expiresAt)||
        (proof.expiresAt as number)-(proof.issuedAt as number)!==30000||now<(proof.issuedAt as number)||now>=(proof.expiresAt as number))
        throw Error('cloud_retirement_expired')}}
    fresh.assertHeld()
    if(!bytes(await this.options.registry.read()).equals(bytes(before))||!bytes(this.options.trustStore.read()).equals(bytes(trust)))
      throw Error('cloud_retirement_source_changed')
    const old=await this.journal.read(g);if(old&&!old.complete)throw Error('cloud_retirement_pending')
    const files:Retirement['files']=[]
    for(const slot of SLOTS){const value=await this.read(slot,false,g);if(value)files.push({slot,digest:hash(value)})}
    if(!files.some(f=>f.slot==='cloud-record'))throw Error('cloud_retirement_source_missing')
    for(const f of old?.files??[]){const b=await this.read(f.slot,true,g)
      if(b&&hash(b)!==f.digest)throw Error('cloud_retirement_archive_changed')
      if(b){g.assertHeld();await unlink(this.path(f.slot,true));g.assertHeld()}}
    await (this.options.prepare??registrationDirectory)(this.archive);g.assertHeld()
    for(const slot of SLOTS)if(await this.read(slot,true,g))throw Error('cloud_retirement_archive_conflict')
    const saved:Retirement={contract:'dshos-cloud-retirement-v3',computerId:proof.request.computerId,
      proofDigest:digest(proof),beforeDigest:digest(before),after,trust,files,complete:false}
    await this.journal.write(saved,old,fresh);await this.finish(saved,g)
  }
  private async finish(saved:Retirement,g:RegistrationGuard):Promise<void>{
    const trust=this.options.trustStore.read(),revoked=saved.trust?{...saved.trust,status:'revoked' as const}:null
    g.assertHeld()
    if(trust&&!bytes(trust).equals(bytes(saved.trust))&&!bytes(trust).equals(bytes(revoked)))throw Error('cloud_retirement_trust_changed')
    if(trust&&trust.status!=='revoked')this.options.trustStore.replace(revoked!)
    this.options.invalidate();g.assertHeld()
    for(const f of saved.files){const src=await this.read(f.slot,false,g),dst=await this.read(f.slot,true,g)
      if(src&&dst||!src&&!dst||hash((src??dst)!)!==f.digest)throw Error('cloud_retirement_source_changed')
      if(src){g.assertHeld();await rename(this.path(f.slot,false),this.path(f.slot,true));g.assertHeld()}}
    const current=await this.options.registry.read();g.assertHeld()
    if(digest(current)===saved.beforeDigest){
      if(saved.after)await this.options.registry.write(saved.after,g)
      else if(current)await this.options.registry.remove(current,g)
    }else if(!bytes(current).equals(bytes(saved.after)))throw Error('cloud_retirement_registry_changed')
    if(this.options.trustStore.read()!==null){if(!revoked||!this.options.trustStore.deleteRevoked)throw Error('cloud_retirement_trust_changed')
      this.options.trustStore.deleteRevoked(revoked)}
    await this.journal.write({...saved,complete:true},saved,g);g.assertHeld()
  }
}
