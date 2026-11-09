import { useEffect, useState } from 'react';
import { TYPERT_REMOTE } from './remote.mjs';
const BUSY = new Set(['preparing','removing','installing','verifying','restoring']);
const reasons = {
  'tasks-running': '电脑仍有任务运行，请等待任务完成后再更新。',
  'pairing-busy': '正在配对，请完成配对后再更新。',
  'host-not-supported': '此桌面版本暂不支持自动安装，请使用原升级方式。',
  'host-api-unavailable': '当前 DSH 的安装接口不可用，已停止自动更新。请查看插件页面的升级步骤。',
  'host-changed': '更新期间 DSH 环境发生变化，已停止自动处理。请重新打开桌面后核对安装状态。',
  'target-host-incompatible': '新版插件尚不适配当前 DSH，已停止安装。请先核对桌面版本与插件的兼容说明。',
  'previous-host-incompatible': '上一版插件不适配当前 DSH，不能作为回退版本。已停止自动处理，请按升级步骤检查。',
  'package-compatibility-unknown': '暂时无法确认安装包与当前 DSH 是否兼容，已停止自动处理。请查看插件页面的升级步骤。',
  'upgrade-protocol-unsupported': '新版需要更新的安装工具，请按插件页面的升级步骤进行更新。',
  'previous-package-unavailable': '暂时找不到上一版安装包，尚未替换插件，请使用原升级方式。',
  'previous-package-changed': '当前插件文件与安装包不一致。为保护已有文件，已停止自动更新，请使用原升级方式。',
  'profile-changed': '安装环境在更新过程中发生变化，已停止自动处理。请在桌面插件管理中检查。',
  'no-new-version': '目前没有更新的正式版本。',
  'journal-unavailable': '升级记录无法读取，已停止自动安装。原记录已保留，请在 DSH 插件管理中检查安装状态。',
  'activation-pending': '新版已安装，正在核对是否已启用。可以稍后重新核对，不会因此自动装回旧版。',
  'restored-restart-required': '已装回上一版，请正常退出 DSH 后重新打开。',
};
export function UpgradeProgress({ remote }) {
  const [state, setState] = useState(null), [hidden, setHidden] = useState(false), [bridgeLost, setBridgeLost] = useState(false);
  useEffect(() => {
    let disposed = false, timer, running = false, polls = 0;
    const poll = async () => {
      if (running || disposed) return;
      running = true; let again = false;
      try { const result = await remote.snapshot(); if (!disposed) { if (result.ok) { setState(result.value); setBridgeLost(false); again=BUSY.has(result.value.phase); } else {setBridgeLost(true);again=true;} } }
      catch { if (!disposed) {setBridgeLost(true);again=true;} }
      finally { running = false; }
      if (!disposed && again && ++polls < 600) timer = setTimeout(poll, 1500);
      else if (!disposed && again) setBridgeLost(true);
    };
    const wake=()=>{polls=0;clearTimeout(timer);void poll();};
    window.addEventListener('dshos-upgrade-started',wake);
    void poll(); return () => { disposed = true; clearTimeout(timer);window.removeEventListener('dshos-upgrade-started',wake); };
  }, [remote]);
  useEffect(() => { if (state && BUSY.has(state.phase)) setHidden(false); }, [state?.phase]);
  if ((!state && !bridgeLost) || state?.phase === 'idle' || hidden) return null;
  const busy = BUSY.has(state?.phase);
  const text = !state ? '暂时无法读取更新进度，请重新核对。'
    : state.phase === 'succeeded' ? `DSHOS Link 已更新到 ${state.targetVersion}`
    : state.phase === 'restored' ? '这次更新未完成，已恢复上一版插件。'
    : state.phase === 'restart-required' ? '新版已安装，请正常退出 DSH 后重新打开以生效。'
    : busy ? state.phase === 'restoring' ? '正在恢复上一版插件…' : '正在更新 DSHOS Link，请保持桌面开启…'
    : reasons[state.reason] ?? '更新尚未完成，请检查网络或使用插件原升级方式。';
  return <aside role="status" aria-live="polite" style={{ position:'absolute', top:'var(--dsh-frame-overlay-top, 20px)', right:20, zIndex:31, width:760, maxWidth:'calc(100% - 40px)', boxSizing:'border-box', padding:16, borderRadius:14, border:'1px solid var(--dsw-alias-border-l3, #cbd5df)', background:'var(--dsw-alias-bg-base, #fff)', color:'var(--dsw-alias-label-primary, #253344)' }}>
    <strong>{text}</strong>
    {busy && <p>更新时手机会短暂断开连接，配对资料和电脑会话会保留。</p>}
    {bridgeLost && <p>暂时无法读取更新结果，请勿重复安装。恢复连接后会重新核对。</p>}
    {!busy && state?.canRecover && <button onClick={() => void remote.recover().then(()=>window.dispatchEvent(new Event('dshos-upgrade-started'))).catch(()=>setBridgeLost(true))}>恢复上一版</button>}
    {(bridgeLost||state?.phase==='interrupted')&&<button onClick={()=>window.dispatchEvent(new Event('dshos-upgrade-started'))}>重新核对</button>}
    {!busy && <button onClick={() => setHidden(true)}>关闭</button>}
  </aside>;
}
export async function apply(ctx) {
  const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
  const fiber = ctx.inject(['remote.dshosUpgrade','slots'], injected => {
    const remote = injected.remote.dshosUpgrade;
    injected.slots.inject('shell.overlay', () => injected.slots.register({ name:'shell.overlay', id:'dshos-link-upgrade-progress', order:31, label:'DSHOS Link 更新进度' }, () => <UpgradeProgress remote={remote} />));
  });
  return async () => { await fiber.dispose(); await dispose(); };
}
