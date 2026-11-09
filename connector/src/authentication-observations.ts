import { AuthenticationTraceRecorder, type AuthenticationTrace } from './authentication-trace.js'
export type AuthenticationObserver = (id:string,stage:string,result:string)=>void
/** Bounded, untrusted correlation hints. They never select an account or grant access. */
export class AuthenticationObservations {
  private traces=new Map<string,AuthenticationTraceRecorder>()
  private owner:string|undefined
  constructor(private readonly now=()=>performance.now(),private readonly scope=()=>''){}
  private checkScope():void{const owner=this.scope();if(this.owner!==owner){this.traces.clear();this.owner=owner}}
  readonly observe:AuthenticationObserver=(id,stage,result)=>{
    this.checkScope()
    if(!/^[A-Za-z0-9_-]{21}[AQgw]$/.test(id))return
    let trace=this.traces.get(id)
    if(!trace){trace=new AuthenticationTraceRecorder(id,'desktop',this.now);this.traces.set(id,trace)}
    trace.record(stage,result)
    while(this.traces.size>3)this.traces.delete(this.traces.keys().next().value!)
  }
  reset():void{this.traces.clear()}
  trace(id:string):AuthenticationTrace|undefined{this.checkScope();return this.traces.get(id)?.snapshot()}
  snapshot():AuthenticationTrace[]{this.checkScope();return [...this.traces.values()].map(t=>t.snapshot()).filter(t=>t.events.length>0)}
}
