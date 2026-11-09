import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectorUpdateCheck } from './connector-update.js'
import { readRuntimeDshVersion } from './runtime-version.js'
import { assertUpgradePreflight, UpgradePreflightError } from './connector-upgrade-preflight.js'
import { helperCanMigrate, inactiveHelperCanMigrate, isKnownLegacyHelper, withInactiveHelperLock, type HelperCoordinator } from './connector-upgrade-helper.js'
import { supportsInAppUpgrade, UPGRADE_HELPER_VERSION } from './connector-upgrade-policy.js'

export type UpgradeStart = { started: boolean; reason: string }
type UpgradeService = { start(): unknown; helperVersion?: string; coordinator?: HelperCoordinator }
type Bundle = {name:string;version?:string;enabled:boolean;error?:unknown}
type Manager = { listBundles(): Bundle[]|Promise<Bundle[]>;
  installBundle(spec:string, options:{enabled:boolean;saveExact:boolean;requestId:string}):Promise<{application:string}> }
const NAME='@dshos-link/connector-updater'
/** Bootstrap once, on an owner click. The independent bundle owns all subsequent connector replacement. */
export class ConnectorUpgrade {
  private pending:Promise<UpgradeStart>|undefined
  constructor(private readonly ctx:Context,private readonly checker:ConnectorUpdateCheck,
    private readonly hostVersion:()=>string=readRuntimeDshVersion){}
  start():Promise<UpgradeStart> {
    const principal=(this.ctx as unknown as {invocation?:{peer?:{principal?:{kind:string}}}}).invocation?.peer?.principal
    if(principal&&principal.kind!=='owner')return Promise.resolve({started:false,reason:'owner-required'})
    if(this.pending)return this.pending
    this.pending=this.run().catch(error=>({started:false,reason:error instanceof UpgradePreflightError?error.code:'upgrade-unavailable'})).finally(()=>{this.pending=undefined})
    return this.pending
  }
  private async run():Promise<UpgradeStart>{
    await this.checker.refresh()
    if(this.checker.snapshot().status!=='available')return {started:false,reason:'no-update'}
    const manager=this.ctx.get('pluginManager') as Manager|undefined
    const profile=this.ctx.get('profileContext') as {dir:string}|undefined
    const hostVersion=this.hostVersion()
    if(!manager||!profile||!this.ctx.get('hmr')||!supportsInAppUpgrade(hostVersion))return {started:false,reason:'host-not-supported'}
    const check=async()=>{
      if(this.hostVersion()!==hostVersion)throw new UpgradePreflightError('host-changed')
      await assertUpgradePreflight(this.ctx,hostVersion)
      if((this.ctx.get('profileContext') as {dir?:string}|undefined)?.dir!==profile.dir)throw new UpgradePreflightError('profile-changed')
    }
    await check()
    let service=this.ctx.get('dshosUpgrade') as UpgradeService|undefined
    if(service && service.helperVersion!==UPGRADE_HELPER_VERSION){
      const bundle=(await manager.listBundles()).find(b=>b.name===NAME)
      // Applied files with an old imported namespace require a normal restart,
      // never another replacement or a claim that the new helper is running.
      if(bundle?.enabled&&!bundle.error&&bundle.version===UPGRADE_HELPER_VERSION)return {started:false,reason:'restart-required'}
      const oldService=service,coordinator=oldService.coordinator
      if(!bundle?.enabled||bundle.error||!coordinator||!isKnownLegacyHelper(profile.dir,bundle.version)
        ||(service.helperVersion!==undefined&&service.helperVersion!==bundle.version))return {started:false,reason:'updater-not-ready'}
      if(!helperCanMigrate(coordinator))return {started:false,reason:'updater-not-ready'}
      // A loaded helper may never have run an upgrade. Its official writer lock
      // requires the parent directory, but no journal should be invented here.
      mkdirSync(join(profile.dir,'.dshos-link','plugin-updater-v1'),{recursive:true})
      const migrated=await coordinator.io.exclusive(async()=>{
        await check()
        // Cordis may return a fresh context proxy on each lookup; the owned
        // coordinator identifies the service generation, not proxy identity.
        if((this.ctx.get('dshosUpgrade') as UpgradeService|undefined)?.coordinator!==coordinator||!helperCanMigrate(coordinator)||!isKnownLegacyHelper(profile.dir,bundle.version))return 'updater-not-ready'
        const result=await this.installHelper(manager,profile.dir)
        return result.application==='applied'?'':result.application==='restart-required'?'restart-required':'updater-not-ready'
      })
      if(migrated)return {started:false,reason:migrated}
      service=this.ctx.get('dshosUpgrade') as UpgradeService|undefined
      if(service?.helperVersion!==UPGRADE_HELPER_VERSION)return {started:false,reason:'restart-required'}
    }
    if(!service){
      const bundle=(await manager.listBundles()).find(b=>b.name===NAME)
      let result:{application:string}
      if(bundle){
        if(!bundle.enabled||!isKnownLegacyHelper(profile.dir,bundle.version))return {started:false,reason:'updater-not-ready'}
        result=await withInactiveHelperLock(profile.dir,async()=>{
          await check()
          const current=(await manager.listBundles()).find(b=>b.name===NAME)
          if(this.ctx.get('dshosUpgrade')||!current?.enabled||current.version!==bundle.version||!inactiveHelperCanMigrate(profile.dir)||!isKnownLegacyHelper(profile.dir,current.version))return {application:'failed'}
          return this.installHelper(manager,profile.dir)
        })
      }else { await check(); result=await this.installHelper(manager,profile.dir) }
      if(result.application!=='applied')return {started:false,reason:result.application==='restart-required'?'restart-required':'updater-not-ready'}
      service=this.ctx.get('dshosUpgrade') as UpgradeService|undefined
    }
    if(!service || service.helperVersion!==UPGRADE_HELPER_VERSION)return {started:false,reason:'updater-not-ready'}
    await check()
    const result=await service.start() as {phase?:string}|undefined
    if(result?.phase==='recovery-unavailable')return {started:false,reason:'journal-unavailable'}
    return {started:true,reason:''}
  }
  private async installHelper(manager:Manager,profileDir:string):Promise<{application:string}>{
      const payload=JSON.parse(readFileSync(new URL('./updater-payload.json',import.meta.url),'utf8')) as {name:string;version:string;sha256:string}
      const bytes=readFileSync(new URL('./updater.tgz',import.meta.url))
      if(payload.name!==NAME||payload.version!==UPGRADE_HELPER_VERSION||createHash('sha256').update(bytes).digest('hex')!==payload.sha256)throw Error('invalid-updater')
      const dir=join(profileDir,'.dshos-link','plugin-updater-v1','bootstrap');mkdirSync(dir,{recursive:true})
      const file=join(dir,`updater-${payload.sha256}.tgz`)
      if(existsSync(file)&&(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()))throw Error('invalid-updater-cache')
      if(!existsSync(file)||createHash('sha256').update(readFileSync(file)).digest('hex')!==payload.sha256){
        const tmp=`${file}.${randomUUID()}.tmp`,fd=openSync(tmp,'wx',0o600)
        try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}
        renameSync(tmp,file)
      }
      if(createHash('sha256').update(readFileSync(file)).digest('hex')!==payload.sha256)throw Error('invalid-updater-cache')
      return manager.installBundle(`file:${file}`,{enabled:true,saveExact:true,requestId:`dshos-updater-bootstrap-${payload.sha256}`})
  }
}
