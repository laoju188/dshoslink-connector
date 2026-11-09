import test from 'node:test';
import assert from 'node:assert/strict';
import { UpgradeCoordinator, UpgradeRefusal, newer } from '../updater/src/core.mjs';
import { metadata, packageManifest, cacheArchive, validateCached, download, backupPackage } from '../updater/src/archive.mjs';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

function fixture(overrides={}) {
  const calls=[], saved=[];
  let current={exists:true,version:'0.2.4',loadedVersion:'0.2.4',active:true,source:'file:old.tgz',protected:'unchanged'};
  const io={read:()=>null,write:job=>saved.push(structuredClone(job)),exclusive:fn=>fn(),preflight:async()=>'0.2.1-rc.3',assertCompatible:async()=>{},current:async()=>({...current}),
    latest:async()=>({version:'0.2.5'}),backup:async()=>({version:'0.2.4'}),download:async()=>({version:'0.2.5'}),validateCached:async()=>{},
    assertProtected:async value=>assert.equal(value,'unchanged'),assertPrevious:async()=>{},
    remove:async()=>{calls.push('remove');current={...current,exists:false,version:'',loadedVersion:'',active:false};return {application:'applied'};},
    install:async record=>{calls.push(`install:${record.version}`);current={...current,exists:true,version:record.version,loadedVersion:record.version,active:true};return {application:'applied'};},
    verify:async version=>current.active&&current.version===version&&current.loadedVersion===version,...overrides};
  const runner=new UpgradeCoordinator(io);
  return {io,runner,calls,saved,setCurrent:value=>{current={...current,...value};}};
}
async function finish(f){f.runner.start();await f.runner.pending;return f.runner.snapshot();}
test('one click prepares both archives before removing, then verifies actual runtime',async()=>{
  const f=fixture();f.io.backup=async()=>{f.calls.push('backup');return {version:'0.2.4'};};f.io.download=async()=>{f.calls.push('download');return {version:'0.2.5'};};
  assert.equal((await finish(f)).phase,'succeeded');assert.deepEqual(f.calls,['backup','download','remove','install:0.2.5']);
  assert.deepEqual(f.saved.map(s=>s.phase),['preparing','removing','installing','verifying','succeeded']);
});
test('two clicks share one operation',async()=>{const f=fixture();f.runner.start();f.runner.start();await f.runner.pending;assert.equal(f.calls.filter(x=>x==='remove').length,1);});
for(const failure of ['preflight','latest','backup','download'])test(`${failure} failure preserves old plugin`,async()=>{
  const f=fixture({[failure]:async()=>{throw new UpgradeRefusal('preflight-failed');}});assert.equal((await finish(f)).phase,'failed');assert.deepEqual(f.calls,[]);
});
test('active disk version and actually loaded version must match before update',async()=>{const f=fixture();f.setCurrent({loadedVersion:'0.2.3'});assert.equal((await finish(f)).reason,'current-not-ready');assert.deepEqual(f.calls,[]);});
test('journal failure prevents removal',async()=>{const f=fixture({write:()=>{throw Error('disk full');}});await finish(f);assert.deepEqual(f.calls,[]);assert.equal(f.runner.snapshot().reason,'journal-unavailable');});
test('unknown install result is not automatically replayed or rolled back',async()=>{
  const f=fixture({install:async()=>{throw Error('service lost');}});assert.equal((await finish(f)).phase,'interrupted');assert.deepEqual(f.calls,['remove']);
  f.runner.start();assert.equal(f.runner.pending,null);
});
test('known activation failure restores old version via official remove/install sequence',async()=>{
  const f=fixture();const install=f.io.install;f.io.install=async record=>{const result=await install(record);return record.version==='0.2.5'?{application:'failed'}:result;};
  assert.equal((await finish(f)).phase,'restored');assert.deepEqual(f.calls,['remove','install:0.2.5','remove','install:0.2.4']);
});
test('installed metadata without running target does not report success',async()=>{
  const f=fixture();f.io.verify=async version=>version==='0.2.4';assert.equal((await finish(f)).phase,'interrupted');assert.deepEqual(f.calls,['remove','install:0.2.5']);
});
test('installed files changing after download are checked again before removal',async()=>{
  const f=fixture({assertPrevious:async()=>{throw new UpgradeRefusal('previous-package-changed');}});
  assert.equal((await finish(f)).reason,'previous-package-changed');assert.deepEqual(f.calls,[]);
});
test('a failed activation status read after applied install does not trigger rollback',async()=>{
  const f=fixture({verify:async()=>{throw Error('service switching');}});assert.equal((await finish(f)).phase,'interrupted');assert.deepEqual(f.calls,['remove','install:0.2.5']);
});
test('restart-required is not reported as success or followed by automatic restart',async()=>{
  const f=fixture();f.io.install=async()=>({application:'restart-required'});assert.equal((await finish(f)).phase,'restart-required');assert.deepEqual(f.calls,['remove']);
});
test('manual profile change prevents destructive rollback',async()=>{
  const f=fixture();f.io.install=async()=>{f.setCurrent({version:'0.2.6'});return {application:'failed'};};
  assert.equal((await finish(f)).reason,'profile-changed');assert.deepEqual(f.calls,['remove']);
});
test('startup reconciles unknown operation without replaying it',async()=>{
  const job={phase:'installing',previousVersion:'0.2.4',targetVersion:'0.2.5',previous:{version:'0.2.4'},protected:'unchanged'};
  const f=fixture({read:()=>job});assert.equal((await f.runner.reconcile()).phase,'interrupted');assert.deepEqual(f.calls,[]);
});
test('startup accepts target only when target is actually running',async()=>{
  const f=fixture({read:()=>({phase:'installing',previousVersion:'0.2.4',targetVersion:'0.2.5'})});f.setCurrent({version:'0.2.5',loadedVersion:'0.2.5'});
  assert.equal((await f.runner.reconcile()).phase,'succeeded');assert.deepEqual(f.calls,[]);
});
test('read-only reconciliation recognizes a completed restore instead of checking the rejected new version',async()=>{
  const f=fixture({read:()=>({phase:'interrupted',restoring:true,reason:'outcome-unknown',needsRecovery:true,previousVersion:'0.2.4',targetVersion:'0.2.5'})});
  assert.equal((await f.runner.reconcile()).phase,'restored');assert.deepEqual(f.calls,[]);
});
test('recovery refuses installed files changed after the original backup',async()=>{
  const f=fixture({read:()=>({phase:'interrupted',needsRecovery:true,previousVersion:'0.2.4',targetVersion:'0.2.5',previous:{version:'0.2.4'},protected:'unchanged'}),assertPrevious:async()=>{throw new UpgradeRefusal('previous-package-changed');}});
  f.runner.recover();await f.runner.pending;assert.equal(f.runner.snapshot().reason,'previous-package-changed');assert.deepEqual(f.calls,[]);
});
test('startup late read does not overwrite an explicit recovery',async()=>{
  let resolve;const f=fixture({read:()=>({phase:'installing',previousVersion:'0.2.4',targetVersion:'0.2.5',previous:{version:'0.2.4'},protected:'unchanged'})});
  f.io.verify=()=>new Promise(r=>{resolve=r;});const scan=f.runner.reconcile();
  f.runner.job={...f.runner.job,phase:'failed',reason:'newer-result'};resolve(true);
  await scan;assert.equal(f.runner.snapshot().reason,'newer-result');
});
test('explicit recovery reinstalls recorded previous version once',async()=>{
  const f=fixture({read:()=>({phase:'interrupted',needsRecovery:true,previousVersion:'0.2.4',targetVersion:'0.2.5',previous:{version:'0.2.4'},protected:'unchanged'})});
  f.runner.recover();f.runner.recover();await f.runner.pending;assert.equal(f.runner.snapshot().phase,'restored');assert.deepEqual(f.calls,['remove','install:0.2.4']);
});
test('a failed recovery cannot be overwritten by a new update click',async()=>{
  const f=fixture({read:()=>({phase:'failed',needsRecovery:true,previousVersion:'0.2.4',targetVersion:'0.2.5',previous:{version:'0.2.4'},protected:'unchanged'})});
  assert.equal(f.runner.start().canRecover,true);assert.equal(f.runner.pending,null);assert.deepEqual(f.calls,[]);
});
test('failure to acquire lock does not overwrite another process journal',async()=>{
  const f=fixture({exclusive:async()=>{throw new UpgradeRefusal('operation-busy');}});
  assert.equal((await finish(f)).reason,'operation-busy');assert.deepEqual(f.saved,[]);assert.deepEqual(f.calls,[]);
});
test('only newer strict stable versions can be selected',()=>{assert(newer('0.2.10','0.2.4'));for(const v of ['0.2.4','0.2.3','0.2.5-beta','0.2.5\n','99.2.4;cmd','01.2.4'])assert.equal(newer(v,'0.2.4'),false);});
const good={name:'@dshos-link/connector',version:'0.2.5',dist:{tarball:'https://registry.npmjs.org/@dshos-link/connector/-/connector-0.2.5.tgz',integrity:`sha512-${Buffer.alloc(64).toString('base64')}`}};
test('registry metadata refuses another package, URL, redirect destination and weak digest',()=>{
  assert.equal(metadata(good).version,'0.2.5');
  for(const bad of [{...good,name:'evil'},{...good,version:'0.2.5\n'},{...good,dist:{...good.dist,tarball:'https://evil.invalid/connector.tgz'}},{...good,dist:{...good.dist,integrity:'sha1-abc'}}])assert.throws(()=>metadata(bad));
});
function archive(manifest) {
  const data=Buffer.from(JSON.stringify(manifest)),h=Buffer.alloc(512);h.write('package/package.json');h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(data.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write('0',156);h.write('ustar\0',257);h.write('00',263);h.write(h.reduce((n,b)=>n+b,0).toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(Buffer.concat([h,data,Buffer.alloc((512-data.length%512)%512),Buffer.alloc(1024)]));
}
const pkg={name:'@dshos-link/connector',version:'0.2.5',dsh:{bundle:{patch:'./cordis.patch.yml'}}};
test('archive identity and lifecycle hooks checked before installation',()=>{
  assert.equal(packageManifest(archive(pkg),'0.2.5').name,pkg.name);assert.throws(()=>packageManifest(archive({...pkg,name:'evil'}),'0.2.5'));
  assert.throws(()=>packageManifest(archive({...pkg,scripts:{postinstall:'evil'}}),'0.2.5'));assert.throws(()=>packageManifest(Buffer.from('bad'),'0.2.5'));
});
test('cached recovery archive cannot escape cache or silently change contents',()=>{
  const root=mkdtempSync(join(tmpdir(),'dshos-updater-')),record=cacheArchive(root,archive(pkg),'0.2.5');validateCached(root,record);
  assert.throws(()=>validateCached(root,{...record,file:'../../evil.tgz'}));writeFileSync(join(root,record.file),'bad');assert.throws(()=>validateCached(root,record));
  assert.deepEqual(cacheArchive(root,archive(pkg),'0.2.5'),record);validateCached(root,record);
});
test('download digest mismatch never becomes an installable record',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dshos-updater-'));await assert.rejects(download(root,metadata(good),async()=>new Response(archive(pkg))),/integrity-failed/);
  const bytes=archive(pkg),verified=metadata({...good,dist:{...good.dist,integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`}});
  const record=await download(root,verified,async()=>new Response(bytes));assert.equal(readFileSync(validateCached(root,record)).length,bytes.length);
});
test('registry-installed old package is backed up only when exact archive matches installed files',async()=>{
  const root=mkdtempSync(join(tmpdir(),'dshos-registry-backup-')),profile=join(root,'profile'),folder=join(profile,'node_modules','@dshos-link','connector');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'package.json'),JSON.stringify(pkg));
  const bytes=archive(pkg),info={...good,dist:{...good.dist,integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`}};
  const seen=[],request=async url=>{seen.push(url);return new Response(url.endsWith('.tgz')?bytes:JSON.stringify(info));};
  const cache=join(root,'cache');await backupPackage(cache,'@dshos-link/connector@^0.2.5','0.2.5',profile,request);
  assert.equal(seen[0],'https://registry.npmjs.org/@dshos-link%2fconnector/0.2.5');
  writeFileSync(join(folder,'package.json'),JSON.stringify({...pkg,description:'locally modified'}));
  await assert.rejects(backupPackage(cache,'@dshos-link/connector@0.2.5','0.2.5',profile,request),/previous-package-changed/);
  await assert.rejects(backupPackage(cache,'git+https://example.invalid/plugin','0.2.5',profile,()=>{throw Error('must not fetch');}),/previous-package-unavailable/);
});
