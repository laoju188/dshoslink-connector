import { connectorUpdateState } from './connector-update-state.js'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CloudPairingPanel,type CloudPairingRemoteClient } from './cloud-pairing.js'
import { ServiceAccessPanel, type ServiceAccessRemoteClient } from './service-access.js'
import { cloudPairingClient,type CloudPairingGatewayClient } from './cloud-pairing-bridge.js'
import { usePairingFlow, type EnrollmentRemote, type PairingFlowStatus } from './pairing-flow.js'
import { ConnectorUpdateNotice, type ConnectorUpdateRemoteClient } from './connector-update.js'
import { PairingDiagnosticsSetting, type PairingDiagnosticsRemoteClient } from './pairing-diagnostics.js'
import { PairingSupportPanel, type PairingSupportRemoteClient } from './pairing-support.js'
import TYPERT_REMOTE from '../remote.js'
import { CONNECTOR_VERSION, LATEST_SUPPORTED_DSH_VERSION } from '../connector-metadata.js'
import {
  formatDiagnosticSummary,
  serializeDiagnosticReport,
  validateDiagnosticReport,
  type DiagnosticReportV1,
} from '../diagnostic-contract.js'

const VERSION_DESCRIPTION = `连接器版本：${CONNECTOR_VERSION}；最新已验证的 DSH 版本：${LATEST_SUPPORTED_DSH_VERSION}`

interface InvitationSnapshot {
  readonly payload: string
  readonly expiresAt: number
  readonly sessionId: string | null
  readonly status:
    | 'INVITATION_ACTIVE'
    | 'WAITING_CONFIRMATION'
    | 'READY_TO_FINALIZE'
    | 'PENDING_COMMIT'
}

type PairingOverlaySnapshot =
  | InvitationSnapshot
  | { readonly status: 'PAIRED'; readonly addressPayload?: string }
  | { readonly status: 'REVOKED' }

type PairingConnectorState =
  | 'PAUSED' | 'READY'
  | 'PORT_CONFLICT'
  | 'NO_PRIVATE_ADDRESS'
  | 'DSH_UNAVAILABLE'
  | 'REPAIRING'
  | 'RESTART_REQUIRED'
  | 'FAILED'

interface PairingConnectorStatusSnapshot {
  readonly state: PairingConnectorState
  readonly port: number
  readonly bootstrapPort: number
  readonly failureStage:
    | 'ACCESS_CONTROL'
    | 'NONE'
    | 'PAIRING_HTTPS'
    | 'BOOTSTRAP_HTTP'
    | 'CONFIGURATION'
    | 'NO_AVAILABLE_PAIR'
    | 'SECURE_STORAGE_TIMEOUT'
    | 'SECURE_STORAGE'
    | 'IDENTITY'
    | 'STORAGE'
    | 'REGISTRATION'
    | 'UNKNOWN'
  readonly repairAvailable: boolean
}

type ComputerConfirmationResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly attemptsRemaining: 0 | 1 | 2 }

type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown }

interface PairingRemoteNamespace {
  snapshot(): Promise<RemoteResult<PairingOverlaySnapshot | null>>
  connectorStatus(): Promise<RemoteResult<PairingConnectorStatusSnapshot | null>>
  repairPorts(): Promise<RemoteResult<PairingConnectorStatusSnapshot>>
  setRemoteAccess?(enabled: boolean): Promise<RemoteResult<PairingConnectorStatusSnapshot>>
  regenerate(): Promise<RemoteResult<InvitationSnapshot>>
  close(): Promise<RemoteResult<void>>
  confirmComputer(
    sessionId: string,
    verificationCode: string,
  ): Promise<RemoteResult<ComputerConfirmationResult>>
  rejectAndRegenerate(): Promise<RemoteResult<InvitationSnapshot>>
  revokePairedDevice(): Promise<RemoteResult<{ readonly status: 'REVOKED' }>>
}

export type DefaultWorkspaceSnapshot =
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly title: string }

export interface DefaultWorkspaceRemoteNamespace {
  snapshot(): Promise<RemoteResult<DefaultWorkspaceSnapshot>>
  select(workspaceId: string): Promise<RemoteResult<DefaultWorkspaceSnapshot>>
}

export interface DiagnosticRemoteNamespace {
  generate(): Promise<RemoteResult<DiagnosticReportV1>>
}

export interface WorkspacesClient {
  pickDirectory(): Promise<string | null>
  create(input: { readonly path: string }): Promise<{ readonly workspaceId: string }>
}

interface ClientContext {
  inject(
    names: readonly string[],
    callback: (ctx: ClientContext) => void | (() => Promise<void>),
  ): PromiseLike<unknown> & { dispose(): Promise<void> }
  readonly remote: {
    readonly dshosPairing: PairingRemoteNamespace
    readonly dshosEnrollment: EnrollmentRemote
    readonly dshosCloudPairing:CloudPairingGatewayClient
    readonly dshosWorkspace: DefaultWorkspaceRemoteNamespace
    readonly dshosUpdate: ConnectorUpdateRemoteClient
    readonly dshosPairingDiagnostics: PairingDiagnosticsRemoteClient
    readonly dshosSupport: PairingSupportRemoteClient
    readonly dshosServiceAccess: ServiceAccessRemoteClient
    $mount(contribution: typeof TYPERT_REMOTE): Promise<() => Promise<void>>
  }
  readonly workspaces: {
    readonly pickDirectory?: WorkspacesClient['pickDirectory']
    readonly create: WorkspacesClient['create']
  }
  readonly uiWorkspace: Pick<WorkspacesClient, 'pickDirectory'>
  readonly slots: {
    inject(name: string, callback: () => void): void
    register(
      options: { name: string; id: string; order: number; label: string },
      component: () => JSX.Element | null,
    ): void
  }
}

interface PairingOverlayProps {
  readonly cloudRemote?:CloudPairingRemoteClient
  readonly enrollmentRemote?: EnrollmentRemote
  readonly remote: PairingRemoteNamespace
  readonly workspaceRemote?: DefaultWorkspaceRemoteNamespace
  readonly workspaces?: WorkspacesClient
  readonly managementOnly?: boolean
  readonly allowLegacyRevoke?: boolean
  readonly legacyRevokePending?: boolean
  readonly onStatus?: (ready: boolean, paired: boolean) => void
  readonly managed?: { readonly value: PairingFlowStatus | null; readonly error: boolean }
}

export interface DiagnosticClipboardWriter {
  writeText(value: string): Promise<void>
}

interface DiagnosticWritableFile {
  write(value: string): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

interface DiagnosticFileHandle {
  createWritable(): Promise<DiagnosticWritableFile>
}

export type DiagnosticSavePicker = (options: {
  readonly suggestedName: string
  readonly types: readonly [{
    readonly description: string
    readonly accept: { readonly 'application/json': readonly ['.json'] }
  }]
}) => Promise<DiagnosticFileHandle>

const POLL_INTERVAL_MS = 1_000
const ACTION_ERROR = '操作未完成，请重试。'
export async function configureDefaultWorkspace(
  workspaces: WorkspacesClient,
  remote: DefaultWorkspaceRemoteNamespace,
): Promise<RemoteResult<DefaultWorkspaceSnapshot> | null> {
  const path = await workspaces.pickDirectory()
  if (path === null) return null
  const workspace = await workspaces.create({ path })
  return remote.select(workspace.workspaceId)
}

export function diagnosticPreviewText(report: unknown): string {
  return serializeDiagnosticReport(report)
}

export async function copyDiagnosticSummary(
  report: unknown,
  clipboard: DiagnosticClipboardWriter,
): Promise<void> {
  await clipboard.writeText(formatDiagnosticSummary(report))
}

export async function exportDiagnosticReport(
  report: unknown,
  picker: DiagnosticSavePicker,
): Promise<'saved' | 'cancelled'> {
  const validated = validateDiagnosticReport(report)
  let writable: DiagnosticWritableFile | undefined
  try {
    const handle = await picker({
      suggestedName: `dshos-link-diagnostic-${validated.reportId}.json`,
      types: [{
        description: 'DSHOS Link 脱敏诊断报告',
        accept: { 'application/json': ['.json'] },
      }],
    })
    writable = await handle.createWritable()
    await writable.write(serializeDiagnosticReport(validated))
    await writable.close()
    return 'saved'
  } catch (error) {
    await writable?.abort?.().catch(() => undefined)
    if (typeof error === 'object' && error !== null
      && 'name' in error && error.name === 'AbortError') return 'cancelled'
    throw new Error('Diagnostic export failed')
  }
}


function isInvitationSnapshot(value: PairingOverlaySnapshot | null): value is InvitationSnapshot {
  return value !== null && value.status !== 'PAIRED' && value.status !== 'REVOKED'
}

function connectorStatusCopy(value: PairingConnectorStatusSnapshot): {
  readonly title: string
  readonly detail: string
} {
  if (value.state === 'PAUSED') return { title: '已暂停手机访问', detail: '这台电脑暂不接受手机连接，重启 DSH 后仍保持暂停。配对和会话资料已保留。' }
  if (value.failureStage === 'ACCESS_CONTROL') return { title: '暂停设置需要检查', detail: '为安全起见，本次不再开启手机连接。请发送反馈，帮助我们检查暂停设置。' }
  if (value.failureStage === 'SECURE_STORAGE_TIMEOUT') return value.state === 'REPAIRING'
    ? { title: '正在重试连接', detail: '正在重新读取原有配对资料，请稍候。' }
    : { title: '暂时无法读取配对资料', detail: '原配对资料已保留。可点击“重试连接”；仍有问题时发送反馈即可。' }
  if (value.failureStage === 'SECURE_STORAGE') return { title: '暂时无法读取电脑安全存储', detail: '请使用原来的 Windows 账号打开 DSH，原配对资料已保留。' }
  if (value.failureStage === 'STORAGE') return { title: '暂时无法读写连接资料', detail: '请稍后重新打开 DSH；仍有问题时可直接发送反馈。无需重新配对。' }
  if (value.failureStage === 'IDENTITY') return { title: '无法验证原有电脑身份', detail: '已暂停手机连接，原资料已保留。请发送反馈，帮助我们定位原因。' }
  if (value.failureStage === 'REGISTRATION') return { title: '电脑连接准备未完成', detail: '电脑尚未完成配对资料准备，暂时不能提交配对码。请发送连接反馈，我们帮助排查；不要清除原资料。' }
  if (value.state === 'PORT_CONFLICT') return {
    title: '连接器端口被其他程序占用',
    detail: '手机连接功能已安全暂停。不会结束其他程序，也不会自动更换已有配对的端口。',
  }
  if (value.state === 'NO_PRIVATE_ADDRESS') return {
    title: '暂未找到支持的局域网地址',
    detail: '电脑即使能上网，也可能暂未取得连接器支持的局域网地址。请连接常用 Wi-Fi 或有线网络，连接器会重新检测；仍未恢复时请发送连接反馈。云配对不要求手机与电脑在同一网络。',
  }
  if (value.state === 'DSH_UNAVAILABLE') return {
    title: 'DSH 当前不可用',
    detail: '请确认官方 DSH 已正常启动且版本受支持。',
  }
  if (value.state === 'REPAIRING') return {
    title: '正在修复连接端口',
    detail: '连接器正在验证新的完整端口组合，请稍候。',
  }
  if (value.state === 'RESTART_REQUIRED') return {
    title: '需要重新启动 DSH',
    detail: '新端口配置已安全保存，重新启动 DSH 后即可继续使用。',
  }
  if (value.state === 'FAILED'
    && value.failureStage === 'CONFIGURATION'
    && value.repairAvailable) return {
    title: '需要确认原有连接端口',
    detail: '检测到已有手机配对，但没有可验证的旧端口记录。请点击下方按钮确认后再继续。',
  }
  return {
    title: '连接器暂时无法启动',
    detail: value.failureStage === 'NO_AVAILABLE_PAIR'
      ? '有限的备用端口均不可用，请关闭占用程序后再重试。'
      : '连接器已保持安全关闭，原配对和电脑身份没有改变。',
  }
}

function PairingSettingsContent({remote,allowLegacyRevoke=false,legacyRevokePending=false,managed}: PairingOverlayProps): JSX.Element|null {
  const [snapshot,setSnapshot]=useState<PairingOverlaySnapshot|null>(null)
  const [connectorStatus,setConnectorStatus]=useState<PairingConnectorStatusSnapshot|null>(null)
  const [loaded,setLoaded]=useState(false),[pending,setPending]=useState(false)
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null)
  const [confirmingRevoke,setConfirmingRevoke]=useState(false)
  useEffect(()=>{
    if(managed!==undefined)return
    let active=true
    const refresh=async()=>{try{
      const status=await remote.connectorStatus();if(!active)return
      if(!status.ok)throw Error('status_unavailable')
      const result=await remote.snapshot();if(!active)return
      if(!result.ok)throw Error('status_unavailable')
      setConnectorStatus(status.value);setSnapshot(result.value);setError(null)
    }catch{if(active)setError(ACTION_ERROR)}finally{if(active)setLoaded(true)}}
    void refresh();const timer=setInterval(()=>{void refresh()},POLL_INTERVAL_MS)
    return()=>{active=false;clearInterval(timer)}
  },[remote,managed!==undefined])
  useEffect(()=>{
    if(managed===undefined)return
    if(managed.value){setConnectorStatus(managed.value.connectorStatus);setSnapshot(managed.value.legacySnapshot)}
    setLoaded(managed.value!==null||managed.error)
  },[managed?.value,managed?.error])
  useEffect(()=>{setConfirmingRevoke(false)},[snapshot?.status])
  const perform=async(action:'repair'|'pause'|'resume'|'revoke')=>{
    if(pending)return
    setPending(true);setError(null);setNotice(null)
    try{
      if(action==='revoke'){
        if(!allowLegacyRevoke||legacyRevokePending)return
        const result=await remote.revokePairedDevice()
        if(!result.ok)throw Error('revoke_unconfirmed')
        setSnapshot(result.value)
      }else{
        const result=action==='repair'?await remote.repairPorts():await remote.setRemoteAccess!(action==='resume')
        if(!result.ok)throw Error('operation_unconfirmed')
        setConnectorStatus(result.value)
        if(result.value.state==='READY')setNotice('连接服务已恢复，原配对资料已保留。')
        if(managed===undefined){const state=await remote.snapshot();if(!state.ok)throw Error('status_unconfirmed');setSnapshot(state.value)}
      }
    }catch{setError('操作尚未完成，原配对资料已保留。可以发送反馈，我们帮助排查。')}
    finally{setPending(false)}
  }
  if(managed?.error)return <p style={styles.error} role="alert">暂时无法读取连接器状态，正在重新核对。</p>
  if(!loaded)return <p style={styles.copy}>正在读取连接器状态…</p>
  if(connectorStatus!==null&&connectorStatus.state!=='READY'){
    const copy=connectorStatusCopy(connectorStatus)
    return <section style={styles.page} aria-labelledby="dshos-pairing-title">
      <h2 id="dshos-pairing-title" style={styles.title}>{copy.title}</h2><p style={styles.copy}>{copy.detail}</p>
      <p style={styles.codeHelp}>{VERSION_DESCRIPTION}</p>
      {error?<p style={styles.error} role="alert">{error}</p>:null}
      {connectorStatus.state==='PAUSED'&&remote.setRemoteAccess?<button type="button" style={styles.primaryButton} disabled={pending}
        onClick={()=>{void perform('resume')}}>{pending?'正在核对…':'恢复手机访问'}</button>:null}
      {connectorStatus.repairAvailable?<button type="button" style={styles.primaryButton} disabled={pending||connectorStatus.state==='REPAIRING'}
        onClick={()=>{void perform('repair')}}>{pending||connectorStatus.state==='REPAIRING'?'正在重试…':connectorStatus.failureStage==='SECURE_STORAGE_TIMEOUT'?'重试连接':'一键修复端口'}</button>:null}
    </section>
  }
  if(snapshot?.status!=='PAIRED')return error?<p role="alert" style={styles.error}>{error}</p>:null
  return <section style={styles.page} aria-labelledby="dshos-pairing-title">
    <h2 id="dshos-pairing-title" style={styles.title}>管理 DSHOS Link 配对</h2>
    <p style={styles.copy}>当前已有一台手机与此 DSH 配对。</p>
    {remote.setRemoteAccess?<button type="button" style={styles.secondaryButton} disabled={pending} onClick={()=>{void perform('pause')}}>暂停手机访问</button>:null}
    <p style={styles.codeHelp}>{VERSION_DESCRIPTION}</p>
    {notice?<p style={styles.ready} role="status">{notice}</p>:null}
    <div style={styles.workspacePanel}><h3 style={styles.workspaceTitle}>与桌面共用工作区</h3>
      <p style={styles.copy}>手机会显示桌面工作区及其中的会话。在手机点击工作区旁的“＋”，即可在该工作区开始新会话。</p>
      <p style={styles.codeHelp}>首次发送消息时创建会话。工作区可在桌面左侧添加和管理，无需另设手机目录。</p>
    </div>
    {error?<p style={styles.error} role="alert">{error}</p>:null}
    {!allowLegacyRevoke?<p style={styles.codeHelp}>解除配对请在手机的“电脑管理”中操作。重新连接时，使用手机上的配对码。</p>:<>
      <p style={styles.codeHelp}>若手机已经解除配对，可在这里撤销电脑上的原手机配对。电脑会话会保留。</p>
      {confirmingRevoke?<><p style={styles.warning} role="alert">撤销后，原手机将无法再访问这台电脑。</p>
        <button type="button" style={styles.secondaryButton} disabled={pending} onClick={()=>setConfirmingRevoke(false)}>取消</button>
        <button type="button" style={styles.dangerButton} disabled={pending||legacyRevokePending} onClick={()=>{void perform('revoke')}}>{pending?'正在撤销…':'确认撤销'}</button>
      </>:<button type="button" style={styles.dangerButton} disabled={pending||legacyRevokePending} onClick={()=>setConfirmingRevoke(true)}>撤销手机配对</button>}
    </>}
  </section>
}

export function PairingSettingsPage({cloudRemote,enrollmentRemote,remote,workspaceRemote,workspaces}:PairingOverlayProps):JSX.Element{
  const flow=usePairingFlow(enrollmentRemote)
  const paired=flow.state?.legacySnapshot?.status==='PAIRED'
  const managed=enrollmentRemote?{value:flow.state,error:flow.readError}:undefined
  const managedRemote=useMemo<PairingRemoteNamespace>(()=>!enrollmentRemote?remote:({
    ...remote,snapshot:()=>remote.snapshot(),connectorStatus:()=>remote.connectorStatus(),
    repairPorts:()=>flow.run(()=>remote.repairPorts()),
    ...(remote.setRemoteAccess?{setRemoteAccess:(enabled:boolean)=>flow.run(()=>remote.setRemoteAccess!(enabled))}:{}),
    regenerate:()=>remote.regenerate(),close:()=>remote.close(),
    confirmComputer:(sid,code)=>remote.confirmComputer(sid,code),rejectAndRegenerate:()=>remote.rejectAndRegenerate(),
    revokePairedDevice:()=>flow.run(()=>remote.revokePairedDevice()),
  }),[remote,enrollmentRemote,flow.run])
  const ready=!enrollmentRemote||flow.state!==null&&!flow.readError&&flow.state.connectorStatus?.state==='READY'
  const status=flow.state?.connectorStatus
  const blockedReason=!enrollmentRemote?'none':flow.readError?'read_failed':!flow.state?'preparing':status?.state==='NO_PRIVATE_ADDRESS'?'no_network':status?.state==='PAUSED'?'paused':ready?'none':'startup_failed'
  const blockedMessage=flow.readError?'暂时无法读取电脑状态，输入内容已保留。请点击“重新检查”；仍未恢复时可发送连接反馈。':!flow.state&&enrollmentRemote?'正在准备电脑配对，暂时不能提交配对码。':status&&status.state!=='READY'?connectorStatusCopy(status).title+'。'+connectorStatusCopy(status).detail:''
  const canRevoke=paired&&flow.state?.enrollment?.legacyManagement===true
  return <div style={styles.settingsStack}>
    {cloudRemote?<CloudPairingPanel remote={cloudRemote} paired={paired} blockedReason={blockedReason} blockedMessage={blockedMessage}
      clearInput={status?.state==='PAUSED'||status?.failureStage==='ACCESS_CONTROL'||status?.failureStage==='IDENTITY'} onCheck={()=>{void flow.recheck()}}/>:
      <p style={styles.copy} role="status">{paired?'原有配对资料已保留。':'电脑配对服务尚未加载完整，暂时不能输入配对码。'}请确认插件已启用；仍未恢复时，可使用安装工具的诊断功能，不要清除配对资料。</p>}
    <PairingSettingsContent remote={managedRemote} workspaceRemote={workspaceRemote} workspaces={workspaces}
      allowLegacyRevoke={canRevoke} legacyRevokePending={flow.busy||flow.readError} managed={managed}/>
  </div>
}

const styles: Record<string, React.CSSProperties> = {
  settingsStack: {
    width: '100%',
    maxWidth: 760,
    display: 'grid',
    gap: 16,
  },
  page: {
    width: '100%',
    maxWidth: 760,
    boxSizing: 'border-box',
    padding: 20,
    border: '1px solid var(--dsw-alias-border-l2, #374151)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-3, #1f2937)',
    color: 'var(--dsw-alias-label-primary, #f9fafb)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  statusBadge: {
    flex: '0 0 auto',
    padding: '4px 9px',
    borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-1, #111827)',
    color: 'var(--dsw-alias-label-secondary, #cbd5e1)',
    fontSize: 12,
    fontWeight: 600,
  },
  warningBadge: {
    flex: '0 0 auto',
    padding: '4px 9px',
    borderRadius: 999,
    background: 'rgb(180 83 9 / 20%)',
    color: '#fcd34d',
    fontSize: 12,
    fontWeight: 600,
  },
  title: { margin: 0, fontSize: 22, lineHeight: 1.3 },
  copy: { margin: '10px 0 18px', color: 'var(--dsw-alias-label-secondary, #cbd5e1)', lineHeight: 1.5 },
  timer: { margin: '16px 0 0', fontVariantNumeric: 'tabular-nums' },
  codePanel: { marginTop: 16, padding: 14, borderRadius: 10, background: 'rgb(37 99 235 / 16%)' },
  codeLabel: { display: 'block', margin: 0, color: 'var(--dsw-alias-label-secondary, #cbd5e1)' },
  codeInput: {
    width: 180,
    maxWidth: '100%',
    boxSizing: 'border-box',
    marginTop: 8,
    padding: '8px 12px',
    border: '1px solid var(--dsw-alias-border-l2, #4b5563)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-1, #111827)',
    color: 'inherit',
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: '0.16em',
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  codeHelp: { margin: '8px 0 0', color: 'var(--dsw-alias-label-secondary, #cbd5e1)', lineHeight: 1.4 },
  ready: { margin: '12px 0 0', color: '#86efac', lineHeight: 1.4 },
  warning: { margin: '12px 0 0', color: '#fcd34d', lineHeight: 1.5 },
  workspacePanel: {
    marginTop: 16,
    padding: 14,
    border: '1px solid var(--dsw-alias-border-l2, #4b5563)',
    borderRadius: 10,
    textAlign: 'left',
  },
  workspaceTitle: { margin: '0 0 8px', fontSize: 16 },
  diagnosticPanel: {
    width: '100%',
    boxSizing: 'border-box',
    padding: 20,
    border: '1px solid var(--dsw-alias-border-l2, #374151)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-3, #1f2937)',
    color: 'var(--dsw-alias-label-primary, #f9fafb)',
  },
  diagnosticGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    gap: '8px 16px',
    margin: '16px 0 0',
    color: 'var(--dsw-alias-label-secondary, #cbd5e1)',
  },
  diagnosticValue: {
    margin: 0,
    color: 'var(--dsw-alias-label-primary, #f9fafb)',
    overflowWrap: 'anywhere',
    fontVariantNumeric: 'tabular-nums',
  },
  diagnosticPreview: {
    margin: '12px 0 0',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: 12,
    lineHeight: 1.5,
  },
  error: { margin: '10px 0 0', color: '#fca5a5', lineHeight: 1.4 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-start', gap: 10, marginTop: 20 },
  secondaryButton: {
    padding: '9px 14px',
    border: '1px solid var(--dsw-alias-border-l2, #4b5563)',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  primaryButton: {
    padding: '9px 14px',
    border: 0,
    borderRadius: 8,
    background: 'var(--dsw-alias-state-business-primary, #2563eb)',
    color: 'var(--primary-foreground, #fff)',
    cursor: 'pointer',
  },
  dangerButton: {
    padding: '9px 14px',
    border: 0,
    borderRadius: 8,
    background: '#b91c1c',
    color: '#fff',
    cursor: 'pointer',
  },
}

export const inject = ['remote', 'slots']

interface SettingsSections {
  pairing?: Pick<PairingOverlayProps,'remote'|'enrollmentRemote'|'cloudRemote'>
  update?: ConnectorUpdateRemoteClient
  access?: ServiceAccessRemoteClient
  support?: PairingSupportRemoteClient
  diagnostics?: PairingDiagnosticsRemoteClient
}
interface SettingsStore {
  snapshot(): SettingsSections
  subscribe(listener:()=>void):()=>void
}
export function SettingsServices({store,floating=false}:{store:SettingsStore;floating?:boolean}):JSX.Element|null {
  const sections=useSyncExternalStore(store.subscribe,store.snapshot,store.snapshot)
  if(floating)return sections.update?<ConnectorUpdateNotice remote={sections.update} floating/>:null
  return <>
    {sections.update?<ConnectorUpdateNotice remote={sections.update}/>:null}
    {sections.access?<ServiceAccessPanel remote={sections.access}/>:null}
    {sections.pairing?<PairingSettingsPage {...sections.pairing}/>:<section role="status" style={styles.page}>
      <h3>连接手机</h3><p>电脑配对服务尚未加载完整，暂时不能输入配对码。请确认插件已启用；仍未恢复时，请使用安装工具的诊断功能。不要清除原配对资料。</p>
    </section>}
    {sections.support?<PairingSupportPanel remote={sections.support}/>:<p>连接反馈服务暂未就绪，可使用安装工具的诊断功能。</p>}
    {sections.diagnostics?<PairingDiagnosticsSetting remote={sections.diagnostics}/>:null}
  </>
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote=await ctx.remote.$mount(TYPERT_REMOTE)
  let sections:SettingsSections={}
  const listeners=new Set<()=>void>()
  const store:SettingsStore={snapshot:()=>sections,subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}}}
  const set=<K extends keyof SettingsSections>(key:K,value:SettingsSections[K])=>{
    sections={...sections,[key]:value};for(const listener of listeners)listener()
  }
  // Register the page before its providers. Missing auxiliary services must not
  // hide pairing; missing core providers show an explicit non-actionable state.
  const pageFiber=ctx.inject(['slots'],c=>{
    for(const slot of ['settings.plugins.tab','plugins.tab'])c.slots.inject(slot,()=>c.slots.register(
      {name:slot,id:'dshos-link-settings',order:30,label:'DSHOS Link'},()=> <SettingsServices store={store}/>))
    c.slots.inject('shell.overlay',()=>c.slots.register(
      {name:'shell.overlay',id:'dshos-link-update',order:30,label:'DSHOS Link 更新'},()=> <SettingsServices store={store} floating/>))
  })
  const fibers=[pageFiber,
    ctx.inject(['remote.dshosPairing','remote.dshosEnrollment','remote.dshosCloudPairing'],c=>{
      const remote=c.remote.dshosPairing
      set('pairing',{remote,enrollmentRemote:c.remote.dshosEnrollment,cloudRemote:cloudPairingClient(c.remote.dshosCloudPairing)})
      return async()=>{set('pairing',undefined);await remote.close().catch(()=>undefined)}
    }),
    ctx.inject(['remote.dshosUpdate'],c=>{set('update',c.remote.dshosUpdate);return async()=>{set('update',undefined)}}),
    ctx.inject(['remote.dshosServiceAccess'],c=>{set('access',c.remote.dshosServiceAccess);return async()=>{set('access',undefined)}}),
    ctx.inject(['remote.dshosSupport'],c=>{
      const support=c.remote.dshosSupport
      set('support',{status:()=>support.status(),checkLan:support.checkLan?()=>support.checkLan!():undefined,send:(_at,id)=>support.send(sections.update?connectorUpdateState(sections.update).bridgeFailureAtMs():undefined,id)})
      return async()=>{set('support',undefined)}
    }),
    ctx.inject(['remote.dshosPairingDiagnostics'],c=>{set('diagnostics',c.remote.dshosPairingDiagnostics);return async()=>{set('diagnostics',undefined)}}),
  ]
  // Do not wait for absent optional providers. Cordis owns each subscription;
  // dispose them together when the client itself is replaced.
  try{await pageFiber}catch(error){await Promise.allSettled(fibers.map(f=>f.dispose()));await disposeRemote();throw error}
  return async()=>{await Promise.allSettled(fibers.map(f=>f.dispose()));listeners.clear();await disposeRemote()}
}
