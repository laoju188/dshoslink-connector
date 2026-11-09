import type {EntryEvent} from './pairing-entry-observation.js'
import { Service,type Context } from '@deepseek-ai/cordis'
import { CloudPairingHost,type CloudPairingEntryReceipt } from './cloud-pairing-host.js'

/** Local authenticated DSH settings bridge only. Never registered in LAN/relay routes. */
export class CloudPairingRemote extends Service {
  readonly typertRemote:{service:CloudPairingRemote;serviceKey:'dshosCloudPairing';namespace:'dshosCloudPairing'}
  constructor(ctx:Context,private readonly host:CloudPairingHost){
    super(ctx,'dshosCloudPairing')
    this.typertRemote=Object.freeze({service:this,serviceKey:'dshosCloudPairing',namespace:'dshosCloudPairing'})
  }
  openView(){return this.host.openView()}
  /** Internal upgrade preflight only; not a phone or public Remote method. */
  canUpgrade():boolean{return !['loading','waiting','completing'].includes(this.host.snapshot().phase)}
  observeEntry(viewId:number,event:EntryEvent,cycle?:number){return this.host.observeEntry(viewId,event,cycle)}
  status(viewId:number){return this.host.status(viewId)}
  claim(viewId:number,code:string,entry?:CloudPairingEntryReceipt){return this.host.claim(code,viewId,entry)}
  cancel(viewId:number){return this.host.cancel(viewId)}
  suspend(viewId:number):{suspended:true}{this.host.detach(viewId);return {suspended:true}}
}
