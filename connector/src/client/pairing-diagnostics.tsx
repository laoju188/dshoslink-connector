import { useEffect, useRef, useState } from 'react'
import type { PairingDiagnosticsSnapshot } from '../pairing-diagnostics.js'

type Result = { readonly ok: true; readonly value: PairingDiagnosticsSnapshot } | { readonly ok: false; readonly error: unknown }
export interface PairingDiagnosticsRemoteClient {
  snapshot(): Promise<Result>
  setEnabled(enabled: boolean): Promise<Result>
}

export function PairingDiagnosticsSetting({ remote }: { readonly remote: PairingDiagnosticsRemoteClient }): JSX.Element {
  const [state, setState] = useState<PairingDiagnosticsSnapshot | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const epoch = useRef(0), pending = useRef(false)
  useEffect(() => {
    const generation = ++epoch.current
    pending.current = false; setState(null); setBusy(false); setMessage('')
    void remote.snapshot().then(result => {
      if (generation !== epoch.current) return
      if (result.ok) setState(result.value)
      else setMessage('暂时无法读取设置，请重试。')
    }).catch(() => { if (generation === epoch.current) setMessage('暂时无法读取设置，请重试。') })
    return () => { ++epoch.current; pending.current = false }
  }, [remote])
  async function change(enabled?: boolean): Promise<void> {
    if (pending.current) return
    pending.current = true; setBusy(true); setMessage('')
    const generation = ++epoch.current
    try {
      const result = enabled === undefined ? await remote.snapshot() : await remote.setEnabled(enabled)
      if (generation !== epoch.current) return
      if (!result.ok) throw Error('unavailable')
      setState(result.value)
      if (enabled !== undefined && !result.value.pendingDisable) setMessage(result.value.enabled
        ? '已开启，从下次开始配对时记录。' : '已关闭，尚未发送的诊断已清除。')
    } catch {
      if (generation !== epoch.current) return
      setState(null)
      setMessage('未能确认设置已保存，请重新读取后再试。')
    } finally {
      if (generation === epoch.current) { pending.current = false; setBusy(false) }
    }
  }
  const disabled = busy || !state || !state.available || state.forcedOff || state.pendingDisable
  const status = state?.pendingDisable
    ? '诊断已暂停，但关闭尚未保存或清理未完成。请重试关闭。' : message
  return <section aria-label="配对诊断设置" style={{ padding: 16, marginTop: 16, marginBottom: 16, borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l3, #cbd5df)', background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, #253344)' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
      <strong>帮助改进配对体验</strong>
      <button type="button" role="switch" aria-label="帮助改进配对体验" aria-checked={state?.enabled ?? false}
        aria-describedby="dshos-pairing-diagnostics-description" disabled={disabled}
        onClick={() => { if (state) void change(!state.enabled) }}
        style={{ minWidth: 60, minHeight: 36, borderRadius: 20, padding: '6px 12px', flexShrink: 0,
          border: '1px solid var(--dsw-alias-border-l3, #94a3b8)',
          background: state?.enabled ? '#2563eb' : 'var(--dsw-alias-bg-layer-1, #eaf0f6)',
          color: state?.enabled ? '#fff' : 'inherit', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.65 : 1 }}>
        {busy ? '保存中' : !state ? '读取中' : state.pendingDisable ? '未保存' : state.enabled ? '开启' : '关闭'}
      </button>
    </div>
    <p id="dshos-pairing-diagnostics-description" style={{ fontSize: 13, lineHeight: 1.6, margin: '8px 0' }}>
      默认开启自动诊断，帮助我们排查配对和连接问题。不含聊天内容或文件；可随时关闭，不影响正常连接。
    </p>
    <details style={{ fontSize: 13, lineHeight: 1.6 }}>
      <summary style={{ cursor: 'pointer' }}>收集哪些信息</summary>
      <p>新版配对流程：手机显示配对码，电脑输入，手机确认。点击上方“发送连接反馈”，会附带本机已记录的准备、提交请求、手机确认、保存配对和连接验证等步骤，帮助我们定位卡点；主动反馈最多保留30天。</p>
      <p>自动诊断包含已记录的配对进度、结果、错误类型、发生时间、耗时、插件版本和随机记录编号；也记录成功访问会话等功能的连接使用标记，用于按账号统计免费与 Pro 的实际使用和留存；局域网连接也包含在内，不记录具体会话或操作次数。已有电脑设备标识可关联已登记账号；尚无可用设备标识时使用本次临时诊断标识。自动诊断最多保留90天，仅用于连接故障排查和功能改进，只有获授权的管理人员可以查看。</p>
      <p>连接诊断还包含电脑收到和回复认证的阶段、通知连接的断开类别及恢复安排；采用有限摘要，不记录每次心跳。点击“检查局域网连接”只在本机读取监听与防火墙状态，不修改设置，也不会自动发送反馈。</p>
      <p>不收集聊天内容或次数、文件内容、电脑目录、配对码、验证码或私钥。尚未发送的自动诊断在本机最多保留24小时；关闭后停止自动上传并清除这部分记录，已发送的信息按隐私政策处理。</p>
      <p>关闭不影响你主动发送连接反馈，也不影响登录、配对登记和订单等必要业务记录。</p>
      <a href="https://agreement-drcn.hispace.dbankcloud.cn/index.html?lang=zh&agreementId=2036788658081690688"
        target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>隐私政策</a>
    </details>
    {state?.forcedOff && <p style={{ fontSize: 13 }}>此电脑已通过启动配置关闭诊断上传。</p>}
    {state && !state.available && <p style={{ fontSize: 13 }}>当前无法保存诊断设置，诊断上传保持关闭。</p>}
    {status && <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{status}</p>}
    {state?.pendingDisable && <button type="button" disabled={busy || !state.available}
      onClick={() => void change(false)}>重试关闭</button>}
    {!state && message && <button type="button" disabled={busy} onClick={() => void change()}>重新读取设置</button>}
  </section>
}
