import type { LinkObserver } from './link-observation.js'
import type { ConnectionObserver } from './connection-observations.js'
import { PairingStartupError } from './pairing-startup-error.js'
import { StartupObservation } from './startup-observation.js'
import { WindowsDataProtectionError } from './windows-dpapi.js'
import type { DshQueuePort } from './dsh-message-queue-driver.js'
import type { DesktopSessionsSource, DesktopForkJournal } from './desktop-sessions.js'
import type { DiagnosticReadSource } from './diagnostic-http.js'
import { DshRegistration } from './dsh-registration.js'
import { DshRegistrationHttp, loadDshRegistrationTrust } from './dsh-registration-http.js'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import type { PairingDiagnostics } from './pairing-diagnostics.js'
import { currentLanAddressState } from './desktop-network.js'
import { validateDesktopLanHosts } from './desktop-network.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DshEnrollment, hasDshEnrollmentState } from './dsh-enrollment.js'
import { DshEnrollmentHttp } from './dsh-enrollment-http.js'
import { resumeDshRetirement } from './dsh-retirement-monitor.js'
import { startRegistrationStatusMonitor, type RegistrationStatusMonitor } from './registration-status-monitor.js'
import { resumeAcceptedCloudRetirement } from './cloud-pairing-retirement.js'
import { InMemoryPairingAuthentication } from './pairing-auth.js'
import { PairingV1Backend } from './pairing-backend.js'
import {
  loadOrCreateWindowsPairingIdentity,
  type PairingIdentityProtector,
  type WindowsPairingIdentity,
} from './pairing-identity-store.js'
import { IdentityBoundFilePairingTrustStore } from './pairing-trust-store.js'
import type { SessionListSource } from './session-list.js'
import type { SessionDetailSource } from './session-detail.js'
import type { SessionImageSource } from './session-image.js'
import type { SessionMessageSource } from './session-message.js'
import type { SessionControlSource } from './session-control.js'
import type { SessionApprovalSource } from './session-approval.js'
import type { SessionQuestionSource } from './session-question.js'
import type { SessionFileSource } from './session-file.js'
import type { SessionModelSource } from './session-model.js'
import type { SessionUsageSource } from './session-usage.js'
import type { SessionStreamSource } from './session-stream.js'
import type {
  SessionCreateSource,
  SessionCreateWorkspaceSource,
} from './session-create.js'
import { RelayRootKeyStore } from './relay-root-key-store.js'
import { RelayConnectorCredentialStore } from './relay-connector-credential.js'
import { NotificationConnectorCredentialStore } from './notification-connector-credential.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import type { DshQueueIdentitySource } from './dsh-message-queue-identity.js'
import type { CloudDesktopRuntime } from './cloud-pairing-runtime.js'
import type { PairingTrustStore } from './pairing-trust-store.js'
import { X509Certificate } from 'node:crypto'
import type { RelayBusinessWorkerController } from './relay-business-worker.js'
import type {
  CriticalNotificationEventSource,
  CriticalNotificationSource,
} from './critical-notification.js'

export const PAIRING_TRUST_FILE_NAME = 'pairing-trust-v1.json'

export interface WindowsPairingRuntimeOptions {
  readonly rootDirectory: string
  readonly host: string
  readonly hosts?: readonly string[]
  readonly port: number
  readonly bootstrapPort: number
  readonly allowCreate: boolean
}

export interface WindowsPairingRuntimeDependencies {
  readonly authenticationTrace?: (id:string)=>import('./authentication-trace.js').AuthenticationTrace|undefined
  readonly observeAuthentication?: import('./authentication-observations.js').AuthenticationObserver
  readonly linkObservation?: () => LinkObserver | undefined
  readonly cloudPairingActive?:()=>boolean
  readonly cloudAuthenticationObserver?:(pairingId:string)=>(()=>void)|undefined
  readonly cloudQueueSource?: (current:()=>PairingAuthorizationBinding|undefined,guard:()=>void)=>DshQueueIdentitySource
  readonly reconcileCloudRetirement?:(store:PairingTrustStore,invalidate:()=>void,guard:()=>void,signal:AbortSignal)=>Promise<boolean>
  readonly observeConnection?: ConnectionObserver
  readonly pairingDiagnostics?: Pick<PairingDiagnostics, 'observe'> & Partial<Pick<PairingDiagnostics, 'prepare'>>
  readonly desktopSessionsSource?: DesktopSessionsSource
  readonly desktopForkJournal?: DesktopForkJournal
  readonly dshQueuePort?: (sessionId: string) => DshQueuePort
  readonly protector?: PairingIdentityProtector
  readonly diagnosticSource?: DiagnosticReadSource
  readonly sessionListSource?: SessionListSource
  readonly sessionDetailSource?: SessionDetailSource
  readonly sessionImageSource?: SessionImageSource
  readonly sessionMessageSource?: SessionMessageSource
  readonly sessionControlSource?: SessionControlSource
  readonly sessionApprovalSource?: SessionApprovalSource
  readonly sessionQuestionSource?: SessionQuestionSource
  readonly sessionFileSource?: SessionFileSource
  readonly sessionModelSource?: SessionModelSource
  readonly sessionUsageSource?: SessionUsageSource
  readonly sessionStreamSource?: SessionStreamSource
  readonly criticalNotificationSource?: CriticalNotificationSource
  readonly criticalNotificationEvents?: CriticalNotificationEventSource
  readonly sessionCreateSource?: SessionCreateSource
  readonly sessionCreateWorkspaceSource?: SessionCreateWorkspaceSource
  readonly relayBusinessWorker?: RelayBusinessWorkerController
  readonly onPairedDeviceRevoked?: () => void
}

export interface WindowsPairingRuntime {
  readonly host: string
  readonly port: number
  readonly bootstrapPort: number
  readonly identity: WindowsPairingIdentity
  adoptLanIdentity?(identity: WindowsPairingIdentity, hosts: readonly string[]): void
  readonly backend: PairingV1Backend
  readonly relayRootKeyStore: RelayRootKeyStore
  readonly relayConnectorCredentialStore: RelayConnectorCredentialStore
  readonly notificationConnectorCredentialStore: NotificationConnectorCredentialStore
  readonly registration?: DshRegistrationHttp
  readonly enrollment?: DshEnrollmentHttp
  currentBinding(): PairingAuthorizationBinding | undefined
  activateCloud?(cloud:CloudDesktopRuntime):Promise<void>
  maintainCloud?(cloud:CloudDesktopRuntime):Promise<void>
  registrationNotificationState?(healthy: boolean): void
  dispose(): void
}

function clearIdentity(identity: WindowsPairingIdentity): void {
  identity.caDer.fill(0)
  identity.caPem.fill(0)
  identity.leafKeyPem.fill(0)
  identity.leafCertPem.fill(0)
  identity.pin.fill(0)
}

function unavailable(): never {
  throw new Error('Windows pairing runtime unavailable')
}

export async function createWindowsPairingRuntime(
  options: WindowsPairingRuntimeOptions,
  dependencies: WindowsPairingRuntimeDependencies = {},
): Promise<WindowsPairingRuntime> {
  if (typeof options.rootDirectory !== 'string'
    || options.rootDirectory.length === 0
    || typeof options.allowCreate !== 'boolean'
    || !Number.isInteger(options.port)
    || options.port < 1
    || options.port > 65_535
    || !Number.isInteger(options.bootstrapPort)
    || options.bootstrapPort < 1
    || options.bootstrapPort > 65_535
    || options.bootstrapPort === options.port) unavailable()

  let disposed = false
  let lanHosts: readonly string[] = validateDesktopLanHosts(options.hosts ?? [options.host])
  if (lanHosts.length===0 || lanHosts[0]!==options.host) unavailable()
  let identity: WindowsPairingIdentity | undefined
  let authentication: InMemoryPairingAuthentication | undefined
  let backend: PairingV1Backend | undefined
  let relayRootKeyStore: RelayRootKeyStore | undefined
  let relayConnectorCredentialStore: RelayConnectorCredentialStore | undefined
  let notificationConnectorCredentialStore: NotificationConnectorCredentialStore | undefined
  let registration: DshRegistrationHttp | undefined
  let enrollment: DshEnrollmentHttp | undefined
  const registrationDirectory = join(options.rootDirectory, SERVICE_ENDPOINTS.registrationStateDirectoryName)
  const enrollmentDirectory = join(registrationDirectory, 'enrollment-v2')
  let currentBinding: (() => PairingAuthorizationBinding | undefined) | undefined
  let stopRetirementMonitor: (() => void) | undefined
  let registrationMonitor: RegistrationStatusMonitor | undefined
  let activateCloud:((cloud:CloudDesktopRuntime)=>Promise<void>)|undefined
  let maintainCloud:((cloud:CloudDesktopRuntime)=>Promise<void>)|undefined
  const startup = new StartupObservation()
  try {
    identity = await startup.run('identity', () => loadOrCreateWindowsPairingIdentity({
      rootDirectory: options.rootDirectory,
      host: options.host,
      hosts: lanHosts,
      allowCreate: options.allowCreate,
      protector: dependencies.protector,
    }))
    const trustStore = startup.sync('trust_store', () => new IdentityBoundFilePairingTrustStore(
      join(options.rootDirectory, PAIRING_TRUST_FILE_NAME),
      identity!.identityId,
    ))
    currentBinding = () => {
      if (disposed) return undefined
      const record = trustStore.read()
      return record?.status === 'active'
        ? Object.freeze({
          pairingId: record.pairingId,
          mobilePublicKeyRaw: record.mobilePublicKeyRaw,
        })
        : undefined
    }
    relayRootKeyStore = startup.sync('credentials', () => new RelayRootKeyStore({
      rootDirectory: options.rootDirectory,
      identityId: identity!.identityId,
      protector: dependencies.protector,
    }))
    relayConnectorCredentialStore = startup.sync('credentials', () => new RelayConnectorCredentialStore({
      rootDirectory: options.rootDirectory,
      identityId: identity!.identityId,
      protector: dependencies.protector,
      currentBinding: currentBinding!,
    }))
    notificationConnectorCredentialStore = startup.sync('credentials', () => new NotificationConnectorCredentialStore({
      rootDirectory: options.rootDirectory,
      identityId: identity!.identityId,
      protector: dependencies.protector,
      currentBinding: currentBinding!,
    }))
    if (startup.sync('trust_store', () => trustStore.read())?.status !== 'active') {
      startup.sync('credential_cleanup', () => {
        relayRootKeyStore!.revoke()
        relayConnectorCredentialStore!.revoke()
        notificationConnectorCredentialStore!.revoke()
      })
    }
    authentication = startup.sync('authentication', () => new InMemoryPairingAuthentication(trustStore, identity!.pin, {
      observeChallenge: pairingId => {
        const cloud=dependencies.cloudAuthenticationObserver?.(pairingId)
        return ()=>{cloud?.()}
      },
    }))
    backend = startup.sync('authentication', () => new PairingV1Backend({
        trustStore,
        authentication: authentication!,
        assertLegacyRevocationAllowed: () => {
          if(dependencies.cloudPairingActive?.())throw Error('cloud_pairing_in_progress')
          if (enrollment ? !enrollment.enrollment.allowsLegacyInvitation : hasDshEnrollmentState(enrollmentDirectory)) throw Error('DSH enrollment recovery required')
        },
        onPairedDeviceRevoked: () => {
          registration?.cancel()
          enrollment?.close()
          relayRootKeyStore!.revoke()
          relayConnectorCredentialStore!.revoke()
          notificationConnectorCredentialStore!.revoke()
          dependencies.onPairedDeviceRevoked?.()
        },
      },
    ))
    const local = process.env.LOCALAPPDATA
    const assertCurrent=()=>{if(disposed)throw Error('cloud_pairing_context_ended')}
    const invalidateRetired=()=>{
      assertCurrent();authentication!.invalidate();registration?.cancel()
      relayRootKeyStore!.revoke();relayConnectorCredentialStore!.revoke();notificationConnectorCredentialStore!.revoke()
      dependencies.onPairedDeviceRevoked?.()
    }
    // Finish durable cloud revocation before this runtime can reach a listener.
    // The registry path must be the original one; missing context fails closed
    // when a journal exists, while normal installations without one stay usable.
    await startup.run('cloud_recovery', () => resumeDshRetirement(()=>resumeAcceptedCloudRetirement({
      directory:join(registrationDirectory,'cloud-v3'),registrationDirectory,
      registryDirectory:process.platform==='win32'&&local&&/^[a-z]:[\\/]/i.test(local)
        ?join(local,'DSHOSLink',SERVICE_ENDPOINTS.registrationDirectoryName):undefined,
      trustStore,invalidate:invalidateRetired,assertCurrent,
    })))
    if (process.platform === 'win32' && local && /^[a-z]:[\\/]/i.test(local)) {
      registration = startup.sync('registration', () => new DshRegistrationHttp(new DshRegistration({
        directory: registrationDirectory,
        registryDirectory: join(local, 'DSHOSLink', SERVICE_ENDPOINTS.registrationDirectoryName),
        currentBinding: () => hasDshEnrollmentState(enrollmentDirectory)
          || hasDshEnrollmentState(join(registrationDirectory, 'retirement-v2')) ? undefined : currentBinding!(),
        legacy: notificationConnectorCredentialStore!, loadTrust: loadDshRegistrationTrust,
      }), backend!))
      const core = startup.sync('registration', () => new DshEnrollment({
        legacyManagementAllowed: () => !dependencies.cloudPairingActive?.(),
        assertNewInvitationAllowed: () => { throw Error('pairing_upgrade_required') },
        observePairing: dependencies.pairingDiagnostics?.observe,
        preparePairing: dependencies.pairingDiagnostics?.prepare,
        addressState: () => currentLanAddressState(options.host),
        directory: enrollmentDirectory, registryDirectory: join(local, 'DSHOSLink', SERVICE_ENDPOINTS.registrationDirectoryName),
        host: options.host, port: options.port, bootstrapPort: options.bootstrapPort, pin: identity!.pin.toString('base64url'),
        trustStore, loadTrust: loadDshRegistrationTrust,
        invalidateRetired,
        assertAvailable: () => {
          if(dependencies.cloudPairingActive?.())throw Error('cloud_pairing_in_progress')
          if (existsSync(join(registrationDirectory, 'material-v2.json')) || existsSync(join(registrationDirectory, 'material-v2.json.tmp')))
            throw Error('Use existing DSH registration')
          if (backend!.invitationStore.snapshot()) throw Error('Close existing pairing first')
        },
      }))
      await startup.run('enrollment_recovery', () => resumeDshRetirement(() => core.resumeRetirement()))
      enrollment = startup.sync('registration', () => new DshEnrollmentHttp(core))
      registrationMonitor = startup.sync('connection_runtime', () => startRegistrationStatusMonitor(async () => {
        if(await dependencies.reconcileCloudRetirement?.(trustStore,invalidateRetired,assertCurrent,AbortSignal.timeout(8000)))return
        assertCurrent();await core.reconcileRetirement()
      }))
      stopRetirementMonitor = () => registrationMonitor?.stop()
    }
    maintainCloud=async cloud=>{if(disposed)throw Error('cloud_pairing_runtime_unavailable')
      await cloud.provisionRelay(trustStore,relayRootKeyStore!,relayConnectorCredentialStore!)}
    activateCloud=async cloud=>{
      if(disposed||!identity)throw Error('cloud_pairing_runtime_unavailable')
      if(lanHosts.length===0)throw Error('cloud_pairing_connection_unavailable')
      const invalidatePrevious=()=>{
        if(disposed)throw Error('cloud_pairing_context_ended')
        authentication!.invalidate();registration?.cancel()
        relayRootKeyStore!.revoke();relayConnectorCredentialStore!.revoke();notificationConnectorCredentialStore!.revoke()
        dependencies.onPairedDeviceRevoked?.()
      }
      // A published offer is immediately visible to the phone. Finish the
      // authoritative local activation first, including protected storage;
      // otherwise its first AUTH_START can arrive before trust is ready.
      await cloud.connect(trustStore,invalidatePrevious)
      if(disposed)throw Error('cloud_pairing_context_ended')
      const relayKey=await cloud.relayPublicKey()
      if(disposed)throw Error('cloud_pairing_context_ended')
      if(lanHosts.length===0)throw Error('cloud_pairing_connection_unavailable')
      await cloud.connect(trustStore,invalidatePrevious,{revision:Date.now(),ca:identity.caDer.toString('base64url'),leaf:new X509Certificate(identity.leafCertPem).raw.toString('base64url'),
        pin:identity.pin.toString('base64url'),candidates:lanHosts.map(host=>({host,port:options.port})),relayKey})
      if(disposed)throw Error('cloud_pairing_context_ended')
    }
  } catch (error) {
    const failure = new PairingStartupError(error instanceof PairingStartupError ? error.stage :
      error instanceof WindowsDataProtectionError
        ? (error.reason === 'timeout' ? 'SECURE_STORAGE_TIMEOUT' : 'SECURE_STORAGE')
        : identity ? 'REGISTRATION' : 'IDENTITY', 'Windows pairing runtime unavailable', startup.fail(error))
    disposed = true
    for (const stop of [() => stopRetirementMonitor?.(), () => notificationConnectorCredentialStore?.suspend(),
      () => backend?.dispose(), () => authentication?.dispose(), () => registration?.cancel(),
      () => enrollment?.close(), () => { if (identity !== undefined) clearIdentity(identity) }]) {
      try { stop() } catch { /* Cleanup must not replace the startup cause. */ }
    }
    throw failure
  }

  return Object.freeze({
    host: options.host,
    port: options.port,
    bootstrapPort: options.bootstrapPort,
    get identity() { return identity! },
    adoptLanIdentity(next: WindowsPairingIdentity, hosts: readonly string[]): void {
      if(disposed || next.identityId!==identity!.identityId || !next.pin.equals(identity!.pin)
        || !next.caDer.equals(identity!.caDer)) throw Error('lan_listener_identity_changed')
      const checked=validateDesktopLanHosts(hosts),cert=new X509Certificate(next.leafCertPem)
      if(checked.some(host=>cert.checkIP(host)!==host))throw Error('lan_listener_certificate_changed')
      const previous=identity!;identity=next;lanHosts=checked
      if(previous!==next)clearIdentity(previous)
    },
    backend,
    relayRootKeyStore,
    relayConnectorCredentialStore,
    notificationConnectorCredentialStore,
    registration,
    enrollment,
    currentBinding: currentBinding!,
    activateCloud,
    maintainCloud,
    registrationNotificationState: (healthy: boolean) => registrationMonitor?.notificationState(healthy),
    dispose() {
      if (disposed) return
      disposed = true
      let firstError: unknown
      for (const stop of [() => authentication?.dispose(), () => notificationConnectorCredentialStore.suspend(),
        () => stopRetirementMonitor?.(), () => registration?.cancel(), () => enrollment?.close(),
        () => backend.dispose(), () => clearIdentity(identity!)]) {
        try { stop() } catch (error) { firstError ??= error }
      }
      if (firstError !== undefined) throw firstError
    },
  })
}
