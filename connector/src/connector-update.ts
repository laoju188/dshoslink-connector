import { Service, type Context } from '@deepseek-ai/cordis'
import { ConnectorUpgrade, type UpgradeStart } from './connector-upgrade.js'
import { CONNECTOR_VERSION } from './connector-metadata.js'
import type { UpdateReason, UpdateEvent, MaintenanceHistory } from './maintenance-diagnostic.js'

const REGISTRY_LATEST = 'https://registry.npmjs.org/@dshos-link%2fconnector/latest'
export type ConnectorUpdateSnapshot = {
  readonly status: 'checking' | 'available' | 'current' | 'unavailable'
  readonly currentVersion: string
  readonly latestVersion: string
}

import { isNewerStableVersion } from './client/update-version.js'
export { isNewerStableVersion } from './client/update-version.js'

class CheckFailure extends Error {
  constructor(readonly reason:UpdateReason,readonly retryable=false){super(reason)}
}
function classify(error:unknown):CheckFailure {
  if(error instanceof CheckFailure)return error
  const value=error as {code?:unknown;cause?:{code?:unknown};message?:unknown}
  const code=value?.cause?.code??value?.code
  if(['ENOTFOUND','EAI_AGAIN'].includes(code as string))return new CheckFailure('dns',true)
  if(['UND_ERR_CONNECT_TIMEOUT','ETIMEDOUT'].includes(code as string))return new CheckFailure('timeout',true)
  if(['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code as string))return new CheckFailure('tls')
  if(['ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET'].includes(code as string))return new CheckFailure('connection',true)
  // fetch's redirect:error failure has no stable error code in the host Node.
  if(value?.cause&&'message' in value.cause&&value.cause.message==='unexpected redirect')return new CheckFailure('redirect')
  return new CheckFailure('unknown',true)
}

/** At most two bounded requests. Last verified metadata survives a failed refresh. */
export class ConnectorUpdateCheck {
  private value:ConnectorUpdateSnapshot
  private controller:AbortController|null=null
  private pending:Promise<void>|null=null
  private disposed=false
  private history:MaintenanceHistory<UpdateEvent>|undefined
  readonly ready:Promise<void>
  constructor(private readonly currentVersion=CONNECTOR_VERSION,private readonly request:typeof fetch=fetch,
    private readonly timeoutMs=5000,private readonly retryDelayMs=250) {
    this.value={status:'checking',currentVersion,latestVersion:''}
    this.ready=this.refresh()
  }
  snapshot():ConnectorUpdateSnapshot {return {...this.value}}
  diagnostic():MaintenanceHistory<UpdateEvent>|undefined {return this.history?structuredClone(this.history):undefined}
  refresh():Promise<void> {
    if(this.disposed)return Promise.resolve()
    if(this.pending)return this.pending
    this.value={...this.value,status:'checking'}
    this.pending=this.check().finally(()=>{this.pending=null})
    return this.pending
  }
  dispose():void {this.disposed=true;this.controller?.abort();this.value={...this.value,status:'unavailable'}}
  private async check():Promise<void> {
    const start=performance.now();let failure=new CheckFailure('unknown'),attempts=0
    for(let i=0;i<2&&!this.disposed;i++) {
      attempts++
      try {
        const latest=await this.attempt()
        if(this.disposed)return
        this.value={status:isNewerStableVersion(this.currentVersion,latest)?'available':'current',currentVersion:this.currentVersion,latestVersion:latest}
        const event:UpdateEvent={atMs:Date.now(),result:'ok',reason:'none',attempts,elapsedMs:Math.min(30000,Math.round(performance.now()-start))}
        this.history={last:event,lastFailure:this.history?.lastFailure??null}
        return
      } catch(error) {
        failure=classify(error)
        if(!this.disposed){const event:UpdateEvent={atMs:Date.now(),result:'failed',reason:failure.reason,attempts,elapsedMs:Math.min(30000,Math.round(performance.now()-start))};this.history={last:event,lastFailure:event}}
        if(!failure.retryable||this.disposed||i===1)break
        await new Promise<void>(resolve=>setTimeout(resolve,this.retryDelayMs))
      }
    }
    if(this.disposed)return
    const event:UpdateEvent={atMs:Date.now(),result:'failed',reason:failure.reason,attempts,elapsedMs:Math.min(30000,Math.round(performance.now()-start))}
    this.history={last:event,lastFailure:event}
    this.value={...this.value,status:'unavailable'}
  }
  private async attempt():Promise<string> {
    const controller=new AbortController();this.controller=controller
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
    const interrupted=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new CheckFailure('timeout',true)),{once:true}))
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);timer.unref?.()
    const work=(async()=>{
      const response=await this.request(REGISTRY_LATEST,{signal:controller.signal,redirect:'error',credentials:'omit',headers:{Accept:'application/json'}})
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new CheckFailure('timeout',true)}
      if(!response.ok){void response.body?.cancel().catch(()=>{});throw new CheckFailure(response.status===429?'rate_limited':response.status>=300&&response.status<400?'redirect':'http',response.status>=500||response.status===408)}
      if(!response.body||Number(response.headers.get('content-length'))>65536){void response.body?.cancel().catch(()=>{});throw new CheckFailure('response')}
      reader=response.body.getReader()
      const decoder=new TextDecoder('utf-8',{fatal:true})
      let size=0,body=''
      while(true){
        // Stream transport errors retain their network cause. Only decoding and
        // metadata validation below count as a non-retryable response failure.
        const part=await reader.read()
        if(controller.signal.aborted)throw new CheckFailure('timeout',true)
        if(part.done)break
        size+=part.value.byteLength
        if(size>65536)throw new CheckFailure('response')
        try{body+=decoder.decode(part.value,{stream:true})}catch{throw new CheckFailure('response')}
      }
      let metadata:unknown
      try{body+=decoder.decode();metadata=JSON.parse(body)}catch{throw new CheckFailure('response')}
      if(!metadata||typeof metadata!=='object'||!('name' in metadata)||metadata.name!=='@dshos-link/connector'
        ||!('version' in metadata)||typeof metadata.version!=='string'||!/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?![\s\S])/.test(metadata.version))throw new CheckFailure('response')
      return metadata.version
    })()
    try{return await Promise.race([work,interrupted])}
    finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});if(this.controller===controller)this.controller=null}
  }
}

// DSH host UI remote only; not part of the paired phone or relay protocol.
export class ConnectorUpdateRemote extends Service {
  private readonly upgrader:ConnectorUpgrade
  readonly typertRemote: { service: ConnectorUpdateRemote; serviceKey: 'dshosUpdate'; namespace: 'dshosUpdate' }
  constructor(ctx: Context, private readonly checker: ConnectorUpdateCheck) {
    super(ctx, 'dshosUpdate')
    this.upgrader=new ConnectorUpgrade(ctx,checker)
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'dshosUpdate', namespace: 'dshosUpdate' })
  }
  async snapshot(): Promise<ConnectorUpdateSnapshot> {
    await this.checker.ready
    return this.checker.snapshot()
  }
  async check(): Promise<ConnectorUpdateSnapshot> {
    await this.checker.refresh()
    return this.checker.snapshot()
  }
  upgrade():Promise<UpgradeStart>{
    const principal=(this.ctx as unknown as {invocation?:{peer?:{principal?:{kind:string}}}}).invocation?.peer?.principal
    if(principal&&principal.kind!=='owner')return Promise.resolve({started:false,reason:'owner-required'})
    return this.upgrader.start()
  }
}

export function registerConnectorUpdate(ctx: Context): ConnectorUpdateCheck {
  const check = new ConnectorUpdateCheck()
  new ConnectorUpdateRemote(ctx, check)
  ctx.effect(() => () => check.dispose(), 'dshos-link-update-check')
  return check
}
