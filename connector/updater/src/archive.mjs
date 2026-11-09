import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, mkdirSync, writeFileSync, renameSync, lstatSync, openSync, fsyncSync, closeSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { CONNECTOR, stable, UpgradeRefusal } from './core.mjs';
const fail = code => { throw new UpgradeRefusal(code); };
const MAX_TGZ = 32 * 1024 * 1024;
export async function fetchBounded(url, maxBytes, request = fetch, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  let reader;
  try {
    const response = await request(url, { signal: controller.signal, redirect: 'error', credentials: 'omit' });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) { void response.body?.cancel().catch(() => {}); fail('download-failed'); }
    reader = response.body.getReader(); const chunks = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) fail('download-too-large'); chunks.push(part.value); }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
}
export function metadata(value) {
  if (value?.name !== CONNECTOR || !stable(value.version) || value.dist?.tarball !== `https://registry.npmjs.org/@dshos-link/connector/-/connector-${value.version}.tgz`
    || typeof value.dist?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.dist.integrity)) fail('invalid-metadata');
  return { version: value.version, url: value.dist.tarball, integrity: value.dist.integrity };
}
export function packageManifest(tgz, expectedVersion, hashes) {
  if (tgz.length > MAX_TGZ) fail('download-too-large');
  const tar = gunzipSync(tgz, { maxOutputLength: 256 * 1024 * 1024 });
  let found;
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every(n => n === 0)) break;
    const str = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const sum = parseInt(str(148, 8).trim(), 8);
    const actual = header.reduce((n, v, i) => n + (i >= 148 && i < 156 ? 32 : v), 0);
    if (sum !== actual || !/^[0-7]+$/.test(str(124, 12).trim())) fail('invalid-archive');
    const size = parseInt(str(124, 12).trim(), 8), type = str(156, 1), prefix = str(345, 155), name = (prefix ? prefix + '/' : '') + str(0, 100);
    if (!Number.isSafeInteger(size) || off + 512 + size > tar.length || !name.startsWith('package/') || name.includes('\\') || name.split('/').some(x => x === '..') || !['', '0', '5'].includes(type)) fail('invalid-archive');
    if (name === 'package/package.json') {
      if (found || size > 65536) fail('invalid-archive');
      found = JSON.parse(tar.subarray(off + 512, off + 512 + size).toString('utf8'));
    }
    if(hashes&&['','0'].includes(type))hashes.set(name.slice('package/'.length),createHash('sha256').update(tar.subarray(off+512,off+512+size)).digest('hex'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  if (found?.name !== CONNECTOR || found.version !== expectedVersion || !found.dsh?.bundle) fail('wrong-package');
  // Installation must not introduce executable lifecycle hooks.
  if (['preinstall', 'install', 'postinstall'].some(key => found.scripts?.[key])) fail('install-script-refused');
  return found;
}
export function atomicJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd=openSync(tmp,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(data));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp, path);
}
export function cacheArchive(root, tgz, version) {
  packageManifest(tgz, version);
  const hash = createHash('sha512').update(tgz).digest('hex');
  const file = `${version}-${hash}.tgz`; mkdirSync(root, { recursive: true });
  const path = join(root, file);
  const record = { file, version, hash };
  if(existsSync(path)){
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())fail('invalid-recovery');
    try{validateCached(root,record);return record;}catch{/* Repair only our exact content-addressed cache file. */}
  }
  const tmp=`${path}.${randomUUID()}.tmp`,fd=openSync(tmp,'wx',0o600);
  try{writeFileSync(fd,tgz);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,path);validateCached(root, record); return record;
}
export function validateCached(root, record) {
  if (!record || !stable(record.version) || !/^[a-f0-9]{128}$/.test(record.hash) || record.file !== `${record.version}-${record.hash}.tgz`) fail('invalid-recovery');
  const path = join(root, record.file), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TGZ) fail('invalid-recovery');
  const buffer = readFileSync(path);
  if (createHash('sha512').update(buffer).digest('hex') !== record.hash) fail('invalid-recovery');
  packageManifest(buffer, record.version); return path;
}
export async function download(root, info, request = fetch) {
  const bytes = await fetchBounded(info.url, MAX_TGZ, request);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== info.integrity) fail('integrity-failed');
  return cacheArchive(root, bytes, info.version);
}
export function backup(root, source, version, profileDir) {
  // Only the already installed local archive can preserve local modifications exactly.
  if (typeof source !== 'string' || !source.startsWith('file:')) fail('previous-package-unavailable');
  const raw = source.slice(5), path = isAbsolute(raw) ? raw : resolve(profileDir, raw);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TGZ) fail('previous-package-unavailable');
  return cacheArchive(root, readFileSync(path), version);
}
export function verifyInstalledArchive(root, record, profileDir) {
  const hashes=new Map();packageManifest(readFileSync(validateCached(root,record)),record.version,hashes);
  // pnpm may link the package root; links inside the installed package are not backups.
  const installed=realpathSync(join(profileDir,'node_modules',CONNECTOR)),seen=new Set();
  function walk(dir,prefix='') {
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      const file=join(dir,entry.name),name=prefix+entry.name,stat=lstatSync(file);
      if(stat.isSymbolicLink())fail('previous-package-changed');
      if(stat.isDirectory()){walk(file,name+'/');continue;}
      if(!stat.isFile()||!hashes.has(name)||stat.size>256*1024*1024||createHash('sha256').update(readFileSync(file)).digest('hex')!==hashes.get(name))fail('previous-package-changed');
      seen.add(name);
    }
  }
  walk(installed);
  if(seen.size!==hashes.size)fail('previous-package-changed');
}
export async function backupPackage(root, source, version, profileDir, request=fetch) {
  if(!stable(version))fail('previous-package-unavailable');
  let record;
  if(typeof source==='string'&&source.startsWith('file:'))record=backup(root,source,version,profileDir);
  else{
    // Public registry installs can recover their exact immutable version; never substitute a git/private/local build.
    if(typeof source!=='string'||!/^@dshos-link\/connector@(?:[~^]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)|latest)$/.test(source))fail('previous-package-unavailable');
    const info=metadata(JSON.parse((await fetchBounded(`https://registry.npmjs.org/@dshos-link%2fconnector/${version}`,65536,request,10000)).toString('utf8')));
    if(info.version!==version)fail('wrong-package');record=await download(root,info,request);
  }
  verifyInstalledArchive(root,record,profileDir);return record;
}
