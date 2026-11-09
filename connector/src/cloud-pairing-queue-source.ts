import { join } from 'node:path'
import { CloudDesktopVault, type CloudDesktopVaultOptions } from './cloud-pairing-vault.js'
import { cloudHistoricalReply } from './cloud-pairing-record.js'
import { cloudBindingReceipt, validateCloudReceipt } from './cloud-pairing-current.js'
import type { DshQueueIdentitySource, DshQueueMaterial } from './dsh-message-queue-identity.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import { existsSync } from 'node:fs'
import { createDshQueueIdentityLoader, type DshQueueIdentityLease } from './dsh-message-queue-identity.js'

export function cloudDshQueueSource(options: CloudDesktopVaultOptions,
  currentBinding: () => PairingAuthorizationBinding | undefined): DshQueueIdentitySource {
  const vault=new CloudDesktopVault(options)
  return {kind:'cloud',maximumMaterialBytes:32768,registry:vault.registry,
    material:{path:join(options.directory,'record-v3.sealed'),async read():Promise<DshQueueMaterial|null>{
      options.assertCurrent();const current=currentBinding();if(!current)return null
      const record=await vault.read();options.assertCurrent()
      if(!record||record.desktop.pairingId!==current.pairingId)return null
      if(!record.savedReplyText||record.journal?.last?.state==='revoked')throw Error('queue_identity_changed')
      const receipt=cloudBindingReceipt(cloudHistoricalReply(record.savedReplyText,options.trust,record)),body=validateCloudReceipt(receipt)
      if(receipt.manifest.mobilePublicKey!==current.mobilePublicKeyRaw)throw Error('queue_identity_changed')
      return {computerId:record.desktop.computerId,memberId:record.desktop.memberId,pairingId:record.desktop.pairingId,
        mobilePublicKey:receipt.manifest.mobilePublicKey as string,accountBindingId:body.accountBindingId as string,
        registrationGeneration:body.registrationGeneration as string,registrationPublicKey:record.desktop.registrationPublicKey,
        memberPrivateKey:record.memberPrivateKey,memberPublicKey:record.desktop.memberPublicKey}
    }}}
}

/** Existing authorized V2 conversations do not wait for V3 cloud reads or touch
 * an unrelated pending record. A cloud binding still validates all old keys. */
export function createCloudCompatibleQueueLoader(legacy:readonly DshQueueIdentitySource[],cloud:DshQueueIdentitySource,
  current:()=>PairingAuthorizationBinding|undefined,guard:()=>void):()=>Promise<DshQueueIdentityLease>{
  const old=createDshQueueIdentityLoader(legacy,current,guard),modern=createDshQueueIdentityLoader([...legacy,cloud],current,guard)
  return async()=>{try{return await old()}catch(error){guard();
    if(!existsSync(cloud.material.path)&&!existsSync(cloud.material.path+'.tmp'))throw error
    return modern()
  }}
}

export function lazyCloudQueueSource(directory:string,registryDirectory:string,load:()=>Promise<CloudDesktopVaultOptions>,
  current:()=>PairingAuthorizationBinding|undefined):DshQueueIdentitySource{
  let source:DshQueueIdentitySource|undefined
  let pending:Promise<DshQueueIdentitySource>|undefined
  const get=async()=>{
    if(source)return source
    if(!pending)pending=load().then(options=>{
      if(options.directory!==directory||options.registryDirectory!==registryDirectory)throw Error('cloud_pairing_source_changed')
      source=cloudDshQueueSource(options,current);return source
    }).finally(()=>{pending=undefined})
    return pending
  }
  return {kind:'cloud',maximumMaterialBytes:32768,
    material:{path:join(directory,'record-v3.sealed'),read:async()=>{
      if(!existsSync(join(directory,'record-v3.sealed'))&&!existsSync(join(directory,'record-v3.sealed.tmp')))return null
      return (await get()).material.read()
    }},registry:{path:join(registryDirectory,'computer-registry-v2.json'),read:async()=> (await get()).registry.read()}}
}
