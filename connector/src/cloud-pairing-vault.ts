import { basename, join } from 'node:path'
import { lstat, mkdtemp, readdir, rename } from 'node:fs/promises'
import { CloudPairingFile } from './cloud-pairing-storage.js'
import { markStorageFailure, trackStorageOperation } from './registration-operation.js'
import { RegistrationFile, registrationDirectory, registrationLock, registrationPath, registrationProtector,
  type RegistrationGuard, type RegistrationLease, type RegistrationProtector } from './dsh-registration-storage.js'
import { validComputerRegistry, registrationId, type ComputerRegistry } from './dsh-registration-contract.js'
import { validDshEnrollmentMaterial, type DshEnrollmentMaterial } from './dsh-enrollment.js'
import { validDshRegistrationMaterial, type DshRegistrationMaterial } from './dsh-registration.js'
import { assertCloudLegacy, newCloudDesktopRecord, validCloudDesktopRecord, cloudDesktopTransition,
  cloudHistoricalReply, type CloudDesktopRecord, type CloudLegacyIdentity } from './cloud-pairing-record.js'
import type { CloudEnvironment, CloudRequest, CloudPayload } from './cloud-pairing-contract.js'
import { cloudBindingReceipt, readCloudCurrent } from './cloud-pairing-current.js'
import type { PairingTrustStore } from './pairing-trust-store.js'
import {validCloudDiagnostic,type CloudDiagnosticPacket} from './cloud-pairing-diagnostic.js'
import {cloudDigest,cloudFields} from './cloud-pairing-contract.js'
import {createPublicKey} from 'node:crypto'
import {CloudPairingRetirement,cloudRetirementFile} from './cloud-pairing-retirement.js'
import {queryLocalStatus} from './local-status-service.js'
import type {JsonRecord} from './dsh-registration-contract.js'
import {validCloudRelayPrivateKey,newCloudRelayPrivateKey,type CloudRelayPrivateKey} from './cloud-pairing-relay-key.js'
interface DiagnosticRecord{contract:'dshos-cloud-diagnostic-record-v1';packet:CloudDiagnosticPacket}
function diagnosticRecord(value:unknown):value is DiagnosticRecord{
  return cloudFields(value,['contract','packet'])&&value.contract==='dshos-cloud-diagnostic-record-v1'&&validCloudDiagnostic(value.packet)
}

export interface CloudDesktopVaultOptions {
  directory: string
  registrationDirectory: string
  registryDirectory: string
  trust: { keyId: string; publicKey: string }
  environment: CloudEnvironment
  assertCurrent(): void
  // Tests use temporary roots and synthetic protectors; production uses DPAPI.
  protector?: typeof registrationProtector
  prepare?: (directory: string) => Promise<void>
  lock?: (directory: string) => Promise<RegistrationLease>
}
/** All mutations share the existing computer-registry lease with V2. The V3
 * journal lives outside enrollment-v2; no fake QR or old-format activation. */
export class CloudDesktopVault {
  readonly registry: RegistrationFile<ComputerRegistry>
  private readonly file: CloudPairingFile<CloudDesktopRecord>
  private readonly enrollment: RegistrationFile<DshEnrollmentMaterial>
  private readonly registration: RegistrationFile<DshRegistrationMaterial>
  private readonly diagnostic:CloudPairingFile<DiagnosticRecord>
  private readonly prepareConflict: CloudPairingFile<string>
  private busy = false
  private readonly retirementProtector:RegistrationProtector
  private readonly relayKey:CloudPairingFile<CloudRelayPrivateKey>
  constructor(private readonly options: CloudDesktopVaultOptions) {
    const protect: (purpose: Parameters<typeof registrationProtector>[0]) => RegistrationProtector = options.protector ?? registrationProtector
    this.retirementProtector=protect('CLOUD-PAIRING/V3')
    this.relayKey=new CloudPairingFile(join(options.directory,'relay-key-v3.sealed'),protect('CLOUD-PAIRING/V3'),validCloudRelayPrivateKey,
      (old,next)=>!old||JSON.stringify(old)===JSON.stringify(next))
    this.file = new CloudPairingFile(join(options.directory, 'record-v3.sealed'), protect('CLOUD-PAIRING/V3'),
      (value): value is CloudDesktopRecord => validCloudDesktopRecord(value, options.trust), cloudDesktopTransition)
    this.diagnostic=new CloudPairingFile(join(options.directory,'diagnostic-v3.sealed'),protect('CLOUD-PAIRING/V3'),diagnosticRecord,
      (old,next)=>!old||old.packet.publicKey===next.packet.publicKey&&old.packet.body.environment===next.packet.body.environment)
    // Separate from the identity record so older connectors can still read it after rollback.
    this.prepareConflict = new CloudPairingFile(join(options.directory,'prepare-conflict-v3.sealed'),
      protect('CLOUD-PAIRING/V3'), (value): value is string => registrationId(value,32), () => true)
    this.registry = new RegistrationFile(join(options.registryDirectory,'computer-registry-v2.json'), protect('COMPUTER-REGISTRY/V1'),validComputerRegistry,'registry')
    this.enrollment = new RegistrationFile(join(options.registrationDirectory,'enrollment-v2','material-v2.json'),
      protect('DSH-REGISTRATION/V2'),validDshEnrollmentMaterial,'material')
    this.registration = new RegistrationFile(join(options.registrationDirectory,'material-v2.json'),
      protect('DSH-REGISTRATION/V2'),validDshRegistrationMaterial,'material')
  }
  private async held<T>(run: (guard: RegistrationGuard) => Promise<T>): Promise<T> {
    this.options.assertCurrent(); if (this.busy) throw markStorageFailure(Error('cloud_pairing_storage_busy'), 'storage_lock'); this.busy = true
    let lease: RegistrationLease | undefined, result: T | undefined, failure: unknown
    try {
      const prepare = this.options.prepare ?? registrationDirectory
      await trackStorageOperation('prepare_directory', () => prepare(this.options.registryDirectory)); this.options.assertCurrent()
      // Background retirement checks and foreground enrollment share this native
      // lease. Wait only before acquisition; never replay a write or a request.
      const delays = [50, 100, 200, 400, 800]
      for (let attempt = 0; ; attempt++) {
        this.options.assertCurrent()
        try { lease = await (this.options.lock ?? registrationLock)(this.options.registryDirectory); break }
        catch (error) {
          this.options.assertCurrent()
          if (!(error instanceof Error) || error.message !== 'registration_busy' || attempt === delays.length) throw markStorageFailure(error, 'storage_lock')
          await new Promise<void>(resolve => setTimeout(resolve, delays[attempt]!))
        }
      }
      const guard = {assertHeld: () => {
        this.options.assertCurrent()
        try { lease!.assertHeld() } catch (error) { throw markStorageFailure(error, 'storage_lock') }
      }}
      guard.assertHeld(); await trackStorageOperation('prepare_directory', () => prepare(this.options.directory)); guard.assertHeld()
      result = await run(guard); guard.assertHeld()
    } catch (error) { failure = error }
    finally {
      try { await lease?.release() } catch (error) {
        failure = failure === undefined ? markStorageFailure(error, 'storage_lock') : new AggregateError([failure,error],
          failure instanceof Error ? failure.message : 'cloud_pairing_cleanup_failed',{cause:failure})
      }
      this.busy = false
    }
    if (failure !== undefined) throw failure
    return result!
  }
  private async names(path: string): Promise<string[]> {
    try { const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw Error('cloud_pairing_unsafe_legacy_path');
      return await readdir(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw markStorageFailure(error, 'read_file') }
  }
  private async assertRetirementComplete(guard:RegistrationGuard):Promise<void>{
    const saved=await cloudRetirementFile(this.options.directory,this.retirementProtector).read(guard)
    if(saved&&!saved.complete)throw Error('cloud_pairing_retirement_pending')
  }
  async legacy(guard: RegistrationGuard): Promise<CloudLegacyIdentity> {
    guard.assertHeld()
    const registry = await this.registry.read(); guard.assertHeld()
    const enrollment = await this.enrollment.read(); guard.assertHeld()
    const registration = await this.registration.read(); guard.assertHeld()
    const root = await this.names(this.options.registrationDirectory), enroll = await this.names(join(this.options.registrationDirectory,'enrollment-v2'))
    guard.assertHeld()
    const unfinished = root.some(n => ['material-v2.json.tmp','intent-v2.json.tmp','pairing-intent-v2.json.tmp'].includes(n)) ||
      enroll.some(n => n.endsWith('.tmp')) ||
      !registration && root.some(n => ['intent-v2.json','pairing-intent-v2.json'].includes(n)) ||
      !enrollment && enroll.some(n => n !== '.registration.lock')
    return {registry,enrollment,registration,incomplete:unfinished}
  }
  open(name: string): Promise<CloudDesktopRecord> {
    return this.held(async guard => {
      await this.assertRetirementComplete(guard)
      const old = await this.legacy(guard), record = await this.file.read(guard)
      if (record) { if (record.environment !== this.options.environment) throw Error('cloud_pairing_environment_changed');
        assertCloudLegacy(record,old); return record }
      const next = newCloudDesktopRecord(old,name,this.options.environment)
      await this.file.write(next,null,guard); return structuredClone(next)
    })
  }
  read(): Promise<CloudDesktopRecord | null> {
    return this.held(async guard => { await this.assertRetirementComplete(guard);const record = await this.file.read(guard)
      if (record) assertCloudLegacy(record,await this.legacy(guard)); return record })
  }
  write(next: CloudDesktopRecord, expected: CloudDesktopRecord): Promise<void> {
    return this.held(async guard => {
      await this.assertRetirementComplete(guard)
      assertCloudLegacy(next,await this.legacy(guard))
      if(expected.journal && next.journal===null){
        if(!validCloudDesktopRecord(next,this.options.trust)||!cloudDesktopTransition(expected,next))
          throw Error('cloud_pairing_transition')
        const current=await this.file.read(guard)
        if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('cloud_pairing_source_changed')
        // An explicit restart with signed terminal proof can retire the old
        // sidecar. A crash here still leaves the signed terminal journal intact.
        await this.archiveUnreadablePrepareConflict(guard)
      }
      await this.file.write(next,expected,guard)
    })
  }
  private async archiveUnreadablePrepareConflict(guard: RegistrationGuard): Promise<void> {
    try { await this.prepareConflict.read(guard); return }
    catch { guard.assertHeld() }
    const originals: string[] = []
    for(const path of [this.prepareConflict.path+'.tmp',this.prepareConflict.path]){
      try {
        await registrationPath(path)
        const stat=await lstat(path)
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('cloud_pairing_file_invalid')
        originals.push(path)
      } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error }
    }
    if(originals.length===0)return
    await registrationPath(this.options.directory)
    guard.assertHeld()
    const archive=await mkdtemp(join(this.options.directory,'prepare-conflict-recovery-'))
    for(const path of originals){
      guard.assertHeld()
      await rename(path,join(archive,basename(path)))
    }
    guard.assertHeld()
  }
  private prepareConflictDigest(record: CloudDesktopRecord, attemptId: string): string {
    return cloudDigest({environment:record.environment, publicKey:record.desktop.registrationPublicKey, attemptId})
  }
  readPrepareConflict(record: CloudDesktopRecord, attemptId: string): Promise<boolean> {
    return this.held(async guard => (await this.prepareConflict.read(guard)) === this.prepareConflictDigest(record,attemptId))
  }
  savePrepareConflict(record: CloudDesktopRecord, attemptId: string): Promise<void> {
    return this.held(async guard => {
      await this.assertRetirementComplete(guard)
      const current = await this.file.read(guard)
      if (JSON.stringify(current) !== JSON.stringify(record)) throw Error('cloud_pairing_source_changed')
      const old = await this.prepareConflict.read(guard)
      await this.prepareConflict.write(this.prepareConflictDigest(record,attemptId),old,guard)
    })
  }
  loadRelayKey(expected:CloudDesktopRecord):Promise<CloudRelayPrivateKey>{
    return this.held(async guard=>{
      await this.assertRetirementComplete(guard)
      const record=await this.file.read(guard)
      if(JSON.stringify(record)!==JSON.stringify(expected)||!record?.savedReplyText)throw Error('cloud_pairing_source_changed')
      const old=await this.relayKey.read(guard)
      if(old){if(old.pairingId!==record.desktop.pairingId||record.relayKeyId!==undefined&&old.keyId!==record.relayKeyId)throw Error('cloud_pairing_relay_key_changed');return old}
      if(record.relayKeyId!==undefined)throw Error('cloud_pairing_relay_key_missing')
      const key=await newCloudRelayPrivateKey(record.desktop.pairingId);guard.assertHeld()
      await this.relayKey.write(key,null,guard);return key
    })
  }
  reconcileRetirement(trustStore:PairingTrustStore,invalidate:()=>void,now:()=>number,signal:AbortSignal,
    query:typeof queryLocalStatus=queryLocalStatus):Promise<boolean>{
    return this.held(async guard=>{
      const retirement=new CloudPairingRetirement({directory:this.options.directory,registrationDirectory:this.options.registrationDirectory,
        protector:this.retirementProtector,registry:this.registry,trustStore,invalidate,now,prepare:this.options.prepare})
      if(await retirement.resume(guard))return true
      const record=await this.file.read(guard);guard.assertHeld()
      if(!record)return false
      const old=await this.legacy(guard);assertCloudLegacy(record,old);guard.assertHeld()
      const reply=record.savedReplyText??record.journal?.replyText
      if(!reply)return false
      const status=cloudHistoricalReply(reply,this.options.trust,record),prepared=status.prepared as CloudPayload|null
      if(typeof prepared?.pairingText!=='string')return false
      // A process may die after service commit but before local save. The signed
      // original preparation scopes a removal query; only a fresh exact removal
      // proof below authorizes retirement, never this historical response alone.
      const pair=JSON.parse(prepared.pairingText) as CloudPayload
      if(!registrationId(pair.accountBindingId)||pair.computerId!==record.desktop.computerId||
        pair.memberId!==record.desktop.memberId||pair.newPairingId!==record.desktop.pairingId||
        pair.newMobilePublicKey!==status.mobilePublicKey)throw Error('cloud_retirement_proof')
      const account=pair.accountBindingId as string
      const trust=trustStore.read()
      if(trust&&(trust.status!=='active'||trust.pairingId!==record.desktop.pairingId&&
        !(pair.purpose==='restoreDshPairing'&&pair.oldPairingId===trust.pairingId)||
        trust.pairingId===record.desktop.pairingId&&trust.mobilePublicKeyRaw!==status.mobilePublicKey))
        throw Error('cloud_pairing_local_binding_changed')
      const identity={...record.desktop,registrationPrivateKey:record.registrationPrivateKey,platform:'dsh' as const}
      const result=await query(identity,{keyId:this.options.trust.keyId,
        publicKey:createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:this.options.trust.publicKey},format:'jwk'})},
        signal,now,account)
      guard.assertHeld();signal.throwIfAborted()
      if(!result.retired)return false
      const proof=result.proof,request=proof.request as JsonRecord
      if(proof.contract!=='dshos-local-registration-status-result-v3'||!proof.removal||request.accountBindingId!==account||
        request.computerId!==record.desktop.computerId||request.registrationPublicKey!==record.desktop.registrationPublicKey||
        request.memberId!==record.desktop.memberId||request.memberPublicKey!==record.desktop.memberPublicKey)
        throw Error('cloud_retirement_proof')
      let after=old.registry
      if(proof.computer===null){if(after?.computerId===record.desktop.computerId)after=null}
      else{
        const parent=proof.computer as JsonRecord
        if(!after||after.computerId!==record.desktop.computerId||after.accountBindingId!==account||
          parent.accountBindingId!==account)throw Error('cloud_retirement_registry')
        const previous=after
        const members=(proof.members as JsonRecord[]).map(member=>{
          const saved=previous.members.find(v=>v.platform===member.platform)
          if(!saved||saved.platform==='dsh'||saved.memberId!==member.memberId||saved.publicKey!==member.memberPublicKey||
            saved.keyGeneration!==member.keyGeneration)throw Error('cloud_retirement_registry')
          return saved
        })
        after={...previous,registrationGeneration:parent.registrationGeneration as string,members}
        if(!validComputerRegistry(after))throw Error('cloud_retirement_registry')
      }
      await retirement.begin(proof,old.registry,after,trust,guard);return true
    })
  }
  private diagnosticMatches(packet:CloudDiagnosticPacket,record:CloudDesktopRecord):boolean{
    return packet.publicKey===record.desktop.registrationPublicKey&&packet.body.role==='desktop'&&packet.body.environment===record.environment&&
      packet.body.claimId===(record.journal?.claimId??'')&&packet.body.attemptId===(record.journal?.attemptId??'')
  }
  readDiagnostic(expected:CloudDesktopRecord):Promise<CloudDiagnosticPacket|null>{
    return this.held(async guard=>{
      const record=await this.file.read(guard);if(JSON.stringify(record)!==JSON.stringify(expected))throw Error('cloud_pairing_source_changed')
      const diagnostic=await this.diagnostic.read(guard)
      return diagnostic&&this.diagnosticMatches(diagnostic.packet,expected)?diagnostic.packet:null
    })
  }
  saveDiagnostic(expected:CloudDesktopRecord,packet:CloudDiagnosticPacket):Promise<void>{
    return this.held(async guard=>{
      const record=await this.file.read(guard);if(JSON.stringify(record)!==JSON.stringify(expected)||!this.diagnosticMatches(packet,expected))
        throw Error('cloud_pairing_source_changed')
      const old=await this.diagnostic.read(guard)
      await this.diagnostic.write({contract:'dshos-cloud-diagnostic-record-v1',packet},old,guard)
    })
  }
  activate(expected: CloudDesktopRecord, request: CloudRequest, replyText: string, now: () => number,
    assertFresh: () => void, trustStore: PairingTrustStore, invalidatePrevious: () => void): Promise<void> {
    return this.held(async guard => {
      const check = () => {guard.assertHeld();assertFresh()}
      await this.assertRetirementComplete(guard)
      check(); const record=await this.file.read(guard); check()
      if (!record || JSON.stringify(record)!==JSON.stringify(expected) || !record.savedReplyText) throw Error('cloud_pairing_source_changed')
      const old=await this.legacy(guard); check(); assertCloudLegacy(record,old)
      const receipt=cloudBindingReceipt(cloudHistoricalReply(record.savedReplyText,this.options.trust,record))
      const current=readCloudCurrent(replyText,request,receipt,this.options.trust,now())
      const c=current.computer as CloudPayload, b=current.body as CloudPayload
      const registry: ComputerRegistry={contract:'dshos-computer-registry-v2',computerId:record.desktop.computerId,
        accountBindingId:c.accountBindingId as string,registrationGeneration:c.registrationGeneration as string,
        registrationPrivateKey:record.registrationPrivateKey,registrationPublicKey:record.desktop.registrationPublicKey,
        members:(current.members as CloudPayload[]).map(m=>({platform:m.platform as 'dsh'|'pi',memberId:m.memberId as string,
          publicKey:m.memberPublicKey as string,keyGeneration:m.keyGeneration as string,
          pairingState:old.registry?.members.find(v=>v.platform===m.platform&&v.memberId===m.memberId&&v.publicKey===m.memberPublicKey&&v.keyGeneration===m.keyGeneration)?.pairingState??'unpaired'}))}
      if (!validComputerRegistry(registry) || old.registry && (old.registry.accountBindingId!==registry.accountBindingId ||
        old.registry.members.some(previous=>!registry.members.some(member=>member.platform===previous.platform&&member.memberId===previous.memberId&&
          member.publicKey===previous.publicKey&&member.keyGeneration===previous.keyGeneration)))) throw Error('cloud_pairing_registry_scope')
      const existing=trustStore.read(), same=existing?.pairingId===record.desktop.pairingId && existing.mobilePublicKeyRaw===receipt.manifest.mobilePublicKey
      if (existing && (!same && (b.purpose!=='restoreDshPairing'||existing.pairingId!==b.oldPairingId) || same&&existing.status!=='active'))
        throw Error('cloud_pairing_local_binding_changed')
      // Persist registry before publishing business trust. Recovery repeats fresh
      // authority checks; it never restores a stale database or deletes old keys.
      let persisted=old.registry===null?null:JSON.stringify(old.registry)
      if(JSON.stringify(registry)!==persisted){
        await this.registry.write(registry,{assertHeld:check});check();persisted=JSON.stringify(registry)
      }
      check()
      if (!same) { invalidatePrevious();check();trustStore.replace({pairingVersion:1,pairingId:record.desktop.pairingId,
        mobilePublicKeyRaw:receipt.manifest.mobilePublicKey as string,createdAt:now(),updatedAt:now(),status:'active'}) }
      registry.members.find(m=>m.platform==='dsh')!.pairingState='active'
      if(JSON.stringify(registry)!==persisted)await this.registry.write(registry,{assertHeld:check})
      check()
    })
  }
}
