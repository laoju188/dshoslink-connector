// This coordinator is a separate DSH bundle: replacing connector cannot unload it.
export const CONNECTOR = '@dshos-link/connector';
export const BUSY = new Set(['preparing', 'removing', 'installing', 'verifying', 'restoring']);
const versionPattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
export const stable = value => typeof value === 'string' && versionPattern.test(value);
export function newer(a, b) {
  if (!stable(a) || !stable(b)) return false;
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}
export class UpgradeRefusal extends Error { constructor(code) { super(code); this.code = code; } }
export const snapshotOf = job => ({
  phase: job?.phase ?? 'idle', currentVersion: job?.previousVersion ?? '', targetVersion: job?.targetVersion ?? '',
  reason: job?.reason ?? '', canRecover: Boolean(job?.previous && job.needsRecovery && ['interrupted', 'failed'].includes(job.phase)),
});
export class UpgradeCoordinator {
  constructor(io) { this.io = io; this.pending = null; this.job = io.read(); }
  snapshot() { return snapshotOf(this.job); }
  async reconcile() {
    if (this.pending || !this.job || ![...BUSY, 'restart-required', 'interrupted'].includes(this.job.phase)) return this.snapshot();
    const ownedJob = this.job;
    // A completed install response is not retained by PluginManager. Never replay an unknown write on startup.
    await this.io.exclusive(async()=>{
      if(this.pending||this.job!==ownedJob||JSON.stringify(this.io.read())!==JSON.stringify(ownedJob))return;
      const restoring=ownedJob.restoring===true||ownedJob.phase==='restoring'||ownedJob.reason==='restored-restart-required';
      const ready = await this.io.verify(restoring?ownedJob.previousVersion:ownedJob.targetVersion);
      if (this.pending || this.job !== ownedJob) return;
      if (ready) this.set(restoring?'restored':'succeeded',restoring?'upgrade-failed-restored':'');
      else await this.markUnconfirmedActivation(restoring?ownedJob.previousVersion:ownedJob.targetVersion,restoring,ownedJob.reason==='restored-restart-required'?'restored-restart-required':ownedJob.reason==='activation-pending'?'activation-pending':'outcome-unknown');
    });
    return this.snapshot();
  }
  async markUnconfirmedActivation(version, restoring=false, reason='activation-pending') {
    const ownedJob=this.job;
    let state;
    try { state=await this.io.current(); }
    catch { if(this.job===ownedJob)this.set('interrupted','outcome-unknown'); return; }
    if(this.job!==ownedJob)return;
    // rc.3 can report applied while reusing an old imported namespace. Do not
    // promise hot activation or repeat installation when disk and runtime differ.
    if(state.active&&state.version===version&&stable(state.loadedVersion)&&state.loadedVersion!==version)
      this.set(restoring?'interrupted':'restart-required',restoring?'restored-restart-required':'');
    else this.set('interrupted',reason);
  }
  set(phase, reason = '') {
    const next = { ...this.job, phase, reason,
      restoring:phase==='restoring'||this.job?.restoring===true,
      needsRecovery: phase==='removing'?true:['succeeded','restored'].includes(phase)?false:Boolean(this.job?.needsRecovery) };
    this.io.write(next); this.job = next;
  }
  start() { return this.launch(false); }
  recover() { return this.launch(true); }
  launch(recovery) {
    if (this.pending) return this.snapshot();
    if (this.job?.phase==='recovery-unavailable') return this.snapshot();
    if (!recovery && this.job && ([...BUSY,'restart-required'].includes(this.job.phase)||this.snapshot().canRecover)) return this.snapshot();
    if (recovery && !this.snapshot().canRecover) return this.snapshot();
    const oldJob = this.job;
    if (!recovery) this.job = { phase: 'preparing', previousVersion: '', targetVersion: '', reason: '', needsRecovery:false };
    else this.job = { ...oldJob, phase: 'restoring', reason: '', restoring:true };
    // Set pending before any asynchronous operation: two windows share this service.
    this.pending = Promise.resolve().then(() => this.io.exclusive(async () => {
      try {
      const saved=this.io.read();
      if(saved?.phase==='recovery-unavailable'){this.job=saved;return;}
      if(!recovery&&saved?.needsRecovery&&[...BUSY,'interrupted','failed','restart-required'].includes(saved.phase)){
        this.job={...saved,phase:'interrupted',reason:'outcome-unknown'};return;
      }
      if(recovery&&JSON.stringify(saved)!==JSON.stringify(oldJob))throw new UpgradeRefusal('profile-changed');
      if (recovery) {
        await this.io.preflight(true);
        this.io.write(this.job);
        await this.restore(); return;
      }
      let mutated = false, settled = true;
      try {
        const hostVersion = await this.io.preflight(false);
        const before = await this.io.current();
        if (!before.active || before.version !== before.loadedVersion || !stable(before.version)) throw new UpgradeRefusal('current-not-ready');
        const target = await this.io.latest();
        if (!newer(target.version, before.version)) throw new UpgradeRefusal('no-new-version');
        // Both exact archives are verified and durably cached before removing anything.
        const previous = await this.io.backup(before);
        const next = await this.io.download(target);
        await this.io.assertCompatible(next, 'target');
        await this.io.assertCompatible(previous, 'previous');
        this.job = { phase: 'preparing', previousVersion: before.version, targetVersion: target.version, previous, next, hostVersion, protected: before.protected, reason: '', needsRecovery:false };
        this.io.write(this.job);
        if (await this.io.preflight(false) !== hostVersion) throw new UpgradeRefusal('host-changed');
        const current = await this.io.current();
        if (current.version !== before.version || current.source !== before.source || !current.active || current.loadedVersion !== before.version) throw new UpgradeRefusal('profile-changed');
        await this.io.assertProtected(this.job.protected);
        await this.io.assertPrevious(previous);
        if (await this.io.preflight(false) !== hostVersion) throw new UpgradeRefusal('host-changed');
        this.set('removing'); mutated = true; settled = false;
        const removed = await this.io.remove();
        settled = true;
        if (removed.application !== 'applied') throw new UpgradeRefusal('remove-failed');
        this.set('installing');
        settled = false;
        const result = await this.io.install(next);
        settled = true;
        await this.io.assertProtected(this.job.protected);
        if (result.application === 'restart-required') { this.set('restart-required'); return; }
        if (result.application !== 'applied') throw new UpgradeRefusal('install-failed');
        this.set('verifying');
        let ready;
        try { ready=await this.io.verify(target.version); }
        catch { this.set('interrupted','outcome-unknown'); return; }
        if (!ready) { await this.markUnconfirmedActivation(target.version); return; }
        this.set('succeeded');
      } catch (error) {
        if (mutated && !settled) this.set('interrupted', 'outcome-unknown');
        else if (mutated && this.job.previous) {
          this.set('restoring', error.code ?? 'upgrade-failed');
          await this.restore();
        } else this.set('failed', error.code ?? 'preparation-failed');
      }
      }catch(error){this.set('failed',error.code??'recovery-required');}
    })).catch(error => {
      // No journal writes outside the lock: another host may own the operation.
      this.job = { ...this.job, phase: 'failed', reason:error.code??'journal-unavailable' };
    }).finally(() => { this.pending = null; });
    return this.snapshot();
  }
  async restore() {
    const hostVersion = await this.io.preflight(true);
    await this.io.validateCached(this.job.previous);
    await this.io.assertCompatible(this.job.previous, 'previous');
    const current = await this.io.current();
    if (current.version && ![this.job.previousVersion, this.job.targetVersion].includes(current.version)) throw new UpgradeRefusal('profile-changed');
    await this.io.assertProtected(this.job.protected);
    // Removing first is required by rc.3 even for reinstalling the same old file spec.
    if (current.exists) {
      await this.io.assertPrevious(current.version===this.job.previousVersion?this.job.previous:this.job.next);
      if (await this.io.preflight(true) !== hostVersion) throw new UpgradeRefusal('host-changed');
      let removed;
      try { removed = await this.io.remove(); } catch { this.set('interrupted','outcome-unknown'); return; }
      if (removed.application !== 'applied') throw new UpgradeRefusal('restore-remove-failed');
    }
    if (await this.io.preflight(true) !== hostVersion) throw new UpgradeRefusal('host-changed');
    let result;
    try { result = await this.io.install(this.job.previous); } catch { this.set('interrupted','outcome-unknown'); return; }
    await this.io.assertProtected(this.job.protected);
    if (result.application === 'restart-required') {
      this.set('interrupted', 'restored-restart-required'); return;
    }
    if (result.application !== 'applied') throw new UpgradeRefusal('restore-failed');
    let ready;
    try { ready=await this.io.verify(this.job.previousVersion); }
    catch { this.set('interrupted','outcome-unknown'); return; }
    if(!ready){await this.markUnconfirmedActivation(this.job.previousVersion,true);return;}
    this.set('restored', 'upgrade-failed-restored');
  }
}
