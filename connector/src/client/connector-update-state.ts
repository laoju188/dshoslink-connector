import { CONNECTOR_VERSION } from '../connector-metadata.js'
import { isNewerStableVersion } from './update-version.js'
import type { ConnectorUpdateSnapshot } from '../connector-update.js'
type UpdateResult={readonly ok:true;readonly value:ConnectorUpdateSnapshot}|{readonly ok:false;readonly error:unknown}
export interface ConnectorUpdateRemoteClient {snapshot():Promise<UpdateResult>;check():Promise<UpdateResult>;
  upgrade?():Promise<{ok:true;value:{started:boolean;reason:string}}|{ok:false;error:unknown}>}
export class ConnectorUpdateState {
  private value:ConnectorUpdateSnapshot|null=null
  private bridgeFailure:number|undefined
  bridgeFailureAtMs():number|undefined{return this.bridgeFailure}
  private listeners=new Set<()=>void>()
  private operation:Promise<void>|undefined
  constructor(private readonly remote:ConnectorUpdateRemoteClient){}
  snapshot():ConnectorUpdateSnapshot|null{return this.value}
  subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return()=>{this.listeners.delete(fn)}}
  private set(value:ConnectorUpdateSnapshot):void{this.value=value;for(const fn of this.listeners)fn()}
  load():Promise<void>{return this.value?Promise.resolve():this.run(false)}
  check():Promise<void>{return this.run(true)}
  private run(manual:boolean):Promise<void>{
    if(this.operation)return this.operation
    this.set({...this.value??{currentVersion:CONNECTOR_VERSION,latestVersion:''},status:'checking'})
    this.operation=Promise.resolve().then(()=>manual?this.remote.check():this.remote.snapshot()).then(result=>{
      if(result.ok)this.set(result.value)
      else {this.bridgeFailure=Date.now();this.set({...this.value!,status:'unavailable'})}
    }).catch(()=>{this.bridgeFailure=Date.now();this.set({...this.value!,status:'unavailable'})}).finally(()=>{this.operation=undefined})
    return this.operation
  }
}
const states=new WeakMap<ConnectorUpdateRemoteClient,ConnectorUpdateState>()
export function connectorUpdateState(remote:ConnectorUpdateRemoteClient):ConnectorUpdateState {
  let state=states.get(remote);if(!state){state=new ConnectorUpdateState(remote);states.set(remote,state)}return state
}
export const knownUpdate=(s:ConnectorUpdateSnapshot):boolean=>isNewerStableVersion(s.currentVersion,s.latestVersion)
