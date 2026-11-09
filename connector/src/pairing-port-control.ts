import { RemoteAccessSwitch, samePausedIdentity, type PausedRemoteIdentity } from './remote-access-switch.js'
import { loadOrCreateWindowsPairingIdentity } from './pairing-identity-store.js'
import { IdentityBoundFilePairingTrustStore } from './pairing-trust-store.js'
import { PAIRING_TRUST_FILE_NAME } from './pairing-windows-runtime.js'
import { PairingStartupError } from './pairing-startup-error.js'
import { StartupObservation } from './startup-observation.js'
import { copyStartupDiagnostic, type StartupDiagnostic } from './startup-diagnostic.js'
import { observeConnection } from './connection-observations.js'
import { randomUUID } from 'node:crypto'
import { currentLanAddressState, readDesktopLanHost, readDesktopLanHosts, desktopLanInterfaceSnapshot } from './desktop-network.js'
import type { DshEnrollment } from './dsh-enrollment.js'
import { rmSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  MdnsAdvertisement,
  StartMdnsAdvertisementOptions,
} from './mdns-spike.js'
import { startMdnsAdvertisement } from './mdns-spike.js'
import {
  TransientInvitationStore,
  type PairingOverlayComputerConfirmation,
  type PairingOverlayController,
  type PairingOverlaySnapshot,
} from './pairing-overlay.js'
import {
  startWindowsPairingHttpsRuntime,
  WindowsPairingListenerStartError,
  type WindowsPairingHttpsRuntime,
} from './pairing-windows-https.js'
import type {
  WindowsPairingRuntimeDependencies,
  WindowsPairingRuntimeOptions,
} from './pairing-windows-runtime.js'

export const PAIRING_PORT_CONFIG_FILE_NAME = 'pairing-ports-v1.json'
export const PAIRING_PORT_RECOVERY_FILE_NAME = 'pairing-ports-recovery-v1.json'
export const PAIRING_CONNECTOR_STATUS_FILE_NAME = 'listener-status-v1.json'

export interface PairingPortPair {
  readonly port: number
  readonly bootstrapPort: number
}

export const DEFAULT_PAIRING_PORT_PAIRS: readonly PairingPortPair[] = Object.freeze([
  Object.freeze({ port: 24_690, bootstrapPort: 24_691 }),
  Object.freeze({ port: 24_692, bootstrapPort: 24_693 }),
  Object.freeze({ port: 24_694, bootstrapPort: 24_695 }),
  Object.freeze({ port: 24_696, bootstrapPort: 24_697 }),
])

export type PairingConnectorState =
  | 'PAUSED'
  | 'READY'
  | 'PORT_CONFLICT'
  | 'NO_PRIVATE_ADDRESS'
  | 'DSH_UNAVAILABLE'
  | 'REPAIRING'
  | 'RESTART_REQUIRED'
  | 'FAILED'

export type PairingConnectorFailureStage =
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

export interface PairingConnectorStatusSnapshot {
  readonly state: PairingConnectorState
  readonly port: number
  readonly bootstrapPort: number
  readonly failureStage: PairingConnectorFailureStage
  readonly repairAvailable: boolean
}

export interface PairingPortControl {
  connectorStatus(): PairingConnectorStatusSnapshot
  repairPorts(): Promise<PairingConnectorStatusSnapshot>
  setRemoteAccess?(enabled: boolean): Promise<PairingConnectorStatusSnapshot>
}

export interface PairingPortConfigurationStore {
  read(): Promise<PairingPortPair | null>
  write(pair: PairingPortPair): Promise<void>
  clear(): Promise<void>
  recoverPending(): Promise<void>
  beginChange(previous: PairingPortPair | null): Promise<void>
  commitChange(): void
}

export interface PairingConnectorStatusStore {
  write(snapshot: PairingConnectorStatusSnapshot): Promise<void>
}

interface StoredPairingConnectorStatus extends PairingConnectorStatusSnapshot {
  readonly version: 1
  readonly updatedAt: number
  readonly processId: number
}

interface StoredPairingPortConfiguration {
  readonly version: 1
  readonly port: number
  readonly bootstrapPort: number
}

interface StoredPairingPortRecovery {
  readonly version: 1
  readonly previous: StoredPairingPortConfiguration | null
}

const CONFIGURATION_FIELDS = ['version', 'port', 'bootstrapPort']
const RECOVERY_FIELDS = ['version', 'previous']
const STATUS_FIELDS = [
  'version', 'state', 'port', 'bootstrapPort', 'failureStage', 'repairAvailable',
  'updatedAt', 'processId',
]
const CONNECTOR_STATES: readonly PairingConnectorState[] = [
  'PAUSED', 'READY', 'PORT_CONFLICT', 'NO_PRIVATE_ADDRESS', 'DSH_UNAVAILABLE',
  'REPAIRING', 'RESTART_REQUIRED', 'FAILED',
]
const FAILURE_STAGES: readonly PairingConnectorFailureStage[] = [
  'ACCESS_CONTROL', 'NONE', 'PAIRING_HTTPS', 'BOOTSTRAP_HTTP', 'CONFIGURATION',
  'NO_AVAILABLE_PAIR', 'UNKNOWN', 'SECURE_STORAGE_TIMEOUT', 'SECURE_STORAGE', 'IDENTITY', 'STORAGE', 'REGISTRATION',
]

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535
}

function validatePair(value: PairingPortPair): PairingPortPair {
  if (!validPort(value.port)
    || !validPort(value.bootstrapPort)
    || value.port === value.bootstrapPort) {
    throw new Error('Pairing port configuration failed')
  }
  return Object.freeze({ port: value.port, bootstrapPort: value.bootstrapPort })
}

function parseConfiguration(text: string): PairingPortPair {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Pairing port configuration failed')
  }
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== CONFIGURATION_FIELDS.length
    || !Object.keys(value).every((field, index) => field === CONFIGURATION_FIELDS[index])) {
    throw new Error('Pairing port configuration failed')
  }
  const record = value as Partial<StoredPairingPortConfiguration>
  if (record.version !== 1
    || !validPort(record.port)
    || !validPort(record.bootstrapPort)
    || record.port === record.bootstrapPort
    || JSON.stringify(record) !== text) {
    throw new Error('Pairing port configuration failed')
  }
  return validatePair({ port: record.port, bootstrapPort: record.bootstrapPort })
}

function parseRecovery(text: string): PairingPortPair | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Pairing port recovery failed')
  }
  if (typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== RECOVERY_FIELDS.length
    || !Object.keys(value).every((field, index) => field === RECOVERY_FIELDS[index])) {
    throw new Error('Pairing port recovery failed')
  }
  const record = value as Partial<StoredPairingPortRecovery>
  if (record.version !== 1) throw new Error('Pairing port recovery failed')
  if (record.previous === null) {
    if (text !== '{"version":1,"previous":null}') {
      throw new Error('Pairing port recovery failed')
    }
    return null
  }
  if (typeof record.previous !== 'object' || record.previous === undefined) {
    throw new Error('Pairing port recovery failed')
  }
  const previousText = JSON.stringify(record.previous)
  const previous = parseConfiguration(previousText)
  if (text !== `{"version":1,"previous":${previousText}}`) {
    throw new Error('Pairing port recovery failed')
  }
  return previous
}

function serializeConfiguration(pair: PairingPortPair): string {
  const value = validatePair(pair)
  return JSON.stringify({
    version: 1,
    port: value.port,
    bootstrapPort: value.bootstrapPort,
  } satisfies StoredPairingPortConfiguration)
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(dirname(path), { recursive: true })
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
  } catch {
    throw new Error('Pairing port configuration failed')
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export class FilePairingPortConfigurationStore implements PairingPortConfigurationStore {
  private readonly recoveryPath: string

  constructor(private readonly path: string) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('Pairing port configuration failed')
    }
    this.recoveryPath = join(dirname(path), PAIRING_PORT_RECOVERY_FILE_NAME)
  }

  async read(): Promise<PairingPortPair | null> {
    try {
      return parseConfiguration(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Pairing port configuration failed')
    }
  }

  async write(pair: PairingPortPair): Promise<void> {
    await atomicWrite(this.path, serializeConfiguration(pair))
  }

  async clear(): Promise<void> {
    try {
      await rm(this.path, { force: true })
    } catch {
      throw new Error('Pairing port configuration failed')
    }
  }

  async recoverPending(): Promise<void> {
    let previous: PairingPortPair | null
    try {
      previous = parseRecovery(await readFile(this.recoveryPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('Pairing port recovery failed')
    }
    try {
      if (previous === null) await rm(this.path, { force: true })
      else await atomicWrite(this.path, serializeConfiguration(previous))
      await rm(this.recoveryPath)
    } catch {
      throw new Error('Pairing port recovery failed')
    }
  }

  async beginChange(previous: PairingPortPair | null): Promise<void> {
    const serializedPrevious = previous === null ? 'null' : serializeConfiguration(previous)
    await atomicWrite(
      this.recoveryPath,
      `{"version":1,"previous":${serializedPrevious}}`,
    )
  }

  commitChange(): void {
    try {
      rmSync(this.recoveryPath, { force: true })
    } catch {
      throw new Error('Pairing port recovery failed')
    }
  }
}

export class FilePairingConnectorStatusStore implements PairingConnectorStatusStore {
  constructor(private readonly path: string) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('Pairing connector status failed')
    }
  }

  async read(): Promise<StoredPairingConnectorStatus | null> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('Pairing connector status failed')
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('Pairing connector status failed')
    }
    if (typeof value !== 'object'
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== STATUS_FIELDS.length
      || !Object.keys(value).every((field, index) => field === STATUS_FIELDS[index])) {
      throw new Error('Pairing connector status failed')
    }
    const record = value as Partial<StoredPairingConnectorStatus>
    if (record.version !== 1
      || !CONNECTOR_STATES.includes(record.state as PairingConnectorState)
      || !validPort(record.port)
      || !validPort(record.bootstrapPort)
      || record.port === record.bootstrapPort
      || !FAILURE_STAGES.includes(record.failureStage as PairingConnectorFailureStage)
      || typeof record.repairAvailable !== 'boolean'
      || !Number.isSafeInteger(record.updatedAt)
      || (record.updatedAt as number) <= 0
      || !Number.isSafeInteger(record.processId)
      || (record.processId as number) <= 0
      || JSON.stringify(record) !== text) {
      throw new Error('Pairing connector status failed')
    }
    return record as StoredPairingConnectorStatus
  }

  async write(snapshot: PairingConnectorStatusSnapshot): Promise<void> {
    const pair = validatePair(snapshot)
    if (!CONNECTOR_STATES.includes(snapshot.state)
      || !FAILURE_STAGES.includes(snapshot.failureStage)
      || typeof snapshot.repairAvailable !== 'boolean') {
      throw new Error('Pairing connector status failed')
    }
    await atomicWrite(this.path, JSON.stringify({
      version: 1,
      state: snapshot.state,
      port: pair.port,
      bootstrapPort: pair.bootstrapPort,
      failureStage: snapshot.failureStage,
      repairAvailable: snapshot.repairAvailable,
      updatedAt: Date.now(),
      processId: process.pid,
    } satisfies StoredPairingConnectorStatus))
  }
}

export interface WindowsPairingPortControllerOptions {
  readonly rootDirectory: string
  readonly host?: string
  readonly hosts?: readonly string[]
  readonly automaticHosts?: boolean
  readonly initialPair: PairingPortPair
  readonly allowCreate: boolean
}

export interface WindowsPairingPortControllerDependencies {
  readonly discoverHosts?: typeof readDesktopLanHosts
  readonly runtimeDependencies?: WindowsPairingRuntimeDependencies
  readonly portStore?: PairingPortConfigurationStore
  readonly statusStore?: PairingConnectorStatusStore
  readonly candidatePairs?: readonly PairingPortPair[]
  readonly startRuntime?: (
    options: WindowsPairingRuntimeOptions,
    dependencies: WindowsPairingRuntimeDependencies,
  ) => Promise<WindowsPairingHttpsRuntime>
  readonly startMdnsAdvertisement?: (
    options: StartMdnsAdvertisementOptions,
  ) => Promise<MdnsAdvertisement>
}

type StartOutcome =
  | { readonly kind: 'ready'; readonly runtime: WindowsPairingHttpsRuntime }
  | { readonly kind: 'listener'; readonly error: WindowsPairingListenerStartError }
  | { readonly kind: 'failed'; readonly stage?: PairingConnectorFailureStage }

function uniquePairs(pairs: readonly PairingPortPair[]): readonly PairingPortPair[] {
  const seen = new Set<string>()
  const values: PairingPortPair[] = []
  for (const item of pairs) {
    const pair = validatePair(item)
    const key = `${pair.port}:${pair.bootstrapPort}`
    if (seen.has(key)) continue
    seen.add(key)
    values.push(pair)
  }
  if (values.length === 0) throw new Error('Pairing port configuration failed')
  return Object.freeze(values)
}

function status(
  state: PairingConnectorState,
  pair: PairingPortPair,
  failureStage: PairingConnectorFailureStage,
  repairAvailable: boolean,
): PairingConnectorStatusSnapshot {
  return Object.freeze({
    state,
    port: pair.port,
    bootstrapPort: pair.bootstrapPort,
    failureStage,
    repairAvailable,
  })
}

export class WindowsPairingPortController implements PairingOverlayController, PairingPortControl {
  private startupSequence = 0
  private startupFailure?: { stage: PairingConnectorFailureStage; diagnostic: StartupDiagnostic }
  startupDiagnostic(): StartupDiagnostic | undefined {
    return !this.disposed && this.currentStatus.state === 'FAILED' && this.startupFailure?.stage === this.currentStatus.failureStage
      ? copyStartupDiagnostic(this.startupFailure.diagnostic) : undefined
  }
  readonly invitationStore = new TransientInvitationStore()
  private readonly portStore: PairingPortConfigurationStore
  private readonly statusStore?: PairingConnectorStatusStore
  private readonly candidates: readonly PairingPortPair[]
  private readonly runtimeDependencies: WindowsPairingRuntimeDependencies
  private readonly discoverHosts: typeof readDesktopLanHosts
  private readonly startRuntime: NonNullable<WindowsPairingPortControllerDependencies['startRuntime']>
  private readonly startAdvertisement: NonNullable<
    WindowsPairingPortControllerDependencies['startMdnsAdvertisement']
  >
  private currentPair: PairingPortPair
  private currentStatus: PairingConnectorStatusSnapshot
  private runtime: WindowsPairingHttpsRuntime | undefined
  private advertisement: MdnsAdvertisement | undefined
  private configuredPair: PairingPortPair | null = null
  private repairInFlight: Promise<PairingConnectorStatusSnapshot> | undefined
  private statusWriteQueue = Promise.resolve()
  private readonly accessSwitch: RemoteAccessSwitch
  private accessPaused = false
  private accessChange: Promise<PairingConnectorStatusSnapshot> | undefined
  private disposed = false
  private currentHost: string | undefined
  private currentHosts: readonly string[] | undefined
  private interfaceSnapshot: string | undefined
  private addressChange: Promise<void> | undefined
  private requiredIdentity: { id: string; pin: string } | undefined

  constructor(
    private readonly options: WindowsPairingPortControllerOptions,
    dependencies: WindowsPairingPortControllerDependencies = {},
  ) {
    this.accessSwitch = new RemoteAccessSwitch(options.rootDirectory)
    this.currentHost=options.host
    this.currentHosts=options.hosts
    this.currentPair = validatePair(options.initialPair)
    this.portStore = dependencies.portStore ?? new FilePairingPortConfigurationStore(
      join(options.rootDirectory, PAIRING_PORT_CONFIG_FILE_NAME),
    )
    this.statusStore = dependencies.statusStore
    this.candidates = uniquePairs(dependencies.candidatePairs ?? DEFAULT_PAIRING_PORT_PAIRS)
    this.runtimeDependencies = dependencies.runtimeDependencies ?? {}
    this.discoverHosts = dependencies.discoverHosts ?? readDesktopLanHosts
    this.startRuntime = dependencies.startRuntime ?? startWindowsPairingHttpsRuntime
    this.startAdvertisement = dependencies.startMdnsAdvertisement ?? startMdnsAdvertisement
    this.currentStatus = status('FAILED', this.currentPair, 'UNKNOWN', false)
  }

  async initialize(retryTimeout = true): Promise<PairingConnectorStatusSnapshot> {
    if (!this.startupAllowed()) return this.currentStatus
    if (this.currentHost === undefined) {
      this.publish(status('NO_PRIVATE_ADDRESS', this.currentPair, 'NONE', false))
      return this.currentStatus
    }

    return this.initializeRuntime(retryTimeout)
  }

  private startupAllowed(): boolean {
    if (this.disposed || this.accessPaused) return false
    try {
      if (this.accessSwitch.read()) {
        this.accessPaused = true
        observeConnection(this.runtimeDependencies.observeConnection, 'access', 'paused')
        this.publish(status('PAUSED', this.currentPair, 'NONE', false))
        return false
      }
    } catch {
      this.accessPaused = true
      this.publish(status('FAILED', this.currentPair, 'ACCESS_CONTROL', false))
      return false
    }
    return true
  }

  private async initializeRuntime(retryTimeout: boolean): Promise<PairingConnectorStatusSnapshot> {
    let configured: PairingPortPair | null
    try {
      await this.portStore.recoverPending()
      configured = await this.portStore.read()
    } catch {
      this.publish(status('FAILED', this.currentPair, 'CONFIGURATION', false))
      return this.currentStatus
    }
    this.configuredPair = configured
    this.currentPair = configured ?? this.currentPair
    let initial = await this.tryStart(this.currentPair)
    // Retry only a classified secure-storage timeout after runtime cleanup.
    // Never clear identity, registration or write-failure records to recover.
    if (retryTimeout && initial.kind === 'failed' && initial.stage === 'SECURE_STORAGE_TIMEOUT'
      && !this.disposed && !this.accessPaused) {
      if (!this.startupAllowed()) return this.currentStatus
      this.publish(status('REPAIRING', this.currentPair, 'SECURE_STORAGE_TIMEOUT', false))
      initial = await this.tryStart(this.currentPair)
    }
    if (this.disposed) return this.currentStatus
    if (initial.kind === 'ready') {
      if (configured === null) {
        try {
          if (initial.runtime.runtime.currentBinding() !== undefined) {
            await initial.runtime.stop().catch(() => undefined)
            this.publish(status('FAILED', this.currentPair, 'CONFIGURATION', true))
            return this.currentStatus
          }
        } catch {
          await initial.runtime.stop().catch(() => undefined)
          this.publish(status('FAILED', this.currentPair, 'CONFIGURATION', false))
          return this.currentStatus
        }
      }
      await this.accept(initial.runtime, this.currentPair, configured === null)
      return this.currentStatus
    }
    if (initial.kind === 'failed') {
      this.publish(status('FAILED', this.currentPair, initial.stage ?? 'UNKNOWN', initial.stage === 'SECURE_STORAGE_TIMEOUT' && !this.disposed))
      return this.currentStatus
    }
    if (initial.error.reason === 'address_unavailable') {
      this.publish(status('NO_PRIVATE_ADDRESS', this.currentPair, 'NONE', false))
      return this.currentStatus
    }
    if (initial.error.reason !== 'port_conflict') {
      this.publish(status('FAILED', this.currentPair, 'UNKNOWN', false))
      return this.currentStatus
    }
    if (initial.error.hadActiveTrust) {
      this.publish(status(
        'PORT_CONFLICT',
        this.currentPair,
        initial.error.stage === 'pairing_https' ? 'PAIRING_HTTPS' : 'BOOTSTRAP_HTTP',
        true,
      ))
      return this.currentStatus
    }

    for (const pair of this.candidates) {
      if (pair.port === this.currentPair.port
        && pair.bootstrapPort === this.currentPair.bootstrapPort) continue
      const outcome = await this.tryStart(pair)
      if (outcome.kind === 'ready') {
        await this.accept(outcome.runtime, pair, true)
        return this.currentStatus
      }
      if (outcome.kind === 'listener' && outcome.error.reason === 'address_unavailable') {
        this.publish(status('NO_PRIVATE_ADDRESS', pair, 'NONE', false))
        return this.currentStatus
      }
      if (outcome.kind === 'failed'
        || (outcome.kind === 'listener' && outcome.error.reason !== 'port_conflict')) {
        this.publish(status('FAILED', pair, outcome.kind === 'failed' ? outcome.stage ?? 'UNKNOWN' : 'UNKNOWN', false))
        return this.currentStatus
      }
    }
    this.publish(status('FAILED', this.currentPair, 'NO_AVAILABLE_PAIR', true))
    return this.currentStatus
  }

  connectorStatus(): PairingConnectorStatusSnapshot {
    return this.currentStatus
  }

  repairPorts(): Promise<PairingConnectorStatusSnapshot> {
    if (this.accessPaused || this.accessChange) return Promise.resolve(this.currentStatus)
    if (this.addressChange) return this.addressChange.catch(() => {}).then(() => this.currentStatus)
    if (this.repairInFlight !== undefined) return this.repairInFlight
    if (!this.currentStatus.repairAvailable || this.disposed) {
      return Promise.resolve(this.currentStatus)
    }
    if (this.currentHost === undefined) return Promise.resolve(this.currentStatus)
    const sourceFailureStage = this.currentStatus.failureStage
    this.publish(status('REPAIRING', this.currentPair, sourceFailureStage === 'SECURE_STORAGE_TIMEOUT' ? sourceFailureStage : 'NONE', false))
    this.repairInFlight = this.repair(sourceFailureStage).finally(() => {
      this.repairInFlight = undefined
    })
    return this.repairInFlight
  }

  // Host-only action; this method is not routed through LAN or relay APIs.
  setRemoteAccess(enabled: boolean): Promise<PairingConnectorStatusSnapshot> {
    if (typeof enabled !== 'boolean' || this.disposed) return Promise.reject(Error('remote_access_unavailable'))
    if (this.accessChange) return this.accessChange
    if (this.repairInFlight || this.addressChange) return Promise.reject(Error('remote_access_busy'))
    const work = this.changeRemoteAccess(enabled)
    this.accessChange = work
    void work.then(() => { if (this.accessChange === work) this.accessChange = undefined },
      () => { if (this.accessChange === work) this.accessChange = undefined })
    return work
  }

  private async changeRemoteAccess(enabled: boolean): Promise<PairingConnectorStatusSnapshot> {
    if (!enabled) {
      if (this.accessPaused) return this.currentStatus
      const runtime = this.runtime, binding = runtime?.runtime.currentBinding()
      if (!runtime || !binding) throw Error('remote_access_identity_unavailable')
      const expected: PausedRemoteIdentity = { identityId: runtime.runtime.identity.identityId,
        pin: runtime.runtime.identity.pin.toString('base64url'), ...binding }
      this.accessPaused = true
      let failure: unknown
      observeConnection(this.runtimeDependencies.observeConnection, 'access', 'paused')
      try { this.accessSwitch.pause(expected) } catch (error) { failure = error }
      // Close authorization before waiting for network shutdown.
      try { runtime.runtime.dispose() } catch (error) { failure ??= error }
      this.runtime = undefined
      try { await this.advertisement?.stop() } catch (error) { failure ??= error }
      this.advertisement = undefined
      try { await runtime.stop() } catch (error) { failure ??= error }
      this.publish(status(failure ? 'FAILED' : 'PAUSED', this.currentPair, failure ? 'ACCESS_CONTROL' : 'NONE', false))
      if (failure) throw Error('remote_access_pause_incomplete')
      return this.currentStatus
    }
    if (!this.accessPaused) return this.currentStatus
    const expected = this.accessSwitch.read()
    if (!expected || !this.currentHost) throw Error('remote_access_identity_unavailable')
    // Background discovery must not clear a user pause. The explicit, serialized
    // resume may rediscover addresses while the durable deny remains in place.
    const resumeHosts = this.options.automaticHosts ? await this.discoverHosts() : this.currentHosts
    if (this.disposed) throw Error('remote_access_unavailable')
    if (this.options.automaticHosts && !resumeHosts?.length) throw Error('remote_access_network_unavailable')
    const resumeHost = resumeHosts?.[0] ?? this.currentHost
    const identity = await loadOrCreateWindowsPairingIdentity({ rootDirectory: this.options.rootDirectory,
      host: resumeHost, allowCreate: false, protector: this.runtimeDependencies.protector })
    try {
      const trust = new IdentityBoundFilePairingTrustStore(join(this.options.rootDirectory, PAIRING_TRUST_FILE_NAME), identity.identityId).read()
      if (!trust || trust.status !== 'active' || !samePausedIdentity(expected, { identityId: identity.identityId,
        pin: identity.pin.toString('base64url'), pairingId: trust.pairingId, mobilePublicKeyRaw: trust.mobilePublicKeyRaw }))
        throw Error('remote_access_identity_changed')
    } finally {
      identity.leafKeyPem.fill(0); identity.caDer.fill(0); identity.caPem.fill(0); identity.leafCertPem.fill(0); identity.pin.fill(0)
    }
    if (this.disposed) throw Error('remote_access_unavailable')
    this.currentHost = resumeHost
    this.currentHosts = resumeHosts
    this.interfaceSnapshot = undefined
    this.requiredIdentity = { id: expected.identityId, pin: expected.pin }
    // Only the local owner's explicit resume may clear this marker, after
    // original identity and pairing verification. Restore it if startup fails.
    this.accessSwitch.resume(expected)
    this.accessPaused = false
    try {
      await this.initialize()
      if (this.currentStatus.state !== 'READY' || this.disposed) throw Error('remote_access_resume_failed')
      const binding = this.runtime?.runtime.currentBinding()
      if (!binding || binding.pairingId !== expected.pairingId || binding.mobilePublicKeyRaw !== expected.mobilePublicKeyRaw) {
        throw Error('remote_access_identity_changed')
      }
      return this.currentStatus
    } catch (error) {
      this.accessPaused = true
      const runtime = this.runtime, advertisement = this.advertisement
      this.runtime = undefined; this.advertisement = undefined
      // Restore the durable deny before asynchronous cleanup, including when
      // disposal itself fails. Never report a durable pause if writing failed.
      let pauseFailure = false
      try { this.accessSwitch.pause(expected) } catch { pauseFailure = true }
      try { runtime?.runtime.dispose() } catch { /* Continue closing transports. */ }
      await runtime?.stop().catch(() => undefined)
      await advertisement?.stop().catch(() => undefined)
      this.publish(status(pauseFailure ? 'FAILED' : 'PAUSED', this.currentPair,
        pauseFailure ? 'ACCESS_CONTROL' : 'NONE', false))
      throw error
    }
  }

  currentRuntime(): WindowsPairingHttpsRuntime | undefined {
    return this.runtime
  }
  async refreshLanAddresses(discover=readDesktopLanHosts, snapshot=desktopLanInterfaceSnapshot): Promise<boolean> {
    if(!this.options.automaticHosts||this.disposed||this.accessPaused||this.accessChange||this.addressChange||this.repairInFlight)return false
    const observed=snapshot()
    if(observed===this.interfaceSnapshot&&(this.runtime?.hosts?.length??0)>0)return false
    const original=this.runtime
    let changed=false
    const work=(async()=>{
      const hosts=await discover()
      if(hosts===undefined||this.disposed||this.accessPaused||this.runtime!==original)return
      if(original?.refreshHosts){
        const before=JSON.stringify(original.hosts??[original.host])
        let refreshFailed=false,refreshError:unknown
        try{await original.refreshHosts(hosts)}catch(error){refreshFailed=true;refreshError=error}
        if(this.disposed||this.accessPaused||this.runtime!==original)return
        const listening=original.hosts??[original.host]
        changed=before!==JSON.stringify(listening)
        this.currentHosts=listening;this.currentHost=listening[0]??this.currentHost
        // A successful empty query is distinct from a failed query. Keep the
        // business runtime/identity, reflect the lost LAN capability and retry
        // on the next bounded check even if the OS reports the same addresses.
        this.interfaceSnapshot=undefined
        this.publish(status(listening.length?'READY':hosts.length?'FAILED':'NO_PRIVATE_ADDRESS',
          this.currentPair,listening.length||!hosts.length?'NONE':'UNKNOWN',false))
        if(changed){
          await this.advertisement?.stop();this.advertisement=undefined
          if(this.disposed||this.accessPaused||this.runtime!==original)return
          if(original.hosts?.length){
            try{this.advertisement=await this.startAdvertisement({host:original.host,port:original.port,connectorId:original.runtime.identity.identityId})}
            catch{/* Cloud address publication remains available without mDNS. */}
            if(this.disposed||this.accessPaused||this.runtime!==original){await this.advertisement?.stop();this.advertisement=undefined;return}
          }
        }
        // Only a complete nonempty listening set at an unchanged observation
        // is settled. Counts alone also match stale/different addresses.
        if(!refreshFailed&&hosts.length>0&&listening.length===hosts.length&&
          hosts.every(host=>listening.includes(host))&&snapshot()===observed)this.interfaceSnapshot=observed
        if(refreshFailed)throw refreshError
      }else if(!original&&hosts.length){
        this.currentHost=hosts[0];this.currentHosts=hosts
        await this.initialize(false)
        changed=this.runtime!==undefined
        const listening=this.runtime?.hosts??[]
        if(changed&&listening.length===hosts.length&&hosts.every(host=>listening.includes(host))&&
          snapshot()===observed)this.interfaceSnapshot=observed
      }else if(!original){
        this.publish(status('NO_PRIVATE_ADDRESS',this.currentPair,'NONE',false))
      }
      if(!original){this.currentHosts=this.runtime?.hosts??hosts;this.currentHost=this.currentHosts[0]??this.currentHost}
    })()
    this.addressChange=work
    try{await work;return changed}finally{if(this.addressChange===work)this.addressChange=undefined}
  }
  async repairAddressForPairing(expected: DshEnrollment, discover = readDesktopLanHost,
    isCurrent = (host: string) => currentLanAddressState(host) === 'current'): Promise<void> {
    if (this.accessPaused || this.accessChange) throw Error('enrollment_busy')
    if (this.addressChange) throw Error('enrollment_busy')
    if (this.disposed || this.repairInFlight || this.runtime?.runtime.enrollment?.enrollment !== expected)
      throw Error('enrollment_window_changed')
    const original = this.runtime
    const work = async () => {
      const host = await discover()
      if (!host || host === this.currentHost || !isCurrent(host)) throw Error('enrollment_address_changed')
      if (this.disposed || this.runtime !== original) throw Error('enrollment_window_changed')
      const identity = { id: original.runtime.identity.identityId, pin: original.runtime.identity.pin.toString('base64url') }
      await expected.reserveAddressChange()
      if (this.disposed || this.runtime !== original) throw Error('enrollment_window_changed')
      this.publish(status('REPAIRING', this.currentPair, 'NONE', false))
      try {
        await this.advertisement?.stop(); this.advertisement = undefined
        await original.stop(); this.runtime = undefined
      } catch (error) {
        // An incompletely stopped listener must not compete with a new runtime.
        this.publish(status('FAILED', this.currentPair, 'UNKNOWN', false))
        throw error
      }
      this.currentHost = host
      this.currentHosts = [host]
      this.requiredIdentity = identity
      if (this.disposed) throw Error('enrollment_window_changed')
      const next = await this.tryStart(this.currentPair)
      if (next.kind !== 'ready') {
        this.publish(status('FAILED', this.currentPair, 'CONFIGURATION', !this.disposed))
        throw Error('enrollment_unavailable')
      }
      await this.accept(next.runtime, this.currentPair, false)
    }
    this.addressChange = work()
    try { await this.addressChange } finally { this.addressChange = undefined }
  }

  open(): PairingOverlaySnapshot {
    const controller = this.runtime?.runtime.backend
    if (controller === undefined) throw new Error('Pairing control is unavailable')
    return controller.open()
  }

  snapshot(): PairingOverlaySnapshot | null {
    return this.runtime?.runtime.backend.snapshot() ?? null
  }

  regenerate() {
    const controller = this.runtime?.runtime.backend
    if (controller === undefined) throw new Error('Pairing control is unavailable')
    return controller.regenerate()
  }

  close(): void {
    this.runtime?.runtime.backend.close()
  }

  confirmComputer(
    sessionId: string,
    verificationCode: string,
  ): PairingOverlayComputerConfirmation {
    const controller = this.runtime?.runtime.backend
    if (controller === undefined) throw new Error('Pairing control is unavailable')
    return controller.confirmComputer(sessionId, verificationCode)
  }

  deny(): { readonly ok: boolean } {
    const controller = this.runtime?.runtime.backend
    if (controller === undefined) throw new Error('Pairing control is unavailable')
    return controller.deny()
  }

  rejectAndRegenerate() {
    const controller = this.runtime?.runtime.backend
    if (controller === undefined) throw new Error('Pairing control is unavailable')
    return controller.rejectAndRegenerate()
  }

  revokePairedDevice(): { readonly status: 'REVOKED' } {
    const controller = this.runtime?.runtime.backend
    if (controller === undefined) throw new Error('Pairing control is unavailable')
    return controller.revokePairedDevice()
  }

  dispose(): void {
    this.invitationStore.dispose()
  }

  async stop(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.dispose()
    const pendingRepair = this.repairInFlight
    await pendingRepair?.catch(() => undefined)
    await this.addressChange?.catch(() => undefined)
    await this.accessChange?.catch(() => undefined)
    let firstError: unknown
    try {
      await this.advertisement?.stop()
    } catch (error) {
      firstError = error
    }
    try {
      await this.runtime?.stop()
    } catch (error) {
      firstError ??= error
    }
    this.advertisement = undefined
    this.runtime = undefined
    this.publish(status('FAILED', this.currentPair, 'UNKNOWN', false))
    await this.statusWriteQueue
    if (firstError !== undefined) throw firstError
  }

  private async repair(
    sourceFailureStage: PairingConnectorFailureStage,
  ): Promise<PairingConnectorStatusSnapshot> {
    // Recheck persisted pause/configuration without an automatic retry loop.
    if (sourceFailureStage === 'SECURE_STORAGE_TIMEOUT') return this.initialize(false)
    const pairs = sourceFailureStage === 'CONFIGURATION'
      ? uniquePairs([this.currentPair, ...this.candidates])
      : this.candidates.filter(pair => pair.port !== this.currentPair.port
        || pair.bootstrapPort !== this.currentPair.bootstrapPort)
    for (const pair of pairs) {
      const outcome = await this.tryStart(pair)
      if (outcome.kind === 'ready') {
        await this.accept(outcome.runtime, pair, true)
        return this.currentStatus
      }
      if (outcome.kind === 'listener' && outcome.error.reason === 'address_unavailable') {
        this.publish(status('NO_PRIVATE_ADDRESS', pair, 'NONE', false))
        return this.currentStatus
      }
      if (outcome.kind === 'failed'
        || (outcome.kind === 'listener' && outcome.error.reason !== 'port_conflict')) {
        this.publish(status('FAILED', pair, outcome.kind === 'failed' ? outcome.stage ?? 'UNKNOWN' : 'UNKNOWN', false))
        return this.currentStatus
      }
    }
    this.publish(status('FAILED', this.currentPair, 'NO_AVAILABLE_PAIR', true))
    return this.currentStatus
  }

  private async tryStart(pair: PairingPortPair): Promise<StartOutcome> {
    const sequence = ++this.startupSequence, startup = new StartupObservation()
    this.startupFailure = undefined
    try {
      const runtime = await this.startRuntime({
        rootDirectory: this.options.rootDirectory,
        host: this.currentHost!,
        ...(this.currentHosts?{hosts:this.currentHosts}:{}),
        port: pair.port,
        bootstrapPort: pair.bootstrapPort,
        allowCreate: this.requiredIdentity ? false : this.options.allowCreate,
      }, this.runtimeDependencies)
      if (this.disposed || this.accessPaused) {
        await runtime.stop().catch(() => undefined)
        return { kind: 'failed' }
      }
      if (this.requiredIdentity && (runtime.runtime.identity.identityId !== this.requiredIdentity.id
        || runtime.runtime.identity.pin.toString('base64url') !== this.requiredIdentity.pin)) {
        await runtime.stop().catch(() => undefined)
        return { kind: 'failed' }
      }
      return {
        kind: 'ready',
        runtime,
      }
    } catch (error) {
      const stage = error instanceof PairingStartupError ? error.stage : 'UNKNOWN'
      if (sequence === this.startupSequence && !this.disposed && !this.accessPaused) {
        const detail = error instanceof PairingStartupError || error instanceof WindowsPairingListenerStartError ? error.startup : undefined
        const diagnostic = detail ? copyStartupDiagnostic(detail)
          : startup.fail(error, error instanceof WindowsPairingListenerStartError
            ? error.stage === 'pairing_https' ? 'https_listener' : 'bootstrap_listener' : 'connection_runtime')
        this.startupFailure = { stage, diagnostic }
      }
      if (error instanceof WindowsPairingListenerStartError) {
        return { kind: 'listener', error }
      }
      if (error instanceof PairingStartupError && error.stage === 'SECURE_STORAGE_TIMEOUT') {
        observeConnection(this.runtimeDependencies.observeConnection, 'startup', 'timeout')
      }
      return { kind: 'failed', stage: error instanceof PairingStartupError ? error.stage : 'UNKNOWN' }
    }
  }

  private async accept(
    runtime: WindowsPairingHttpsRuntime,
    pair: PairingPortPair,
    persist: boolean,
  ): Promise<void> {
    const previousConfiguration = this.configuredPair
    let recoveryStarted = false
    let persisted = false
    if (persist) {
      try {
        recoveryStarted = true
        await this.portStore.beginChange(previousConfiguration)
        await this.portStore.write(pair)
        persisted = true
      } catch {
        const recovered = !recoveryStarted || await this.rollbackConfiguration(previousConfiguration)
        await runtime.stop().catch(() => undefined)
        this.publish(status('FAILED', this.currentPair, 'CONFIGURATION', recovered))
        return
      }
    }
    if (this.disposed || this.accessPaused) {
      if (persisted) await this.rollbackConfiguration(previousConfiguration)
      await runtime.stop().catch(() => undefined)
      return
    }
    let advertisement: MdnsAdvertisement | undefined
    try {
      advertisement = await this.startAdvertisement({
        host: runtime.host,
        port: runtime.port,
        connectorId: runtime.runtime.identity.identityId,
      })
    } catch {
      console.warn('[DSHOS Link] 局域网自动发现暂不可用，请检查手机与电脑的网络；仍无法连接时可发送连接反馈。')
    }
    if (this.disposed) {
      await advertisement?.stop().catch(() => undefined)
      if (persisted) await this.rollbackConfiguration(previousConfiguration)
      await runtime.stop().catch(() => undefined)
      return
    }
    if (persisted) {
      try {
        this.portStore.commitChange()
      } catch {
        const recovered = await this.rollbackConfiguration(previousConfiguration)
        await advertisement?.stop().catch(() => undefined)
        await runtime.stop().catch(() => undefined)
        this.publish(status('FAILED', this.currentPair, 'CONFIGURATION', recovered))
        return
      }
      this.configuredPair = pair
    }
    this.currentPair = pair
    this.runtime = runtime
    this.advertisement = advertisement
    observeConnection(this.runtimeDependencies.observeConnection, 'startup', 'ok')
    this.publish(status('READY', pair, 'NONE', false))
  }

  private async rollbackConfiguration(pair: PairingPortPair | null): Promise<boolean> {
    try {
      await this.portStore.recoverPending()
      this.configuredPair = pair
      return true
    } catch {
      return false
    }
  }

  private publish(snapshot: PairingConnectorStatusSnapshot): void {
    // Exhausting candidates changes the public stage, not the last confirmed
    // listener error. Keep its cause without changing retry or binding policy.
    if (snapshot.state === 'FAILED' && snapshot.failureStage === 'NO_AVAILABLE_PAIR'
      && this.startupFailure?.diagnostic.reason === 'port_conflict') this.startupFailure.stage = 'NO_AVAILABLE_PAIR'
    if (snapshot.state !== 'FAILED' || this.startupFailure?.stage !== snapshot.failureStage) this.startupFailure = undefined
    this.currentStatus = snapshot
    if (this.statusStore !== undefined) {
      this.statusWriteQueue = this.statusWriteQueue
        .then(() => this.statusStore!.write(snapshot))
        .catch(() => undefined)
    }
  }
}
