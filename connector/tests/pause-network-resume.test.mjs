import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use this checkout's build with a synthetic profile and network.
const load = name => import(new URL(`../dist/${name}.js`, import.meta.url));
const { WindowsPairingPortController: Controller } = await load('pairing-port-control');
const { WindowsPairingListenerStartError } = await load('pairing-windows-https');
const { loadOrCreateWindowsPairingIdentity, PAIRING_IDENTITY_FILE_NAME } = await load('pairing-identity-store');
const { IdentityBoundFilePairingTrustStore } = await load('pairing-trust-store');
const { RemoteAccessSwitch } = await load('remote-access-switch');

const a = '192.168.50.8', b = '10.20.0.8';
const ports = { port: 24710, bootstrapPort: 24711 };
const protector = {
  async protect(value) { return Buffer.from(value); },
  async unprotect(value) { return Buffer.from(value); },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dshos-pause-network-'));
  const identity = await loadOrCreateWindowsPairingIdentity({ rootDirectory: root, host: a, allowCreate: true, protector });
  const binding = { pairingId: Buffer.alloc(16, 11).toString('base64url'), mobilePublicKeyRaw: Buffer.alloc(32, 12).toString('base64url') };
  const trust = new IdentityBoundFilePairingTrustStore(join(root, 'pairing-trust-v1.json'), identity.identityId);
  trust.replace({ pairingVersion: 1, pairingId: binding.pairingId, mobilePublicKeyRaw: binding.mobilePublicKeyRaw, createdAt: 1000, updatedAt: 1000, status: 'active' });
  const frozenIdentity = await readFile(join(root, PAIRING_IDENTITY_FILE_NAME));
  const frozenTrust = await readFile(join(root, 'pairing-trust-v1.json'));
  const f = { root, live: a, discoveries: 0, starts: [], controllers: [] };
  f.make = (host, automaticHosts = true) => {
    const c = new Controller({ rootDirectory: root, host, hosts: host ? [host] : [], automaticHosts, initialPair: ports, allowCreate: true }, {
      portStore: { async recoverPending() {}, async read() { return ports; } },
      runtimeDependencies: { protector },
      discoverHosts: () => f.discover(),
      startRuntime: async options => {
        const hosts = [...(options.hosts ?? [options.host])];
        f.starts.push(hosts);
        // This is the real OS outcome when the old DHCP address no longer belongs to a NIC.
        if (!hosts.includes(f.live)) throw new WindowsPairingListenerStartError('pairing_https', 'address_unavailable', true);
        const currentIdentity = await loadOrCreateWindowsPairingIdentity({ ...options, allowCreate: false, protector });
        let disposed = false;
        const runtime = {
          identity: currentIdentity,
          currentBinding() { return disposed ? undefined : binding; },
          backend: { snapshot() { return { status: 'PAIRED' }; } },
          dispose() { disposed = true; },
        };
        return { host: f.live, hosts: [f.live], ...ports, runtime, async stop() { runtime.dispose(); } };
      },
      startMdnsAdvertisement: async () => ({ async stop() {} }),
    });
    f.controllers.push(c);
    return c;
  };
  f.discover = async () => { f.discoveries++; return [f.live]; };
  f.preserved = async () => {
    assert.deepEqual(await readFile(join(root, PAIRING_IDENTITY_FILE_NAME)), frozenIdentity);
    assert.deepEqual(await readFile(join(root, 'pairing-trust-v1.json')), frozenTrust);
  };
  f.close = async () => {
    for (const c of f.controllers) await c.stop();
    await rm(root, { recursive: true, force: true });
  };
  return f;
}

test('control: explicit resume succeeds when the paused address is still present', async () => {
  const f = await fixture();
  try {
    const c = f.make(a);
    assert.equal((await c.initialize()).state, 'READY');
    assert.equal((await c.setRemoteAccess(false)).state, 'PAUSED');
    assert.equal((await c.setRemoteAccess(true)).state, 'READY');
    await f.preserved();
    console.log('PLUGIN_PAUSE_CONTROL ' + JSON.stringify({ result: 'READY', identityAndTrustPreserved: true }));
  } finally { await f.close(); }
});

test('normative: explicit resume must recover on the new LAN while preserving the original identity', async () => {
  const f = await fixture();
  try {
    const c = f.make(a);
    assert.equal((await c.initialize()).state, 'READY');
    assert.equal((await c.setRemoteAccess(false)).state, 'PAUSED');
    f.live = b;
    await c.refreshLanAddresses(f.discover, () => 'new-network');
    assert.equal(f.discoveries, 0, 'paused background discovery remains disabled');
    assert.equal((await c.setRemoteAccess(true)).state, 'READY');
    assert.equal(f.discoveries, 1);
    assert.deepEqual(f.starts, [[a], [b]]);
    assert.equal(new RemoteAccessSwitch(f.root).read(), null);
    await f.preserved();
  } finally { await f.close(); }
});

test('no address or discovery failure keeps durable pause and original identity', async()=>{
 const f=await fixture();try{
  const c=f.make(a);await c.initialize();await c.setRemoteAccess(false);
  f.discover=async()=>[];await assert.rejects(c.setRemoteAccess(true),/network_unavailable/);
  assert.equal(c.connectorStatus().state,'PAUSED');assert.ok(new RemoteAccessSwitch(f.root).read());
  f.discover=async()=>{throw Error('discovery unavailable')};await assert.rejects(c.setRemoteAccess(true));
  assert.equal(c.connectorStatus().state,'PAUSED');await f.preserved();
  f.discover=async()=>[b];f.live=b;assert.equal((await c.setRemoteAccess(true)).state,'READY');await f.preserved();
 }finally{await f.close()}
});

test('offline restart: durable paused identity exists, LAN returns, resume must discover before requiring a host', async () => {
  const f = await fixture();
  try {
    const first = f.make(a);
    assert.equal((await first.initialize()).state, 'READY');
    assert.equal((await first.setRemoteAccess(false)).state, 'PAUSED');
    await first.stop();
    const restarted = f.make(undefined);
    assert.equal((await restarted.initialize()).state, 'PAUSED');
    f.live = b;
    await restarted.refreshLanAddresses(f.discover, () => 'network-returned');
    assert.equal(f.discoveries, 0);
    let error;
    try { await restarted.setRemoteAccess(true); } catch (e) { error = e; }
    console.log('OFFLINE_RESTART_OBSERVATION ' + JSON.stringify({ error: error?.message, discoveries: f.discoveries, state: restarted.connectorStatus().state, durablePause: Boolean(new RemoteAccessSwitch(f.root).read()) }));
    await f.preserved();
    assert.equal(error, undefined, 'A valid paused identity and newly available LAN must allow explicit resume');
    assert.equal(f.discoveries, 1);
    assert.equal(restarted.connectorStatus().state, 'READY');
  } finally { await f.close(); }
});
test('offline restart without a network keeps pause; a later explicit resume succeeds', async () => {
  const f=await fixture();try {
    const c=f.make(a);await c.initialize();await c.setRemoteAccess(false);await c.stop();
    const restarted=f.make(undefined);await restarted.initialize();
    for(const outcome of [[],undefined,'error']) {
      f.discover=async()=>{if(outcome==='error')throw Error('discovery failed');return outcome;};
      await assert.rejects(restarted.setRemoteAccess(true));
      assert.equal(restarted.connectorStatus().state,'PAUSED');assert(new RemoteAccessSwitch(f.root).read());
      assert.equal(f.starts.length,1);await f.preserved();
    }
    f.discover=async()=>[b];f.live=b;
    assert.equal((await restarted.setRemoteAccess(true)).state,'READY');await f.preserved();
  } finally {await f.close();}
});
test('manual host mode never discovers a replacement address', async () => {
  const f=await fixture();try {
    const c=f.make(a,false);await c.initialize();await c.setRemoteAccess(false);await c.stop();
    const missing=f.make(undefined,false);await missing.initialize();
    await assert.rejects(missing.setRemoteAccess(true),/identity_unavailable/);
    assert.equal(f.discoveries,0);assert(new RemoteAccessSwitch(f.root).read());await missing.stop();
    const restart=f.make(a,false);await restart.initialize();
    assert.equal((await restart.setRemoteAccess(true)).state,'READY');assert.equal(f.discoveries,0);await f.preserved();
  } finally {await f.close();}
});
test('disposal while discovering an offline restart cannot clear pause or start a listener', async () => {
  const f=await fixture();try {
    const c=f.make(a);await c.initialize();await c.setRemoteAccess(false);await c.stop();
    const restart=f.make(undefined);await restart.initialize();
    let resolve, entered;const started=new Promise(r=>entered=r);
    f.discover=()=>{entered();return new Promise(r=>resolve=r);};
    const resume=restart.setRemoteAccess(true);const rejected=assert.rejects(resume,/unavailable/);
    await started;const stopped=restart.stop();resolve([b]);await rejected;await stopped;
    assert.equal(f.starts.length,1);assert(new RemoteAccessSwitch(f.root).read());await f.preserved();
  } finally {await f.close();}
});

test('changed paused identity during discovery cannot authorize an offline restart', async () => {
  const f=await fixture();try {
    const c=f.make(a);await c.initialize();await c.setRemoteAccess(false);await c.stop();
    const restart=f.make(undefined);await restart.initialize();
    const marker=join(f.root,'remote-access-paused-v1/identity.json');
    const original=await readFile(marker);const changed=JSON.parse(original.toString());
    changed.pin=Buffer.alloc(32,90).toString('base64url');
    f.discover=async()=>{await writeFile(marker,JSON.stringify(changed));return [b];};
    await assert.rejects(restart.setRemoteAccess(true),/identity_changed/);
    assert.equal(restart.connectorStatus().state,'PAUSED');assert.equal(f.starts.length,1);
    assert.equal(new RemoteAccessSwitch(f.root).read().pin,changed.pin);await f.preserved();
  } finally {await f.close();}
});

test('listener failure after rediscovery restores durable pause and permits later explicit recovery', async () => {
  const f=await fixture();try {
    const c=f.make(a);await c.initialize();await c.setRemoteAccess(false);await c.stop();
    const restart=f.make(undefined);await restart.initialize();
    f.discover=async()=>[b];
    await assert.rejects(restart.setRemoteAccess(true),/resume_failed/);
    assert.equal(restart.connectorStatus().state,'PAUSED');assert(new RemoteAccessSwitch(f.root).read());await f.preserved();
    f.live=b;assert.equal((await restart.setRemoteAccess(true)).state,'READY');await f.preserved();
  } finally {await f.close();}
});
