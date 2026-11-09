import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { UPGRADE_HELPER_VERSION, UPGRADE_HOST_VERSIONS, UPGRADE_PROTOCOL_VERSION } from '../src/connector-upgrade-policy.ts';
import { SUPPORTED_DSH_VERSIONS } from '../src/connector-metadata.ts';
const connectorManifest=JSON.parse(readFileSync('package.json','utf8'));
if(connectorManifest.dshosUpgrade?.protocol!==UPGRADE_PROTOCOL_VERSION || JSON.stringify(connectorManifest.dshosUpgrade.hosts)!==JSON.stringify(SUPPORTED_DSH_VERSIONS)
  || UPGRADE_HOST_VERSIONS.some(host=>!SUPPORTED_DSH_VERSIONS.includes(host)))throw Error('Upgrade compatibility metadata differs from verified host metadata');
const dir = '.updater-build'; mkdirSync(dir, { recursive: true });
const peer = ['@deepseek-ai/cordis','@deepseek-ai/dsh-atomic-write','@deepseek-ai/dsh-app-boot'];
await build({ entryPoints:['updater/src/index.mjs'], outfile:`${dir}/index.js`, bundle:true, platform:'node', format:'esm', target:'node24', external:peer });
await build({ entryPoints:['updater/src/remote.mjs'], outfile:`${dir}/typert.js`, bundle:true, platform:'node', format:'esm', target:'node24' });
await build({ entryPoints:['updater/src/client.jsx'], outfile:`${dir}/client.js`, bundle:true, platform:'browser', format:'cjs', target:'es2022', jsx:'automatic', external:['react','react/jsx-runtime'],
  banner:{js:'window.__ModuleLoader__.load({id:"@dshos-link/connector-updater",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'} });
const manifest = {name:'@dshos-link/connector-updater',version:UPGRADE_HELPER_VERSION,private:true,type:'module',main:'./index.js',exports:{'.':'./index.js','./client':'./client.js','./typert':'./typert.js','./package.json':'./package.json'},
  description:'Local DSHOS Link upgrade coordinator. Bundled with connector; not a cloud service.',
  dsh:{bundle:{patch:'./cordis.patch.yml'},client:{inject:['@deepseek-ai/dsh-api-gateway','@deepseek-ai/dsh-client-runtime'],platform:'web'}},
  peerDependencies:{'@deepseek-ai/cordis':'~4.0.5 || ~4.1.0','@deepseek-ai/dsh-atomic-write':UPGRADE_HOST_VERSIONS.join(' || '),'@deepseek-ai/dsh-app-boot':UPGRADE_HOST_VERSIONS.join(' || '),react:'^18.2.0'},
  peerDependenciesMeta:Object.fromEntries([...peer,'react'].map(name=>[name,{optional:true}]))};
writeFileSync(`${dir}/package.json`, JSON.stringify(manifest, null, 2));
writeFileSync(`${dir}/cordis.patch.yml`, '- insert:\n    - id: dshos-link-connector-updater\n      name: "@dshos-link/connector-updater"\n');
for(const file of ['LICENSE','THIRD_PARTY_NOTICES.md'])writeFileSync(`${dir}/${file}`,readFileSync(file));
// Deterministic, regular-file-only ustar package. No package-manager scripts or network.
const chunks=[];
for (const name of ['package.json','cordis.patch.yml','index.js','typert.js','client.js','LICENSE','THIRD_PARTY_NOTICES.md']) {
  const data=readFileSync(`${dir}/${name}`), header=Buffer.alloc(512);
  header.write(`package/${name}`,0); header.write('0000644\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
  header.write(data.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136); header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257); header.write('00',263);
  header.write(header.reduce((sum,n)=>sum+n,0).toString(8).padStart(6,'0')+'\0 ',148);
  chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
}
chunks.push(Buffer.alloc(1024)); const tgz=gzipSync(Buffer.concat(chunks));
mkdirSync('dist',{recursive:true}); writeFileSync('dist/updater.tgz',tgz);
const sourceFiles=['scripts/build-updater.mjs','src/connector-upgrade-preflight.ts','src/connector-upgrade-policy.ts','src/connector-metadata.ts','package.json','updater/src/compatibility.mjs','updater/src/core.mjs','updater/src/archive.mjs','updater/src/index.mjs','updater/src/remote.mjs','updater/src/client.jsx','LICENSE','THIRD_PARTY_NOTICES.md'];
const sources=Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('dist/updater-payload.json',JSON.stringify({name:manifest.name,version:manifest.version,sha256:createHash('sha256').update(tgz).digest('hex'),sources}));
console.log(`Bundled updater ${manifest.version}, ${tgz.length} bytes`);
