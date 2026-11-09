// Observations only: never credentials, authorization or raw HTTP messages.
export interface AuthenticationTraceEvent { stage: string; result: string; elapsedMs: number; }
export interface AuthenticationTrace { id: string; role: string; events: AuthenticationTraceEvent[]; }
const PHONE_STAGES: string[] = ['prepare','start_send','challenge_received','sign','response_send','result_received','relay_open','probe_send','probe_received'];
const DESKTOP_STAGES: string[] = ['start_received','challenge_written','response_received','result_written','probe_received','probe_written'];
const RESULTS: string[] = ['started','ok','network','timeout','tls','cancelled','rejected','invalid','unknown'];
export function validAuthenticationTrace(value: AuthenticationTrace): boolean {
  if(value===null||typeof value!=='object'||Object.keys(value).sort().join(',')!=='events,id,role'||
    typeof value.id!=='string'||!(/^[A-Za-z0-9_-]{21}[AQgw]$/).test(value.id)||
    !['phone','desktop'].includes(value.role)||!Array.isArray(value.events)||value.events.length<1||value.events.length>12)return false;
  const stages=value.role==='phone'?PHONE_STAGES:DESKTOP_STAGES;
  let previous:number=-1;
  for(const event of value.events){
    if(event===null||typeof event!=='object'||Object.keys(event).sort().join(',')!=='elapsedMs,result,stage'||
      !stages.includes(event.stage)||!RESULTS.includes(event.result)||!Number.isSafeInteger(event.elapsedMs)||
      event.elapsedMs<0||event.elapsedMs<previous||event.elapsedMs>120000)return false;
    previous=event.elapsedMs;
  }
  return true;
}
export class AuthenticationTraceRecorder {
  private readonly started:number;
  private readonly events:AuthenticationTraceEvent[]=[];
  constructor(private readonly id:string,private readonly role:string,private readonly clock:()=>number){this.started=clock();}
  record(stage:string,result:string):void{
    const elapsedMs=Math.max(this.events[this.events.length-1]?.elapsedMs??0,Math.min(120000,Math.max(0,Math.floor(this.clock()-this.started))));
    const event:AuthenticationTraceEvent={stage,result,elapsedMs};
    const next:AuthenticationTrace={id:this.id,role:this.role,events:[event]};
    if(!validAuthenticationTrace(next)||this.events.length>=12)return;
    this.events.push(event);
  }
  snapshot():AuthenticationTrace{return {id:this.id,role:this.role,events:this.events.map((e:AuthenticationTraceEvent):AuthenticationTraceEvent=>({stage:e.stage,result:e.result,elapsedMs:e.elapsedMs}))};}
}
