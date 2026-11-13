import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {CompletionJournal,completionProof} from '../src/completion-notifications.js'
import {CriticalNotificationHub,createCriticalNotificationRequestHandler} from '../src/critical-notification.js'
import {SessionStreamMonitor} from '../src/session-stream.js'
import type {RegistrationLease} from '../src/dsh-registration-storage.js'
const owner='synthetic-owner',now=Date.now()
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}) {
 const root=await mkdtemp(join(tmpdir(),'completion-test-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const protector={async protect(p:Buffer){return Buffer.from(p).reverse()},async unprotect(p:Buffer){return Buffer.from(p).reverse()}}
 const prepare=async(d:string)=>{await mkdir(d,{recursive:true})}
 const lock=async()=>({assertHeld(){},async release(){}} as RegistrationLease)
 return {root,journal:()=>new CompletionJournal(root,protector,prepare,lock)}
}
test('completion identity survives reconstruction but distinguishes sequence reuse and sessions',()=>{
 const a=completionProof('a',2,1,now,1)
 assert.deepEqual(completionProof('a',2,1,now,1),a)
 assert.notEqual(completionProof('b',2,1,now,1).eventId,a.eventId)
 assert.notEqual(completionProof('a',2,1,now+1,1).eventId,a.eventId)
 assert.throws(()=>completionProof('a',1,1,now,1))
})
test('protected completion journal survives restart, exact replay and owner separation',async t=>{
 const f=await fixture(t),proof=completionProof('session',3,1,now,2)
 await f.journal().save(owner,proof);await f.journal().save(owner,proof)
 assert.deepEqual(await f.journal().read(owner,undefined,true),[proof]);assert.deepEqual(await f.journal().read('other'),[])
 await f.journal().accepted(owner,proof.eventId);assert.deepEqual(await f.journal().read(owner,undefined,true),[])
 assert.deepEqual(await f.journal().read(owner,[proof.eventId]),[proof]);await f.journal().markRead(owner,[proof.eventId])
 await assert.rejects(f.journal().save(owner,{...proof,sessionId:'replacement'}))
 const path=join(f.root,createHash('sha256').update(owner).digest('hex'),proof.eventId+'.bin')
 const bytes=await readFile(path);assert.equal(bytes.includes(Buffer.from('session')),false)
 await writeFile(path,'damaged');await assert.rejects(f.journal().read(owner,[proof.eventId]));assert.equal(await readFile(path,'utf8'),'damaged')
})
test('V1 stays exact; V2 proof and read cleanup require the same authenticated connection',async t=>{
 const f=await fixture(t);let current=owner,allowed=true
 const hub=new CriticalNotificationHub(()=>now,undefined,f.journal(),()=>current),proof=completionProof('a',2,1,now,1)
 await hub.emitCompletion(proof);const h=createCriticalNotificationRequestHandler({authorize:()=>allowed},hub)
 const request=(body:unknown)=>({method:'POST',path:'/dshos/v1/critical-notifications',contentType:'application/json',body:Buffer.from(JSON.stringify(body))})
 const legacy=await h(request({type:'critical_notification_resolve_request',protocolVersion:1,eventId:proof.eventId}))
 assert.deepEqual(Object.keys(JSON.parse(String(legacy.body)).event),['eventId','eventType','sessionId'])
 const q={type:'completion_resolve_request',protocolVersion:2,eventIds:[proof.eventId],readEventIds:[]}
 assert.deepEqual(JSON.parse(String((await h(request(q))).body)).events,[proof])
 allowed=false;assert.equal((await h(request(q))).status,401)
 allowed=true;current='other';assert.deepEqual(JSON.parse(String((await h(request(q))).body)).events,[])
 assert.equal((await h(request({...q,eventIds:['bad']}))).status,400)
})
test('real host event projection maps final visible assistant reply, never reasoning-only or cancelled work',async()=>{
 const proofs:unknown[]=[];let release!:()=>void
 const stream=new SessionStreamMonitor((_session,_seq,kind,proof)=>{if(kind==='completed')proofs.push(proof)})
 const data=[
  ['turn/start',{turn:1}],['assistant/message',{turn:1,step:0,message:{role:'assistant',content:[{type:'reasoning',text:'private'}]}}],['turn/end',{turn:1,reason:{kind:'completed'}}],
  ['turn/start',{turn:2}],['assistant/message',{turn:2,step:0,message:{role:'assistant',content:[{type:'text',text:'reply'}]}}],['turn/end',{turn:2,reason:{kind:'completed'}}],
 ] as const
 const detach=stream.attach({events:{async *mux(){for(let i=0;i<data.length;i++)yield {rpcId:'r',payload:{type:'session/event',sessionId:'a',event:{type:data[i]![0],seq:i+1,time:now+i,data:data[i]![1]}}};await new Promise<void>(r=>{release=r})}}})
 await new Promise(r=>setImmediate(r));assert.equal(proofs.length,2);assert.equal(proofs[0],undefined)
 assert.deepEqual(proofs[1],completionProof('a',6,2,now+5,5));detach();release()
})

test('completion resolve shares a single lease for 50 proofs and 100 retirements',async t=>{
 const f=await fixture(t),journal=f.journal();const proofs=Array.from({length:150},(_,i)=>completionProof('session',i*2+2,i,now+i,i*2+1));
 for(const proof of proofs)await journal.save(owner,proof);
 let leases=0;
 const resolving=new CompletionJournal(f.root,{async protect(b){return Buffer.from(b).reverse()},async unprotect(b){return Buffer.from(b).reverse()}},
  async d=>{await mkdir(d,{recursive:true})},async()=>{leases++;return {assertHeld(){},async release(){}}});
 assert.deepEqual(await resolving.resolve(owner,proofs.slice(0,50).map(p=>p.eventId),proofs.slice(50).map(p=>p.eventId),()=>{}),proofs.slice(0,50));
 assert.equal(leases,1);assert.deepEqual(await journal.read(owner,proofs.map(p=>p.eventId).slice(0,100)),proofs.slice(0,100));
 assert.deepEqual(await resolving.resolve(owner,[],[],()=>{}),[]);assert.equal(leases,1);
})

for(const boundary of ['cancel','owner','authorization'])test(`completion resolve stops inside protected reads on ${boundary} change`,async t=>{
 const f=await fixture(t),proof=completionProof('session',2,1,now,1);await f.journal().save(owner,proof);
 const abort=new AbortController();let current=owner,allowed=true,reads=0,released=0;
 const journal=new CompletionJournal(f.root,{async protect(b){return Buffer.from(b).reverse()},async unprotect(b){
  reads++;if(boundary==='cancel')abort.abort();if(boundary==='owner')current='other';if(boundary==='authorization')allowed=false;
  return Buffer.from(b).reverse();}},async d=>{await mkdir(d,{recursive:true})},async()=>({assertHeld(){},async release(){released++}}));
 const hub=new CriticalNotificationHub(()=>now,undefined,journal,()=>current);
 await assert.rejects(hub.completions([proof.eventId],[proof.eventId],abort.signal,()=>allowed),/completion_/);
 assert.equal(reads,1);assert.equal(released,1);assert.deepEqual(await f.journal().read(owner,[proof.eventId]),[proof]);
})

test('already cancelled or expired authorization cannot retire a record',async t=>{
 const f=await fixture(t),proof=completionProof('session',2,1,now,1);await f.journal().save(owner,proof);
 const hub=new CriticalNotificationHub(()=>now,undefined,f.journal(),()=>owner),abort=new AbortController();abort.abort();
 await assert.rejects(hub.completions([], [proof.eventId],abort.signal),/cancelled/);
 await assert.rejects(hub.completions([], [proof.eventId],undefined,()=>false),/owner_changed/);
})
