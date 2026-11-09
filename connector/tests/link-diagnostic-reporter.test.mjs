import test from 'node:test'
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomBytes} from 'node:crypto'
import {LinkDiagnosticReporter} from '../dist/link-diagnostic-reporter.js'
import {validLinkObservation} from '../dist/link-observation-contract.js'
const id=()=>randomBytes(16).toString('base64url')
function fixture(){
  const key=generateKeyPairSync('ed25519'),binding={pairingId:id(),mobilePublicKeyRaw:randomBytes(32).toString('base64url')}
  const packets=[];let current=binding,enabled=true,generation=0,reads=0,pending
  const lease={identity:{pairingId:binding.pairingId,memberId:id(),memberPublicKey:key.publicKey.export({format:'jwk'}).x},memberKey:key.privateKey,assertCurrent(){}}
  const observer=()=>{if(!enabled)return;const owner=generation;return p=>{if(enabled&&owner===generation)packets.push(p)}}
  const reporter=new LinkDiagnosticReporter(async()=>{reads++;if(pending)await pending;return lease},()=>current,observer,'0.2.13','PRODUCTION',()=>1000,()=>1000)
  return {reporter,packets,binding,reads:()=>reads,optOut(){enabled=false;generation++},optIn(){enabled=true},change(){current={...binding,pairingId:id()}},wait(p){pending=p}}
}
function auth(traceId=id(),events=[{stage:'start_received',result:'ok',elapsedMs:0}]){return {kind:'authentication',trace:{id:traceId,role:'desktop',events}}}
test('real signed diagnostic coalesces a trace and never claims successful use',async()=>{
  const f=fixture();try{
    const trace=id();f.reporter.record(auth(trace),'lan');f.reporter.record(auth(trace,[{stage:'start_received',result:'ok',elapsedMs:0},{stage:'challenge_written',result:'ok',elapsedMs:2}]),'lan')
    await f.reporter.flush();assert.equal(f.packets.length,1);assert.equal(f.reads(),1)
    assert.ok(validLinkObservation(f.packets[0],1000));assert.equal(f.packets[0].body.connection.evidence,'diagnostic')
    assert.equal(f.packets[0].body.connection.diagnostic.trace.events.length,2)
  }finally{f.reporter.close()}
})
test('opt-out does no key reads, and revoked pending captures do not revive on opt-in',async()=>{
  const f=fixture();try{
    f.optOut();f.reporter.record(auth(),'lan');await f.reporter.flush();assert.equal(f.reads(),0)
    f.optIn();f.reporter.record(auth(),'lan');f.optOut();f.optIn();await f.reporter.flush();assert.equal(f.packets.length,0)
  }finally{f.reporter.close()}
})
test('a changed binding while loading credentials cannot publish old diagnosis',async()=>{
  const f=fixture();let resolve;f.wait(new Promise(r=>resolve=r));try{
    f.reporter.record(auth(),'lan');const task=f.reporter.flush();f.change();resolve();await task;assert.equal(f.packets.length,0)
  }finally{f.reporter.close()}
})
test('diagnostic floods are bounded without creating an extra retry loop',async()=>{
  const f=fixture();try{
    for(let i=0;i<40;i++){f.reporter.record(auth(),'lan');await f.reporter.flush()}
    assert.equal(f.packets.length,12);assert.equal(f.reads(),12)
    f.reporter.close();f.reporter.record(auth(),'lan');await f.reporter.flush();assert.equal(f.packets.length,12)
  }finally{f.reporter.close()}
})
test('invalid arbitrary text is rejected before any credential read',async()=>{
  const f=fixture();try{f.reporter.record({...auth(),rawError:'sensitive text'},'lan');await f.reporter.flush();assert.equal(f.reads(),0)}finally{f.reporter.close()}
})
