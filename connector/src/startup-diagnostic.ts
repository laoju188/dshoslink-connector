/** Finite pre-pairing evidence. Never accepts paths, messages, keys or account IDs. */
export const STARTUP_STEPS = ['identity', 'trust_store', 'credentials', 'credential_cleanup', 'authentication',
  'cloud_recovery', 'registration', 'enrollment_recovery', 'connection_runtime', 'https_listener', 'bootstrap_listener'] as const
export const STARTUP_REASONS = ['unknown', 'access_denied', 'disk_full', 'io_failed', 'file_busy', 'missing_path',
  'record_invalid', 'unsafe_path', 'protection_failed', 'unavailable', 'timeout', 'cancelled', 'busy', 'lock_lost',
  'identity_mismatch', 'port_conflict', 'address_unavailable'] as const
export type StartupStep = typeof STARTUP_STEPS[number]
export type StartupReason = typeof STARTUP_REASONS[number]
export const STARTUP_STORAGE_RECORDS = ['material','source','intent','pairing_intent','registry','activation','recovery'] as const
export const STARTUP_STORAGE_STEPS = ['path','read','decode','decrypt','validate','encrypt','write'] as const
export interface StartupStorageDetail { record: typeof STARTUP_STORAGE_RECORDS[number]; step: typeof STARTUP_STORAGE_STEPS[number] }
export interface StartupDiagnostic {
  storage?: StartupStorageDetail
  version: 1
  attemptId: string
  startedAtMs: number
  failedAtMs: number
  step: StartupStep
  lastSuccess: StartupStep | 'none'
  reason: StartupReason
}
export function validStartupDiagnostic(value: unknown): value is StartupDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if ('storage' in value) {
    const { storage, ...base } = value as StartupDiagnostic
    return !!storage && Object.keys(storage).sort().join(',') === 'record,step'
      && STARTUP_STORAGE_RECORDS.includes(storage.record) && STARTUP_STORAGE_STEPS.includes(storage.step) && validStartupDiagnostic(base)
  }
  const v = value as StartupDiagnostic
  return Object.keys(v).sort().join(',') === 'attemptId,failedAtMs,lastSuccess,reason,startedAtMs,step,version'
    && v.version === 1 && typeof v.attemptId === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(v.attemptId)
    && Number.isSafeInteger(v.startedAtMs) && v.startedAtMs >= 0
    && Number.isSafeInteger(v.failedAtMs) && v.failedAtMs >= v.startedAtMs
    && STARTUP_STEPS.includes(v.step) && (v.lastSuccess === 'none' || STARTUP_STEPS.includes(v.lastSuccess))
    && STARTUP_REASONS.includes(v.reason)
}
export function copyStartupDiagnostic(value: StartupDiagnostic): StartupDiagnostic {
  return { ...value, ...(value.storage ? { storage: { ...value.storage } } : {}) }
}
export const STARTUP_STORAGE_RECORD_LABELS: Record<StartupStorageDetail['record'],string> = {
  material:'电脑登记资料',source:'登记来源记录',intent:'登记提交记录',pairing_intent:'配对提交记录',
  registry:'本机登记索引',activation:'激活记录',recovery:'恢复记录',
}
export const STARTUP_STORAGE_STEP_LABELS: Record<StartupStorageDetail['step'],string> = {
  path:'检查路径',read:'读取文件',decode:'解析封装',decrypt:'系统解密',validate:'核对内容',encrypt:'系统加密',write:'保存文件',
}
export const STARTUP_STEP_LABELS: Record<StartupStep | 'none', string> = {
  none: '尚未记录成功步骤', identity: '准备电脑安全身份', trust_store: '读取本地配对资料',
  credentials: '准备连接凭据', credential_cleanup: '清理未绑定的连接凭据', authentication: '准备连接认证',
  cloud_recovery: '恢复已确认的云配对解除', registration: '准备本地配对登记',
  enrollment_recovery: '核对并恢复本地配对状态', connection_runtime: '准备电脑连接服务',
  https_listener: '启动安全连接监听', bootstrap_listener: '启动证书引导监听',
}
export const STARTUP_REASON_LABELS: Record<StartupReason, string> = {
  unknown: '具体原因尚未确定', access_denied: '访问权限被拒绝', disk_full: '存储空间不足', io_failed: '本地资料读写失败',
  file_busy: '本地文件被占用', missing_path: '所需路径不存在', record_invalid: '本地资料格式校验未通过',
  unsafe_path: '本地路径安全检查未通过', protection_failed: '系统安全保护操作失败', unavailable: '所需系统能力不可用',
  timeout: '等待本地操作超时', cancelled: '本次启动已中断', busy: '本地配对资料正在被其他操作使用',
  lock_lost: '本地资料锁已失效', identity_mismatch: '电脑身份核对未通过', port_conflict: '连接监听地址已被占用',
  address_unavailable: '电脑网络地址当前不可用',
}
