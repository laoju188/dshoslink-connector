import { LinkUsageReporter, linkAuthenticationObserver } from './link-observation.js'
import { SessionVideoService } from './session-video.js'
import { SESSION_VIDEO_PATH } from './session-media-contract.js'
import {LinkDiagnosticReporter} from './link-diagnostic-reporter.js'
import { CONNECTOR_VERSION } from './connector-metadata.js'
import { PairingLanListeners } from './pairing-lan-listeners.js'
import { StartupObservation } from './startup-observation.js'
import type { StartupDiagnostic } from './startup-diagnostic.js'
import type { LanCandidateDiagnostic } from './pairing-support-contract.js'
import { loadOrCreateWindowsPairingIdentity } from './pairing-identity-store.js'
import { join } from 'node:path'
import { DESKTOP_PAIRING_PATH, desktopPairingCapability } from './desktop-sessions.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { LISTENER_SIGNALS } from './pairing-trace-contract.js'
import { DshMessageQueueRuntime } from './dsh-message-queue-runtime.js'
import { createDshQueueIdentityLoader } from './dsh-message-queue-identity.js'
import { createCloudCompatibleQueueLoader } from './cloud-pairing-queue-source.js'
import { DSH_QUEUE_PATH } from './dsh-message-queue-contract.js'
import {
  createPairingV1RequestHandler,
} from './pairing-backend.js'
import { DSH_REGISTRATION_PREFIX } from './dsh-registration-http.js'
import { DSH_ENROLLMENT_PREFIX } from './dsh-enrollment-local.js'
import {
  startPairingBootstrapHttpServer,
  type PairingBootstrapHttpServer,
} from './pairing-bootstrap-http.js'
import { startPairingHttpsServer, type PairingHttpsServer } from './pairing-https-server.js'
import { SESSION_IMAGE_MESSAGE_PATH, SESSION_IMAGE_MESSAGE_REQUEST_MAX_BYTES } from './session-image-message.js'
import {
  createWindowsPairingRuntime,
  type WindowsPairingRuntime,
  type WindowsPairingRuntimeDependencies,
  type WindowsPairingRuntimeOptions,
} from './pairing-windows-runtime.js'
import {
  sessionFileRequestByteLimit,
} from './session-file.js'
import {
  isSessionRequestPath,
  SessionRequestRouter,
} from './session-request-router.js'
import {
  createRelayRootKeyRequestHandler,
  RELAY_ROOT_KEY_PATH,
} from './relay-root-key-store.js'
import {
  createRelayConnectorCredentialRequestHandler,
  RELAY_CONNECTOR_CREDENTIAL_PATH,
} from './relay-connector-credential.js'
import {
  createNotificationConnectorCredentialRequestHandler,
  NOTIFICATION_CONNECTOR_CREDENTIAL_PATH,
} from './notification-connector-credential.js'
import {
  RelayBusinessWorker,
  type RelayBusinessWorkerController,
} from './relay-business-worker.js'
import {
  CriticalNotificationDeliveryWorker,
  type CriticalNotificationDeliveryWorkerController,
} from './critical-notification-worker.js'

export interface WindowsPairingHttpsRuntime {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  readonly bootstrapPort: number
  readonly bootstrapBaseUrl: string
  readonly runtime: WindowsPairingRuntime
  readonly hosts?: readonly string[]
  readonly lanDiagnostic?: LanCandidateDiagnostic
  refreshHosts?(hosts: readonly string[]): Promise<void>
  stop(): Promise<void>
}

export type WindowsPairingListenerFailureStage = 'pairing_https' | 'bootstrap_http'
export type WindowsPairingListenerFailureReason =
  | 'port_conflict'
  | 'address_unavailable'
  | 'unknown'

export class WindowsPairingListenerStartError extends Error {
  constructor(
    readonly stage: WindowsPairingListenerFailureStage,
    readonly reason: WindowsPairingListenerFailureReason,
    readonly hadActiveTrust: boolean,
    readonly startup?: StartupDiagnostic,
  ) {
    super('Windows pairing listener startup failed')
  }
}

function listenerFailureReason(error: unknown): WindowsPairingListenerFailureReason {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : undefined
  if (code === 'EADDRINUSE') return 'port_conflict'
  if (code === 'EADDRNOTAVAIL') return 'address_unavailable'
  return 'unknown'
}

export async function startWindowsPairingHttpsRuntime(
  options: WindowsPairingRuntimeOptions,
  dependencies: WindowsPairingRuntimeDependencies = {},
): Promise<WindowsPairingHttpsRuntime> {
  let messageQueueRuntime: DshMessageQueueRuntime | undefined
  let queueClosed = false
  let usage: LinkUsageReporter | undefined
  let diagnosticReporter:LinkDiagnosticReporter|undefined
  const observeAuthentication:NonNullable<WindowsPairingRuntimeDependencies['observeAuthentication']>=(id,stage,result)=>{
    try{dependencies.observeAuthentication?.(id,stage,result)}catch{/* Preserve independent optional observers. */}
    try{const trace=dependencies.authenticationTrace?.(id)
      if(trace?.events.some(e=>e.stage==='start_received'))diagnosticReporter?.record({kind:'authentication',trace},'lan')
    }catch{/* Optional diagnostic reads cannot affect authentication. */}
  }
  const observeConnection:NonNullable<WindowsPairingRuntimeDependencies['observeConnection']>=(stage,result,routeId,detail)=>{
    try{dependencies.observeConnection?.(stage,result,routeId,detail)}catch{/* Observations cannot affect transport. */}
    if(stage==='relay_notify'&&detail)diagnosticReporter?.record({kind:'notification',result,atMs:Date.now(),detail},'relay')
  }
  let runtime: WindowsPairingRuntime | undefined
  let listeners: PairingLanListeners | undefined
  let sessionRequestRouter: SessionRequestRouter | undefined
  let sessionVideo: SessionVideoService | undefined
  let relayBusinessWorker: RelayBusinessWorkerController | undefined
  let criticalNotificationWorker: CriticalNotificationDeliveryWorkerController | undefined
  try {
    runtime = await createWindowsPairingRuntime(options, { ...dependencies,observeConnection,observeAuthentication,
      cloudAuthenticationObserver:linkAuthenticationObserver(()=>usage,dependencies.cloudAuthenticationObserver,'lan') })
    const authorizer = runtime.backend
    sessionVideo = new SessionVideoService(authorizer, dependencies.sessionDetailSource)
    const pairingHandler = createPairingV1RequestHandler(runtime.backend)
    const currentRuntime = runtime
    if (dependencies.dshQueuePort && runtime.registration && runtime.enrollment) {
      const assertRuntime = (): void => { if (queueClosed) throw Error('queue_runtime_closed') }
      const legacy=[runtime.registration.registration,runtime.enrollment.enrollment]
      const cloud=dependencies.cloudQueueSource?.(currentRuntime.currentBinding,assertRuntime)
      const loadIdentity=cloud?createCloudCompatibleQueueLoader(legacy,cloud,currentRuntime.currentBinding,assertRuntime)
        :createDshQueueIdentityLoader(legacy,currentRuntime.currentBinding,assertRuntime)
      usage=new LinkUsageReporter(loadIdentity,currentRuntime.currentBinding,dependencies.linkObservation??(()=>undefined),
        CONNECTOR_VERSION,SERVICE_ENDPOINTS.registrationDirectoryName==='registration-sandbox'?'SANDBOX':'PRODUCTION')
      diagnosticReporter=new LinkDiagnosticReporter(loadIdentity,currentRuntime.currentBinding,dependencies.linkObservation??(()=>undefined),
        CONNECTOR_VERSION,SERVICE_ENDPOINTS.registrationDirectoryName==='registration-sandbox'?'SANDBOX':'PRODUCTION')
      messageQueueRuntime = new DshMessageQueueRuntime({
        directory: join(options.rootDirectory, SERVICE_ENDPOINTS.registrationStateDirectoryName, 'message-queue-v1'),
        loadIdentity,
        port: dependencies.dshQueuePort, assertRuntime,
      })
    }
    sessionRequestRouter = new SessionRequestRouter(runtime.backend, { ...dependencies, messageQueueRuntime, observeBusinessRequest:()=>usage?.capture('lan') })
    relayBusinessWorker = dependencies.relayBusinessWorker ?? new RelayBusinessWorker({
      ...dependencies,
      observeConnection,
      messageQueueRuntime,
      credentialStore: runtime.relayConnectorCredentialStore,
      registrationNotificationProvider: runtime.notificationConnectorCredentialStore,
      rootKeyStore: runtime.relayRootKeyStore,
      currentBinding: runtime.currentBinding,
      onRegistrationState: healthy => currentRuntime.registrationNotificationState?.(healthy),
      observeAuthenticationTrace:observeAuthentication,
      observeAuthentication:linkAuthenticationObserver(()=>usage,dependencies.cloudAuthenticationObserver,'relay'),
      observeBusinessRequest:()=>usage?.capture('relay'),
    })
    if (dependencies.criticalNotificationEvents !== undefined) {
      criticalNotificationWorker = new CriticalNotificationDeliveryWorker({
        source: dependencies.criticalNotificationEvents,
        observeConnection,
        credentialStore: runtime.notificationConnectorCredentialStore,
      })
    }
    const relayRootKeyHandler = createRelayRootKeyRequestHandler(
      runtime.backend,
      runtime.relayRootKeyStore,
    )
    const relayConnectorCredentialHandler = createRelayConnectorCredentialRequestHandler(
      runtime.backend,
      runtime.relayConnectorCredentialStore,
    )
    const notificationConnectorCredentialHandler =
      createNotificationConnectorCredentialRequestHandler(
        runtime.backend,
        runtime.notificationConnectorCredentialStore,
      )
    const routeRequest = (request: Parameters<typeof pairingHandler>[0], source?: string) => {
      const barePath = request.path.split(/[?#]/, 1)[0]
      if (barePath === DESKTOP_PAIRING_PATH) {
        const response=desktopPairingCapability(request,dependencies.desktopSessionsSource?.identity()!==undefined)
        return response
      }
      if (barePath?.startsWith(DSH_ENROLLMENT_PREFIX) && runtime!.enrollment) return runtime!.enrollment.handle(request, source)
      if (barePath?.startsWith(DSH_REGISTRATION_PREFIX) && runtime!.registration) return runtime!.registration.handle(request)
      if (barePath === SESSION_VIDEO_PATH) return sessionVideo!.handle(request)
      if (isSessionRequestPath(barePath)) return sessionRequestRouter!.handle(request)
      if (barePath === RELAY_ROOT_KEY_PATH) return relayRootKeyHandler(request)
      if (barePath === RELAY_CONNECTOR_CREDENTIAL_PATH) {
        return relayConnectorCredentialHandler(request)
      }
      if (barePath === NOTIFICATION_CONNECTOR_CREDENTIAL_PATH) {
        return notificationConnectorCredentialHandler(request)
      }
      return pairingHandler(request)
    }
    listeners = new PairingLanListeners({
      identity:()=>currentRuntime.identity,
      loadIdentity:hosts=>loadOrCreateWindowsPairingIdentity({rootDirectory:options.rootDirectory,
        host:hosts[0]!,hosts,allowCreate:false,protector:dependencies.protector}),
      adopt:(identity,hosts)=>currentRuntime.adoptLanIdentity!(identity,hosts),
      start:async(host,identity)=>{
        let server: PairingHttpsServer | undefined,bootstrap: PairingBootstrapHttpServer | undefined
        let stage:WindowsPairingListenerFailureStage='pairing_https'
        // The real runtime is ready here. Keep each address attempt independent,
        // so a failed address cannot overwrite a later listener's evidence.
        const startup = new StartupObservation(Date.now, 'connection_runtime')
        try {
          server = await startup.run('https_listener', () => startPairingHttpsServer({
      host,
      port: currentRuntime.port,
      key: identity.leafKeyPem,
      cert: identity.leafCertPem,
      observeAuthentication,
      authenticationScope:()=>JSON.stringify(currentRuntime.currentBinding()??null),
      handler: (request, context) => routeRequest(request, context.remoteAddress),
      requestByteLimit: (path, authorization, connectionGeneration) => {
        if (path.split(/[?#]/, 1)[0]?.startsWith(DSH_ENROLLMENT_PREFIX)) return 8192
        return authorizer.authorize(authorization, connectionGeneration)
          ? (path === DSH_QUEUE_PATH ? 32768 : path === SESSION_IMAGE_MESSAGE_PATH ? SESSION_IMAGE_MESSAGE_REQUEST_MAX_BYTES : sessionFileRequestByteLimit(path))
          : undefined
      },
    }))
          stage='bootstrap_http'
          bootstrap=await startup.run('bootstrap_listener', () => startPairingBootstrapHttpServer({host,port:currentRuntime.bootstrapPort,caDer:identity.caDer}))
          const activeServer=server,activeBootstrap=bootstrap
          return {
            updateIdentity(next){activeServer.updateIdentity(next.leafKeyPem,next.leafCertPem)},
            async stop(){
              const results=await Promise.allSettled([activeBootstrap.stop(),activeServer.stop()])
              const failed=results.find(result=>result.status==='rejected')
              if(failed?.status==='rejected')throw failed.reason
            },
          }
        } catch(error) {
          await bootstrap?.stop().catch(()=>undefined);await server?.stop().catch(()=>undefined)
          let active=true;try{active=currentRuntime.currentBinding()!==undefined}catch{/* Fail closed. */}
          throw new WindowsPairingListenerStartError(stage,listenerFailureReason(error),active,startup.fail(error))
        }
      },
    })
    await listeners.refresh(options.hosts??[options.host])
    relayBusinessWorker.start()
    criticalNotificationWorker?.start()
  } catch (error) {
    queueClosed = true; usage?.close();diagnosticReporter?.close()
    const listenerStop=listeners?.stop()
    try { runtime?.dispose() } catch { /* Keep the original startup cause. */ }
    await messageQueueRuntime?.close().catch(() => undefined)
    await criticalNotificationWorker?.stop().catch(() => undefined)
    await relayBusinessWorker?.stop().catch(() => undefined)
    await listenerStop?.catch(() => undefined)
    await sessionRequestRouter?.dispose().catch(() => undefined)
    await sessionVideo?.dispose().catch(() => undefined)
    throw error
  }

  let stopped = false
  return Object.freeze({
    get host(){return listeners!.hosts()[0]??options.host},
    get hosts(){return listeners!.hosts()},
    get lanDiagnostic(){return listeners!.diagnostic()},
    port: options.port,
    get baseUrl(){return `https://${listeners!.hosts()[0]??options.host}:${options.port}`},
    bootstrapPort: options.bootstrapPort,
    get bootstrapBaseUrl(){return `http://${listeners!.hosts()[0]??options.host}:${options.bootstrapPort}`},
    refreshHosts:(hosts:readonly string[])=>listeners!.refresh(hosts),
    runtime,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      queueClosed = true; usage?.close();diagnosticReporter?.close()
      let firstError: unknown
      const listenerStop=listeners!.stop().catch(error=>{firstError??=error})
      try { runtime.dispose() } catch (error) { firstError = error }
      const queueStop = messageQueueRuntime?.close().then(() => undefined, error => error as unknown)
      try {
        await criticalNotificationWorker?.stop()
      } catch (error) {
        firstError ??= error
      }
      try {
        await relayBusinessWorker.stop()
      } catch (error) {
        firstError ??= error
      }
      await listenerStop
      try {
        await sessionRequestRouter.dispose()
        await sessionVideo?.dispose()
      } catch (error) {
        firstError ??= error
      }
      const queueError = await queueStop
      firstError ??= queueError
      if (firstError !== undefined) throw firstError
    },
  })
}
