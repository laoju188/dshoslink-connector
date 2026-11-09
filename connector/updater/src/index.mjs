import { Service } from '@deepseek-ai/cordis';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot';
import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { UpgradeCoordinator, UpgradeRefusal, CONNECTOR, stable } from './core.mjs';
import { atomicJson, fetchBounded, metadata, backupPackage, download, validateCached, verifyInstalledArchive } from './archive.mjs';
import { assertUpgradePreflight } from '../../src/connector-upgrade-preflight.ts';
import { UPGRADE_HELPER_VERSION } from '../../src/connector-upgrade-policy.ts';
import { assertPackageHost } from './compatibility.mjs';
export const inject = ['pluginManager', 'profileContext'];
export const name = 'DSHOS Link plugin updater';
const UPDATER = '@dshos-link/connector-updater';
export function requireOwner(ctx) {
  const principal = ctx.invocation?.peer?.principal;
  if (principal && principal.kind !== 'owner') throw new UpgradeRefusal('owner-required');
}
function readSmall(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new UpgradeRefusal('invalid-state');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function stateAdapter(ctx) {
  const manager = ctx.get('pluginManager'), profile = ctx.get('profileContext');
  const root = join(profile.dir, '.dshos-link', 'plugin-updater-v1'), cache = join(root, 'packages'), journal = join(root, 'operation.json');
  const protectedState = () => {
    const manifest = readSmall(join(profile.dir, 'package.json'));
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).filter(([key]) => ![CONNECTOR, UPDATER].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
    const bundles=(manifest.dsh?.profile?.bundles??[]).filter(name=>![CONNECTOR,UPDATER].includes(name));
    const providers={};
    for(const name of ['@deepseek-ai/dsh-llm-deepseek','@deepseek-ai/dsh-llm-deepseek-api-key']) {
      if(dependencies[name]) providers[name]=createHash('sha256').update(readFileSync(join(profile.dir,'node_modules',name,'package.json'))).digest('hex');
    }
    return JSON.stringify({dependencies,bundles,providers});
  };
  const current = async () => {
    const bundle = (await manager.listBundles()).find(b => b.name === CONNECTOR);
    const rows = (await manager.listPlugins()).filter(p => p.moduleName === CONNECTOR);
    const loaded = ctx.get('dshosUpdate');
    let loadedVersion = '';
    try { loadedVersion = loaded ? (await loaded.snapshot()).currentVersion : ''; } catch { /* not an active healthy connector */ }
    return { exists: Boolean(bundle), version: bundle?.version ?? '', source: bundle?.source ?? '',
      active: bundle?.enabled === true && !bundle.error && rows.length > 0 && rows.every(p => p.fiberPhase === 'active'),
      loadedVersion, protected: protectedState() };
  };
  return {
    read() {
      try {
        const job = readSmall(journal);
        if (!job || Array.isArray(job) || !['preparing','removing','installing','verifying','restoring','succeeded','restored','failed','interrupted','restart-required'].includes(job.phase)
          || ['previousVersion','targetVersion'].some(key=>job[key]!==undefined&&job[key]!==''&&!stable(job[key]))
          || (job.reason!==undefined&&typeof job.reason!=='string')
          || (job.restoring!==undefined&&typeof job.restoring!=='boolean')) throw new UpgradeRefusal('invalid-state');
        return job;
      } catch(error) {
        if(error.code==='ENOENT')return null;
        // Keep the original bytes/link in place. A bad record must not unload the UI,
        // authorize another install, or be silently discarded as an empty history.
        return {phase:'recovery-unavailable',reason:'journal-unavailable',needsRecovery:true};
      }
    },
    write: job => atomicJson(journal, job),
    exclusive: work => { mkdirSync(root, { recursive: true }); return withFileLock(journal, work, { waitMs: 0 }); },
    current,
    preflight: recovery => assertUpgradePreflight(ctx,getDshRuntimeVersion(),recovery),
    async latest() { return metadata(JSON.parse((await fetchBounded('https://registry.npmjs.org/@dshos-link%2fconnector/latest', 65536, fetch, 10000)).toString('utf8'))); },
    backup: state => backupPackage(cache, state.source, state.version, profile.dir),
    download: info => download(cache, info),
    validateCached: record => validateCached(cache, record),
    assertCompatible: (record, purpose) => assertPackageHost(readFileSync(validateCached(cache, record)), record.version, getDshRuntimeVersion(), purpose),
    assertPrevious: record => verifyInstalledArchive(cache, record, profile.dir),
    assertProtected: async expected => { if (typeof expected !== 'string' || protectedState() !== expected) throw new UpgradeRefusal('profile-changed'); },
    remove: () => manager.removeBundle(CONNECTOR),
    install: record => manager.installBundle(`file:${validateCached(cache, record)}`, { enabled: true, saveExact: true, requestId: `dshos-upgrade-${randomUUID()}`, registry: 'https://registry.npmjs.org/' }),
    async verify(version) {
      for (let i = 0; i < 6; i++) {
        const state = await current();
        if (state.version === version && state.active && state.loadedVersion === version) return true;
        await delay(500);
      }
      return false;
    },
  };
}
export class UpgradeRemote extends Service {
  constructor(ctx, coordinator) {
    super(ctx, 'dshosUpgrade'); this.coordinator = coordinator; this.helperVersion = UPGRADE_HELPER_VERSION;
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'dshosUpgrade', namespace: 'dshosUpgrade' });
  }
  async snapshot() { requireOwner(this.ctx); await this.coordinator.reconcile(); return this.coordinator.snapshot(); }
  start() { requireOwner(this.ctx); return this.coordinator.start(); }
  recover() { requireOwner(this.ctx); return this.coordinator.recover(); }
}
export function apply(ctx) {
  const io = stateAdapter(ctx), coordinator = new UpgradeCoordinator(io);
  new UpgradeRemote(ctx, coordinator);
  // Reconciliation only reads current version and updates our own journal. It never repeats an install.
  void coordinator.reconcile().catch(() => {});
}
