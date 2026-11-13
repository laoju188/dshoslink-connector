import { readHostAudio } from './session-audio-host.js'
import { openHostVideo } from './session-video-host.js'
import { GIF_MAX_BYTES } from './session-media-contract.js'
import { CompletionJournal } from './completion-notifications.js'
import { readInstallerDiagnostic } from './installer-diagnostic.js'
import {AuthenticationObservations} from './authentication-observations.js'
import {ProtectedSupportOutbox} from './support-outbox.js'
import { desktopNetworkDiscoveryDiagnostic } from './desktop-network.js'
import { ServiceAccessRemote } from './service-access-remote.js'
import { registerSessionBalanceReader } from './session-balance-source.js'
import type { MaintenanceHistory, UpdateEvent } from './maintenance-diagnostic.js'
import {WindowsLanInspector} from './windows-lan-diagnostic.js'
import { ConnectionObservations, observeConnection } from './connection-observations.js'
import { createDshQueuePort } from './dsh-message-queue-driver.js'
import { createDesktopSessionsSource } from './desktop-session-source.js'
import { DesktopForkJournal } from './desktop-sessions.js'
import { createDiagnosticReadSource } from './diagnostic-http.js'
import { PairingSupport, PairingSupportRemote } from './pairing-support.js'
import { createDiagnosticReport } from './diagnostic-report.js'
import { readRuntimeDshVersion, preparedDesktopLanHosts } from './runtime-version.js'
import { createPairingDiagnostics, PairingDiagnosticsRemote } from './pairing-diagnostics.js'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { CloudPairingHost } from './cloud-pairing-host.js'
import { CloudPairingRemote } from './cloud-pairing-remote.js'
import { CloudDesktopRuntime } from './cloud-pairing-runtime.js'
import { CloudDesktopVault } from './cloud-pairing-vault.js'
import { cloudPairingSupported } from './cloud-pairing-http.js'
import { loadDshRegistrationTrust } from './dsh-registration-http.js'
import { DshRegistrationTrustCache } from './dsh-registration-trust-cache.js'
import { lazyCloudQueueSource } from './cloud-pairing-queue-source.js'
import { Dsh015Api } from './dsh015-api.js'
import { isIPv4 } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

import {
  type MdnsAdvertisement,
  type StartMdnsAdvertisementOptions,
} from './mdns-spike.js'
import {
  DEFAULT_PAIRING_BOOTSTRAP_PORT,
  PAIRING_BOOTSTRAP_PORT_ENV,
} from './pairing-bootstrap-http.js'
import {
  registerPairingHttpsDevelopment,
  type PairingHttpsDevRuntime,
} from './pairing-https-dev.js'
import { registerPairingCodeCommands, registerPairingOverlayProof } from './pairing-overlay.js'
import {
  WindowsPairingPortController,
  FilePairingConnectorStatusStore,
  PAIRING_CONNECTOR_STATUS_FILE_NAME,
  type PairingConnectorStatusStore,
  type PairingPortConfigurationStore,
  type PairingPortPair,
  type WindowsPairingPortControllerDependencies,
} from './pairing-port-control.js'
import type { WindowsPairingHttpsRuntime } from './pairing-windows-https.js'
import type {
  WindowsPairingRuntimeDependencies,
  WindowsPairingRuntimeOptions,
} from './pairing-windows-runtime.js'
import type {
  SessionListSource,
  SessionListSourceRecord,
  SessionListTitleResult,
} from './session-list.js'
import type { SessionDetailSource } from './session-detail.js'
import type { SessionImageSource } from './session-image.js'
import type {
  SessionMessagePromptRequest,
  SessionMessageSource,
} from './session-message.js'
import type {
  SessionCancelRpcRequest,
  SessionControlSource,
  SessionStateRpcRequest,
} from './session-control.js'
import {
  SessionApprovalMonitor,
  approvalApiProxy,
} from './session-approval.js'
import {
  SessionQuestionMonitor,
  questionApiProxy,
} from './session-question.js'
import type { SessionFileSource } from './session-file.js'
import type {
  SessionModelRpcRequest,
  SessionModelSelectRpcRequest,
  SessionModelSource,
} from './session-model.js'
import type {
  SessionUsageRpcRequest,
  SessionUsageSource,
} from './session-usage.js'
import {
  SessionStreamMonitor,
  sessionStreamApiProxy,
} from './session-stream.js'
import {
  DEFAULT_WORKSPACE_FILE_NAME,
  DefaultWorkspaceController,
  DefaultWorkspaceRemoteService,
  FileDefaultWorkspaceStore,
  type DefaultWorkspaceListSource,
  type DefaultWorkspaceView,
  type WorkspaceDirectoryInspector,
} from './default-workspace.js'
import type {
  SessionCreateDshRequest,
  SessionCreateSource,
} from './session-create.js'
import {
  CriticalNotificationHub,
  type CriticalNotificationType,
} from './critical-notification.js'

export const PAIRING_ENABLED_ENV = 'DSHOS_LINK_PAIRING_ENABLED'
export const PAIRING_PORT_ENV = 'DSHOS_LINK_PAIRING_PORT'
export const MANAGED_RUNTIME_ENV = 'DSHOS_LINK_MANAGED_RUNTIME'
export const DEFAULT_PAIRING_PORT = 24_690
export { DEFAULT_PAIRING_BOOTSTRAP_PORT, PAIRING_BOOTSTRAP_PORT_ENV }
export const PAIRING_PROFILE_DIRECTORY = ['.dshos-link', 'pairing-v1'] as const

export interface WindowsPairingRegistrationDependencies extends WindowsPairingRuntimeDependencies {
  readonly updateDiagnostic?: () => MaintenanceHistory<UpdateEvent> | undefined
  readonly startMdnsAdvertisement?: (
    options: StartMdnsAdvertisementOptions,
  ) => Promise<MdnsAdvertisement>
  readonly portStore?: PairingPortConfigurationStore
  readonly statusStore?: PairingConnectorStatusStore
  readonly candidatePairs?: readonly PairingPortPair[]
  readonly startRuntime?: WindowsPairingPortControllerDependencies['startRuntime']
  readonly defaultWorkspaceSource?: DefaultWorkspaceListSource
  readonly inspectDefaultWorkspaceDirectory?: WorkspaceDirectoryInspector
}

interface DshSessionQueryService {
  listSessions(signal?: AbortSignal): Promise<readonly SessionListSourceRecord[]>
  readTitleSnapshots(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly SessionListTitleResult[]>
  readSurface(sessionId: string): Promise<unknown>
  readSession?(sessionId: string): Promise<unknown>
}

interface DshApiProxyService {
  readonly sessions: {
    list(request: SessionStateRpcRequest): Promise<unknown>
    prompt(request: SessionMessagePromptRequest): Promise<unknown>
    cancel(request: SessionCancelRpcRequest): Promise<unknown>
    create(request: SessionCreateDshRequest): Promise<unknown>
    presets?(request: { readonly rpcId: string; readonly payload: Record<string, never> }): Promise<unknown>
    models(request: SessionModelRpcRequest): Promise<unknown>
    newSessionModels?(request: { readonly rpcId: string; readonly payload: Record<string, never> }): Promise<unknown>
    selectModel(request: SessionModelSelectRpcRequest): Promise<unknown>
    history(request: SessionUsageRpcRequest): Promise<unknown>
    attachment(request: {
      readonly rpcId: string
      readonly payload: { readonly sessionId: string; readonly attachmentId: string }
    }): Promise<unknown>
  }
}

interface DshWorkspaceApiProxyService {
  readonly workspace: {
    list(request: { readonly rpcId: string; readonly payload: Record<string, never> }): Promise<unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dshApi(ctx: Context): unknown {
  return ctx.get('apiProxy') ?? ctx.get('dshosNativeApi')
}

function parseWorkspaceListResponse(response: unknown): readonly DefaultWorkspaceView[] {
  if (!isRecord(response) || !isRecord(response.result) || response.result.ok !== true
    || !isRecord(response.result.value) || !Array.isArray(response.result.value.items)) {
    throw new Error('DSH workspace list is unavailable')
  }
  return response.result.value.items.map((item: unknown) => {
    if (!isRecord(item)
      || typeof item.workspaceId !== 'string'
      || item.workspaceId.length === 0
      || typeof item.path !== 'string'
      || item.path.length === 0
      || typeof item.title !== 'string'
      || item.title.length === 0) throw new Error('DSH workspace list is unavailable')
    return {
      workspaceId: item.workspaceId,
      path: item.path,
      title: item.title,
    }
  })
}

function defaultWorkspaceSource(ctx: Context): DefaultWorkspaceListSource {
  return {
    async list() {
      const service: unknown = dshApi(ctx)
      if (!isRecord(service)
        || !isRecord(service.workspace)
        || typeof service.workspace.list !== 'function') {
        throw new Error('DSH workspace list is unavailable')
      }
      const response = await (service as unknown as DshWorkspaceApiProxyService).workspace.list({
        rpcId: randomUUID(),
        payload: {},
      })
      return parseWorkspaceListResponse(response)
    },
  }
}

// Resolve host services at request time: Cordis may finish loading them after the
// connector starts. A missing service fails this read, not every future read.
function sessionQuery(ctx: Context, method: keyof DshSessionQueryService): DshSessionQueryService {
  const service: unknown = ctx.get('sessionQuery')
  if (!isRecord(service) || typeof service[method] !== 'function') {
    throw new Error('DSH session query is unavailable')
  }
  return service as unknown as DshSessionQueryService
}

function sessionListSource(ctx: Context): SessionListSource {
  return {
    listSessions: signal => sessionQuery(ctx, 'listSessions').listSessions(signal),
    readTitleSnapshots: (sessionIds, signal) => sessionQuery(ctx, 'readTitleSnapshots').readTitleSnapshots(sessionIds, signal),
  }
}

function sessionDetailSource(ctx: Context): SessionDetailSource {
  return {
    readAudio: (ref,signal) => readHostAudio(ctx,ref,signal),
    readGif: (ref,signal) => readHostAudio(ctx,ref,signal,GIF_MAX_BYTES),
    openVideo: (ref,check) => openHostVideo(ctx,ref,check),
    readSurface: sessionId => sessionQuery(ctx, 'readSurface').readSurface(sessionId),
    outputRoot: () => { const store: unknown = ctx.get('spillStore'); return isRecord(store) && typeof store.root === 'string' ? store.root : undefined },
    get readSession() {
      const service: unknown = ctx.get('sessionQuery')
      return isRecord(service) && typeof service.readSession === 'function'
        ? (sessionId: string) => sessionQuery(ctx, 'readSession').readSession!(sessionId) : undefined
    },
  }
}

function sessionFileSource(ctx: Context): SessionFileSource {
  return { readSurface: sessionId => sessionQuery(ctx, 'readSurface').readSurface(sessionId) }
}

function sessionImageSource(ctx: Context): SessionImageSource {
  const source = sessionDetailSource(ctx)
  return {
    readSurface: source.readSurface,
    get readSession() { return source.readSession },
    async readAttachment(sessionId, attachmentId) {
      const service: unknown = dshApi(ctx)
      if (!isRecord(service) || !isRecord(service.sessions)
        || typeof service.sessions.attachment !== 'function') {
        throw new Error('DSH image API is unavailable')
      }
      return (service as unknown as DshApiProxyService).sessions.attachment({
        rpcId: randomUUID(), payload: { sessionId, attachmentId },
      })
    },
  }
}

function sessionMessageSource(ctx: Context): SessionMessageSource {
  return {
    prompt(request) {
      const service: unknown = dshApi(ctx)
      if (typeof service !== 'object'
        || service === null
        || !('sessions' in service)
        || typeof service.sessions !== 'object'
        || service.sessions === null
        || !('prompt' in service.sessions)
        || typeof service.sessions.prompt !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as DshApiProxyService).sessions.prompt(request)
    },
  }
}

function sessionControlSource(ctx: Context): SessionControlSource {
  return {
    list(request) {
      const service: unknown = dshApi(ctx)
      if (!isRecord(service)
        || !isRecord(service.sessions)
        || typeof service.sessions.list !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as unknown as DshApiProxyService).sessions.list(request)
    },
    cancel(request) {
      const service: unknown = dshApi(ctx)
      if (!isRecord(service)
        || !isRecord(service.sessions)
        || typeof service.sessions.cancel !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as unknown as DshApiProxyService).sessions.cancel(request)
    },
  }
}

function sessionCreateSource(ctx: Context): SessionCreateSource {
  return {
    presets(request) {
      const service = dshApi(ctx) as DshApiProxyService | undefined
      if (typeof service?.sessions?.presets !== 'function') throw new Error('DSH modes unavailable')
      return service.sessions.presets(request)
    },
    create(request) {
      const service: unknown = dshApi(ctx)
      if (typeof service !== 'object'
        || service === null
        || !('sessions' in service)
        || typeof service.sessions !== 'object'
        || service.sessions === null
        || !('create' in service.sessions)
        || typeof service.sessions.create !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as DshApiProxyService).sessions.create(request)
    },
  }
}

function sessionModelSource(ctx: Context): SessionModelSource {
  return {
    newSessionModels(request) {
      const service = dshApi(ctx) as DshApiProxyService | undefined
      if (typeof service?.sessions?.newSessionModels !== 'function') throw new Error('DSH model directory unavailable')
      return service.sessions.newSessionModels(request)
    },
    models(request) {
      const service: unknown = dshApi(ctx)
      if (typeof service !== 'object'
        || service === null
        || !('sessions' in service)
        || typeof service.sessions !== 'object'
        || service.sessions === null
        || !('models' in service.sessions)
        || typeof service.sessions.models !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as DshApiProxyService).sessions.models(request)
    },
    selectModel(request) {
      const service: unknown = dshApi(ctx)
      if (typeof service !== 'object'
        || service === null
        || !('sessions' in service)
        || typeof service.sessions !== 'object'
        || service.sessions === null
        || !('selectModel' in service.sessions)
        || typeof service.sessions.selectModel !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as DshApiProxyService).sessions.selectModel(request)
    },
  }
}

function sessionUsageSource(ctx: Context): SessionUsageSource {
  const balance = registerSessionBalanceReader(ctx, readRuntimeDshVersion())
  return {
    models(request) { return sessionModelSource(ctx).models(request) },
    balance: provider => balance.read(provider),
    balanceRevision: provider => balance.revision(provider),
    history(request) {
      const service: unknown = dshApi(ctx)
      if (typeof service !== 'object'
        || service === null
        || !('sessions' in service)
        || typeof service.sessions !== 'object'
        || service.sessions === null
        || !('history' in service.sessions)
        || typeof service.sessions.history !== 'function') {
        throw new Error('DSH API proxy is unavailable')
      }
      return (service as DshApiProxyService).sessions.history(request)
    },
  }
}

function isRfc1918Ipv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer from 1 to 65535`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`)
  }
  return port
}

function profileRootDirectory(baseUrl: string | undefined): string {
  let parsed: URL
  try {
    if (baseUrl === undefined || baseUrl === '') throw new Error()
    parsed = new URL(baseUrl)
    if (parsed.protocol !== 'file:'
      || parsed.search !== ''
      || parsed.hash !== ''
      || !parsed.pathname.endsWith('/')) throw new Error()
    return join(fileURLToPath(parsed), ...PAIRING_PROFILE_DIRECTORY)
  } catch {
    throw new Error('DSH profile base URL must be a file directory URL')
  }
}

function managedRuntimeStatusStore(
  env: NodeJS.ProcessEnv,
): PairingConnectorStatusStore | undefined {
  if (env[MANAGED_RUNTIME_ENV] !== '1') return undefined
  const localAppData = env.LOCALAPPDATA
  if (localAppData === undefined || !isAbsolute(localAppData)) {
    throw new Error('Windows managed runtime status directory is unavailable')
  }
  return new FilePairingConnectorStatusStore(join(
    localAppData,
    'DSHOSLink',
    'Runtime',
    PAIRING_CONNECTOR_STATUS_FILE_NAME,
  ))
}

interface WindowsPairingControlRegistrationOptions {
  readonly rootDirectory: string
  readonly host?: string
  readonly hosts?: readonly string[]
  readonly automaticHosts?: boolean
  readonly initialPair: PairingPortPair
  readonly allowCreate: boolean
}

function readWindowsPairingControlRegistrationOptions(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): WindowsPairingControlRegistrationOptions | undefined {
  if (env[PAIRING_ENABLED_ENV] !== '1') return undefined
  const port = env[PAIRING_PORT_ENV] === undefined
    ? DEFAULT_PAIRING_PORT
    : parsePort(env[PAIRING_PORT_ENV], PAIRING_PORT_ENV)
  const bootstrapPort = env[PAIRING_BOOTSTRAP_PORT_ENV] === undefined
    ? DEFAULT_PAIRING_BOOTSTRAP_PORT
    : parsePort(env[PAIRING_BOOTSTRAP_PORT_ENV], PAIRING_BOOTSTRAP_PORT_ENV)
  if (bootstrapPort === port) {
    throw new Error(`${PAIRING_BOOTSTRAP_PORT_ENV} must differ from ${PAIRING_PORT_ENV}`)
  }
  const requestedHost = env.DSHOS_LINK_HOST
  const host = requestedHost !== undefined
    && requestedHost === requestedHost.trim()
    && isRfc1918Ipv4(requestedHost)
    ? requestedHost
    : undefined
  return {
    rootDirectory: profileRootDirectory(baseUrl),
    host,
    ...(preparedDesktopLanHosts(env)===undefined?{}:{hosts:preparedDesktopLanHosts(env),automaticHosts:true}),
    initialPair: { port, bootstrapPort },
    allowCreate: true,
  }
}

export function readWindowsPairingRegistrationOptions(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WindowsPairingRuntimeOptions | undefined {
  const options = readWindowsPairingControlRegistrationOptions(baseUrl, env)
  if (options === undefined) return undefined
  if (options.host === undefined) {
    throw new Error('DSHOS_LINK_HOST must be an explicit RFC1918 IPv4 address')
  }
  return {
    rootDirectory: options.rootDirectory,
    host: options.host,
    ...(options.hosts?{hosts:options.hosts}:{}),
    port: options.initialPair.port,
    bootstrapPort: options.initialPair.bootstrapPort,
    allowCreate: options.allowCreate,
  }
}

export async function registerWindowsPairingRuntime(
  ctx: Context,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: WindowsPairingRegistrationDependencies = {},
): Promise<WindowsPairingHttpsRuntime | WindowsPairingPortController | undefined> {
  const options = readWindowsPairingControlRegistrationOptions(ctx.baseUrl, env)
  if (options === undefined) return undefined
  const diagnostics = createPairingDiagnostics(options.rootDirectory, env)
  const authenticationObservations=new AuthenticationObservations(()=>performance.now(),()=>JSON.stringify(controller.currentRuntime()?.runtime.currentBinding()??null))
  await diagnostics.ready
  new PairingDiagnosticsRemote(ctx, diagnostics)
  ctx.effect(() => () => diagnostics.dispose(), 'dshos-link-pairing-diagnostics')
  const {
    startMdnsAdvertisement: startAdvertisement,
    portStore,
    statusStore,
    candidatePairs,
    startRuntime,
    defaultWorkspaceSource: workspaceSource = defaultWorkspaceSource(ctx),
    inspectDefaultWorkspaceDirectory,
    ...runtimeDependencies
  } = dependencies
  const criticalNotificationHub = runtimeDependencies.criticalNotificationSource === undefined
    ? new CriticalNotificationHub(Date.now, undefined, new CompletionJournal(join(options.rootDirectory, "completion-notifications-v1")),
      () => JSON.stringify(controller.currentRuntime()?.runtime.currentBinding() ?? null))
    : undefined
  const emitCriticalNotification = (
    eventType: CriticalNotificationType,
    sessionId: string,
    sourceId: string | number,
  ): void => {
    criticalNotificationHub?.emitOnce(eventType, sessionId, sourceId)
  }
  const approvalMonitor = runtimeDependencies.sessionApprovalSource === undefined
    ? new SessionApprovalMonitor((sessionId: string, approvalId: string): void => {
      emitCriticalNotification(
        'APPROVAL_PENDING', sessionId, approvalId,
      )
    })
    : undefined
  const streamMonitor = runtimeDependencies.sessionStreamSource === undefined
    ? new SessionStreamMonitor((sessionId, seq, kind, proof): void => {
      if (kind === 'completed') {
        if (proof && criticalNotificationHub) void criticalNotificationHub.emitCompletion(proof).catch(() => undefined)
        else emitCriticalNotification('TASK_COMPLETED', sessionId, seq)
      }
      if (kind === 'blocked' || kind === 'max-tokens' || kind === 'error') {
        emitCriticalNotification('TASK_FAILED', sessionId, seq)
      }
    })
    : undefined
  const questionMonitor = runtimeDependencies.sessionQuestionSource === undefined
    ? new SessionQuestionMonitor(
      (sessionId: string): void => streamMonitor?.nudge(sessionId),
      (sessionId: string, questionRpcId: string): void => emitCriticalNotification(
        'QUESTION_PENDING', sessionId, questionRpcId,
      ),
    )
    : undefined
  const workspaceController = new DefaultWorkspaceController(
    new FileDefaultWorkspaceStore(join(
      dirname(options.rootDirectory),
      DEFAULT_WORKSPACE_FILE_NAME,
    )),
    workspaceSource,
    inspectDefaultWorkspaceDirectory,
  )
  const connectionObservations = new ConnectionObservations()
  const registrationDirectory=join(options.rootDirectory,SERVICE_ENDPOINTS.registrationStateDirectoryName)
  const cloudDirectory=join(registrationDirectory,'cloud-v3')
  const cloudRetained=()=>existsSync(join(cloudDirectory,'record-v3.sealed'))||existsSync(join(cloudDirectory,'record-v3.sealed.tmp'))
  const registryDirectory=join(env.LOCALAPPDATA??'', 'DSHOSLink',SERVICE_ENDPOINTS.registrationDirectoryName)
  const retirementTrust=new DshRegistrationTrustCache()
  ctx.effect(()=>()=>retirementTrust.close(),'dshos-link-retirement-trust')
  const cloudOptions=async(signal:AbortSignal,guard:()=>void,cached=false)=>{
    if(!env.LOCALAPPDATA||!isAbsolute(env.LOCALAPPDATA))throw Error('cloud_pairing_storage_unavailable')
    const trust=await (cached?retirementTrust.get(signal):loadDshRegistrationTrust(signal));guard()
    const key=trust.publicKey.export({format:'jwk'}).x
    const offset=trust.pairingClockOffsetMs
    if(!key||typeof offset!=='number'||!Number.isSafeInteger(offset))throw Error('cloud_pairing_service_trust_invalid')
    return {directory:cloudDirectory,registrationDirectory,registryDirectory,
      environment:SERVICE_ENDPOINTS.registrationDirectoryName==='registration-sandbox'?'SANDBOX' as const:'PRODUCTION' as const,
      trust:{keyId:trust.keyId,publicKey:key},storageDiagnostics:trust.storageDiagnostics,assertCurrent:guard,now:()=>Date.now()+offset}
  }
  const cloudHost=new CloudPairingHost({supported:cloudPairingSupported,monotonic:()=>performance.now(),
    available:()=>controller.connectorStatus().state==='READY'&&controller.currentRuntime()!==undefined,
    linkObserver:()=>diagnostics.linkObserver(),
    observeConnection:(stage,result)=>{connectionObservations.observe(stage,result);observeConnection(runtimeDependencies.observeConnection,stage,result)},
    retained:cloudRetained,
    create:async signal=>{
      const guard=()=>{signal.throwIfAborted();if(controller.connectorStatus().state!=='READY'||!controller.currentRuntime())throw Error('cloud_pairing_context_ended')}
      return new CloudDesktopRuntime({...await cloudOptions(signal,guard),
        name:hostname().slice(0,64),observe:()=>{},linkObserver:()=>diagnostics.linkObserver()})
    },
    assertNoQrOperation:()=>{
      const runtime=controller.currentRuntime()?.runtime,legacy=controller.snapshot()
      if(runtime?.enrollment?.enrollment.snapshot()||legacy&&legacy.status!=='PAIRED'&&legacy.status!=='REVOKED')throw Error('cloud_pairing_close_qr_first')
    },
    activate:async cloud=>{
      await controller.refreshLanAddresses()
      const runtime=controller.currentRuntime()?.runtime
      if(!runtime?.activateCloud)throw Error('cloud_pairing_connection_unavailable')
      await runtime.activateCloud(cloud)
    },maintain:async cloud=>{
      const runtime=controller.currentRuntime()?.runtime
      if(!runtime?.maintainCloud)throw Error('cloud_pairing_connection_unavailable')
      await runtime.maintainCloud(cloud)
    }})
  new CloudPairingRemote(ctx,cloudHost)
  ctx.effect(()=>()=>cloudHost.dispose(),'dshos-link-cloud-pairing')
  const runtimeSources: WindowsPairingRuntimeDependencies = {
    ...runtimeDependencies,
    linkObservation:()=>diagnostics.linkObserver(),
    cloudPairingActive:()=>cloudHost.active()||cloudRetained(),
    cloudAuthenticationObserver:pairingId=>cloudHost.observeAuthentication(pairingId),
    cloudQueueSource:runtimeDependencies.cloudQueueSource??((current,guard)=>lazyCloudQueueSource(cloudDirectory,registryDirectory,
      ()=>cloudOptions(AbortSignal.timeout(8000),guard),current)),
    reconcileCloudRetirement:async(store,invalidate,guard,signal)=>{
      const retained=cloudRetained()
      if(!retained&&!existsSync(join(cloudDirectory,'retirement-v3.sealed'))&&!existsSync(join(cloudDirectory,'retirement-v3.sealed.tmp')))return false
      try{
        const check=()=>{guard();signal.throwIfAborted()},options=await cloudOptions(signal,check,true)
        const retired=await new CloudDesktopVault(options).reconcileRetirement(store,invalidate,options.now,signal)
        check();if(retired)cloudHost.invalidateRetiredPairing()
        return retained||retired
      }catch(error){
        // A failed proof may indicate key rotation. Never accept it with old
        // trust or reuse a previous status; the next normal poll fetches anew.
        retirementTrust.invalidate();throw error
      }
    },
    observeConnection: (stage, result, routeId, detail) => {
      connectionObservations.observe(stage, result, routeId, detail)
      observeConnection(runtimeDependencies.observeConnection, stage, result, routeId, detail)
    },
    observeAuthentication: authenticationObservations.observe,
    authenticationTrace:id=>authenticationObservations.trace(id),
    pairingDiagnostics: runtimeDependencies.pairingDiagnostics ?? diagnostics,
    desktopSessionsSource: runtimeDependencies.desktopSessionsSource ?? createDesktopSessionsSource(ctx, sessionListSource(ctx), () => {
      const binding = controller.currentRuntime()?.runtime.currentBinding()
      return binding ? JSON.stringify([binding.pairingId, binding.mobilePublicKeyRaw]) : undefined
    }),
    desktopForkJournal: runtimeDependencies.desktopForkJournal ?? new DesktopForkJournal(join(options.rootDirectory, 'desktop-forks-v1')),
    dshQueuePort: runtimeDependencies.dshQueuePort ?? (sessionId => createDshQueuePort(ctx, sessionId)),
    diagnosticSource: runtimeDependencies.diagnosticSource ?? createDiagnosticReadSource(() => createDiagnosticReport({
      connectorStatus: controller.connectorStatus(),
      paired: controller.currentRuntime()?.runtime.currentBinding() !== undefined,
    }, { runtimeDsh: readRuntimeDshVersion() })),
    sessionListSource: runtimeDependencies.sessionListSource ?? sessionListSource(ctx),
    sessionDetailSource: runtimeDependencies.sessionDetailSource ?? sessionDetailSource(ctx),
    sessionImageSource: runtimeDependencies.sessionImageSource ?? sessionImageSource(ctx),
    sessionMessageSource: runtimeDependencies.sessionMessageSource ?? sessionMessageSource(ctx),
    sessionControlSource: runtimeDependencies.sessionControlSource ?? sessionControlSource(ctx),
    sessionApprovalSource: runtimeDependencies.sessionApprovalSource ?? approvalMonitor,
    sessionQuestionSource: runtimeDependencies.sessionQuestionSource ?? questionMonitor,
    sessionFileSource: runtimeDependencies.sessionFileSource ?? sessionFileSource(ctx),
    sessionModelSource: runtimeDependencies.sessionModelSource ?? sessionModelSource(ctx),
    sessionUsageSource: runtimeDependencies.sessionUsageSource ?? sessionUsageSource(ctx),
    sessionStreamSource: runtimeDependencies.sessionStreamSource ?? streamMonitor,
    criticalNotificationSource:
      runtimeDependencies.criticalNotificationSource ?? criticalNotificationHub,
    criticalNotificationEvents:
      runtimeDependencies.criticalNotificationEvents ?? criticalNotificationHub,
    onPairedDeviceRevoked: (): void => {
      connectionObservations.reset()
      authenticationObservations.reset()
      criticalNotificationHub?.clear()
      runtimeDependencies.onPairedDeviceRevoked?.()
    },
    sessionCreateWorkspaceSource:
      runtimeDependencies.sessionCreateWorkspaceSource ?? workspaceController,
    sessionCreateSource: runtimeDependencies.sessionCreateSource ?? sessionCreateSource(ctx),
  }
  const controller = new WindowsPairingPortController(options, {
    runtimeDependencies: runtimeSources,
    startMdnsAdvertisement: startAdvertisement,
    portStore,
    statusStore: statusStore ?? managedRuntimeStatusStore(env),
    candidatePairs,
    startRuntime,
  })
  const lanInspector=new WindowsLanInspector(()=>{
    const runtime=controller.currentRuntime()
    return runtime?{host:runtime.host,port:runtime.port,pid:process.pid,program:process.execPath}:undefined
  })
  const support = new PairingSupport(diagnostics, () => {
    const report = createDiagnosticReport({ connectorStatus:controller.connectorStatus(),
      paired:controller.currentRuntime()?.runtime.currentBinding()!==undefined },{runtimeDsh:readRuntimeDshVersion()})
    const update=dependencies.updateDiagnostic?.(),install=readInstallerDiagnostic(ctx.baseUrl)
    const networkDiscovery=desktopNetworkDiscoveryDiagnostic()
    const startup=controller.startupDiagnostic()
    const serviceAccess=controller.currentRuntime()?.runtime.relayConnectorCredentialStore.serviceAccess().diagnostic()??cloudHost.serviceAccessDiagnostic()
    return {dshVersion:report.versions.runtimeDsh ?? 'UNAVAILABLE',windowsVersion:report.versions.windows,
      ...(serviceAccess?{serviceAccess}:{}),
      ...(networkDiscovery?{networkDiscovery}:{}),
      ...(startup?{startup}:{}),
      connectorState:report.status.connectorState,failureStage:report.status.connectorFailureStage,connection:connectionObservations.snapshot(),
      authTraces:authenticationObservations.snapshot(),
      pairingContext:{newPairing:'code',localBinding:controller.currentRuntime()?.runtime.currentBinding()!==undefined?'loaded':'not_loaded'},
      ...(controller.currentRuntime()?.lanDiagnostic?{lanCandidates:controller.currentRuntime()!.lanDiagnostic}:{}),
      ...(cloudHost.diagnostic()?{cloud:cloudHost.diagnostic()!}:cloudHost.preparationDiagnostic()?{cloudPreparation:cloudHost.preparationDiagnostic()!}:{}),
      ...(update||install?{maintenance:{...(update?{update}:{}),...(install?{install}:{})}}:{})}
  },undefined,Date.now,()=>lanInspector.collect(),async signal=>{
    const binding=controller.currentRuntime()?.runtime.currentBinding()
    if(!binding||!cloudRetained())return undefined
    const expected=JSON.stringify(binding)
    const guard=()=>{signal.throwIfAborted();
      if(JSON.stringify(controller.currentRuntime()?.runtime.currentBinding())!==expected)throw Error('support_identity_changed')}
    const source=await cloudOptions(signal,guard);guard()
    const record=await new CloudDesktopVault(source).read();guard()
    if(!record?.savedReplyText||record.desktop.pairingId!==binding.pairingId||record.journal?.last?.state==='revoked')return undefined
    return {publicKey:record.desktop.memberPublicKey,privateKey:record.memberPrivateKey}
  },new ProtectedSupportOutbox(join(options.rootDirectory,'support-outbox-v1')))
  new PairingSupportRemote(ctx,support)
  new ServiceAccessRemote(ctx,()=>controller.currentRuntime()?.runtime.relayConnectorCredentialStore)
  ctx.effect(()=>()=>support.dispose(),'dshos-link-pairing-support')
  try {
    await controller.initialize()
    cloudHost.resumeRetained()
    ctx.effect(()=>{
      let closed=false,busy=false
      const timer=setInterval(()=>{
        if(closed||busy)return
        busy=true
        void controller.refreshLanAddresses().then(changed=>{
          if(closed)return
          if(changed)cloudHost.refreshConnection();else cloudHost.resumeRetained()
        }).catch(()=>{/* Keep original binding; next bounded check may recover. */}).finally(()=>{busy=false})
      },30000)
      timer.unref()
      return()=>{closed=true;clearInterval(timer);cloudHost.suspend()}
    },'dshos-link-network-refresh')
    new DefaultWorkspaceRemoteService(ctx, workspaceController)
    registerPairingOverlayProof(ctx, {
      enrollment: () => controller.currentRuntime()?.runtime.enrollment?.enrollment,
      prepareEnrollmentAddress: core => controller.repairAddressForPairing(core),
      env,
      controller,
      portControl: controller,
      commandEnabled: false,
      disposeController: false,
    })
    await registerPairingCodeCommands(ctx)
    for (const apiService of ['apiProxy', 'dshosNativeApi']) {
      if (approvalMonitor !== undefined) {
        ctx.inject([apiService], (apiCtx) => {
          const api = approvalApiProxy(apiCtx.get(apiService))
          if (api === undefined) return
          apiCtx.effect(
            () => approvalMonitor.attach(api),
            'dshos-link-session-approval-monitor',
          )
        })
      }
      if (questionMonitor !== undefined) {
        ctx.inject([apiService], (apiCtx) => {
          const api = questionApiProxy(apiCtx.get(apiService))
          if (api === undefined) return
          apiCtx.effect(
            () => questionMonitor.attach(api),
            'dshos-link-session-question-monitor',
          )
        })
      }
      if (streamMonitor !== undefined) {
        ctx.inject([apiService], (apiCtx) => {
          const api = sessionStreamApiProxy(apiCtx.get(apiService))
          if (api === undefined) return
          apiCtx.effect(
            () => streamMonitor.attach(api),
            'dshos-link-session-stream-monitor',
          )
        })
      }
    }
    ctx.effect(() => () => controller.stop(), 'dshos-link-windows-pairing-https')
    return controller.currentRuntime() ?? controller
  } catch (error) {
    retirementTrust.close()
    await diagnostics.dispose()
    await controller.stop().catch(() => undefined)
    throw error
  }
}

export async function registerPairingLifecycle(
  ctx: Context,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: WindowsPairingRegistrationDependencies = {},
): Promise<WindowsPairingHttpsRuntime | WindowsPairingPortController | PairingHttpsDevRuntime | undefined> {
  if (env[PAIRING_ENABLED_ENV] === '1') {
    ctx.inject(['sessionController', 'workspaceController', 'typertGateway', 'connection'], async scope => {
      if (scope.get('apiProxy') !== undefined) return
      const bridge = new Dsh015Api(scope)
      scope.effect(() => () => bridge.dispose(), 'dshos-link-native-dsh-api')
      await bridge.start()
      scope.provide('dshosNativeApi', bridge)
    })
  }
  const windowsRuntime = await registerWindowsPairingRuntime(ctx, env, dependencies)
  if (windowsRuntime !== undefined) return windowsRuntime
  const developmentRuntime = await registerPairingHttpsDevelopment(ctx, env)
  if (developmentRuntime !== undefined) return developmentRuntime
  registerPairingOverlayProof(ctx, { env })
  return undefined
}
