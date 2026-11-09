import { Service,type Context } from '@deepseek-ai/cordis'
import type { RelayConnectorCredentialStore } from './relay-connector-credential.js'
import type { ServiceAccessView } from './service-access.js'
/** Local DSH settings only. No LAN endpoint and no administrative operations. */
export class ServiceAccessRemote extends Service {
  readonly typertRemote:{service:ServiceAccessRemote;serviceKey:'dshosServiceAccess';namespace:'dshosServiceAccess'}
  constructor(ctx:Context,private readonly store:()=>RelayConnectorCredentialStore|undefined){
    super(ctx,'dshosServiceAccess');this.typertRemote={service:this,serviceKey:'dshosServiceAccess',namespace:'dshosServiceAccess'}
  }
  status():ServiceAccessView{return this.store()?.serviceAccess().view()??{message:'',restricted:false,needsCheck:false,checking:false,retryAfterMs:0}}
  async refresh():Promise<ServiceAccessView>{
    const store=this.store();if(!store)return this.status()
    await store.refreshServiceAccess(true).catch(()=>{})
    return this.status()
  }
}
