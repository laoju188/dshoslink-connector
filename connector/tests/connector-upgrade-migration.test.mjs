import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ConnectorUpgrade } from '../dist/connector-upgrade.js';
import { UPGRADE_HELPER_VERSION } from '../dist/connector-upgrade-policy.js';

const fixturePath = process.env.DSHOS_UPGRADE_HELPER_FROM_0214;
assert.ok(fixturePath, 'Set DSHOS_UPGRADE_HELPER_FROM_0214 to dist/updater.tgz from the npm 0.2.14 package');
const fixture = readFileSync(fixturePath);
assert.equal(createHash('sha256').update(fixture).digest('hex'),
  '8d6ff68704e191a968769275bfc1d63a3a7365685cd6a77ca77ff3c5e7b13c19');

function setup(t, active) {
  const profile = mkdtempSync(join(tmpdir(), 'dshos-helper-migration-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const installed = join(profile, 'node_modules/@dshos-link/connector-updater');
  const allowed = new Set(['package.json', 'cordis.patch.yml', 'index.js', 'typert.js',
    'client.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md']);
  const tar = gunzipSync(fixture, { maxOutputLength: 2 * 1024 * 1024 });
  mkdirSync(installed, { recursive: true });
  for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const size = Number.parseInt(header.subarray(124, 136).toString().split('\0')[0], 8);
    assert.equal(header[156], '0'.charCodeAt(0));
    assert.ok(name.startsWith('package/') && allowed.delete(name.slice(8)));
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length);
    writeFileSync(join(installed, name.slice(8)), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(allowed.size, 0);
  const journal = join(profile, '.dshos-link/plugin-updater-v1/operation.json');
  const bundle = { name: '@dshos-link/connector-updater', version: '0.1.3', enabled: true };
  let locked = false;
  let installs = 0;
  let starts = 0;
  const services = {
    hmr: {}, agents: { list: () => [] }, jobs: { list: () => [] },
    dshosCloudPairing: { canUpgrade: () => true }, profileContext: { dir: profile },
    pluginManager: {
      listPlugins: async () => [],
      listBundles: async () => [bundle],
      removeBundle() { assert.fail('Migrating an updater must preserve the connector'); },
      async installBundle() {
        if (active) assert.ok(locked);
        else assert.equal(readFileSync(journal + '.lock', 'utf8'), `${process.pid}\n`);
        installs++;
        bundle.version = UPGRADE_HELPER_VERSION;
        delete bundle.error;
        services.dshosUpgrade = { helperVersion: UPGRADE_HELPER_VERSION, start() { starts++; } };
        return { application: 'applied' };
      },
    },
  };
  if (active) {
    services.dshosUpgrade = {
      helperVersion: '0.1.3',
      coordinator: { pending: null, io: {
        read: () => existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : null,
        async exclusive(work) {
          assert.equal(locked, false);
          locked = true;
          try { return await work(); } finally { locked = false; }
        },
      } },
      start() { assert.fail('The old helper must not run'); },
    };
  } else {
    bundle.error = 'incompatible-version';
  }
  const upgrade = new ConnectorUpgrade({ get: name => services[name] },
    { refresh: async () => {}, snapshot: () => ({ status: 'available' }) }, () => '0.2.2-rc.2');
  function save(value) {
    mkdirSync(dirname(journal), { recursive: true });
    writeFileSync(journal, JSON.stringify(value));
  }
  return { installed, journal, upgrade, save, counts: () => ({ installs, starts }) };
}

for (const active of [false, true]) {
  test(`rc.2 migrates the published 0.1.3 helper with its journal intact (${active ? 'active' : 'inactive'})`, async t => {
    const f = setup(t, active);
    f.save({ phase: 'succeeded', needsRecovery: false, targetVersion: '0.2.14' });
    const before = readFileSync(f.journal);
    assert.equal((await f.upgrade.start()).started, true);
    assert.deepEqual(f.counts(), { installs: 1, starts: 1 });
    assert.deepEqual(readFileSync(f.journal), before);
    assert.equal(existsSync(f.journal + '.lock'), false);
  });
}

for (const condition of ['edited', 'extra', 'pending']) {
  test(`rc.2 preserves the old 0.1.3 helper when it is ${condition}`, async t => {
    const f = setup(t, false);
    if (condition === 'edited') writeFileSync(join(f.installed, 'index.js'), 'local edit');
    if (condition === 'extra') writeFileSync(join(f.installed, 'extra.txt'), 'local file');
    if (condition === 'pending') f.save({ phase: 'interrupted', needsRecovery: true });
    assert.equal((await f.upgrade.start()).started, false);
    assert.deepEqual(f.counts(), { installs: 0, starts: 0 });
    if (condition === 'pending') assert.equal(JSON.parse(readFileSync(f.journal, 'utf8')).needsRecovery, true);
  });
}
