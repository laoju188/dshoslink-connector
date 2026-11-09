import { randomUUID } from 'node:crypto'
import { release as windowsRelease } from 'node:os'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  DIAGNOSTIC_ERROR_CATALOG,
  DIAGNOSTIC_REMOTE_NAMESPACE,
  WINDOWS_RELEASE_PATTERN,
  type DiagnosticErrorCode,
  type DiagnosticReportV1,
  validateDiagnosticReport,
} from './diagnostic-contract.js'
import { CONNECTOR_VERSION, SUPPORTED_DSH_VERSION } from './connector-metadata.js'
import type { PairingConnectorStatusSnapshot } from './pairing-port-control.js'
import { normalizeRuntimeDshVersion, readRuntimeDshVersion } from './runtime-version.js'

export interface DiagnosticReportSourceSnapshot {
  readonly connectorStatus: PairingConnectorStatusSnapshot
  readonly paired: boolean
}

export type DiagnosticReportSource = () => DiagnosticReportSourceSnapshot

function normalizeWindowsVersion(value: string): string {
  return WINDOWS_RELEASE_PATTERN.test(value) ? value : 'UNAVAILABLE'
}

export function diagnosticErrorCodeFor(
  snapshot: DiagnosticReportSourceSnapshot,
): DiagnosticErrorCode {
  const status = snapshot.connectorStatus
  if (status.state === 'PAUSED') return 'OK'
  if (status.state === 'READY') return snapshot.paired ? 'OK' : 'PAIRING_NOT_CONFIGURED'
  if (status.state === 'PORT_CONFLICT') {
    return status.failureStage === 'BOOTSTRAP_HTTP'
      ? 'PORT_BOOTSTRAP_HTTP_CONFLICT'
      : 'PORT_PAIRING_HTTPS_CONFLICT'
  }
  if (status.state === 'NO_PRIVATE_ADDRESS') return 'LAN_PRIVATE_ADDRESS_UNAVAILABLE'
  if (status.state === 'DSH_UNAVAILABLE') return 'START_DSH_UNAVAILABLE'
  if (status.state === 'REPAIRING') return 'PORT_REPAIR_IN_PROGRESS'
  if (status.state === 'RESTART_REQUIRED') return 'START_RESTART_REQUIRED'
  if (status.failureStage === 'CONFIGURATION') return 'PORT_CONFIGURATION_FAILED'
  if (status.failureStage === 'NO_AVAILABLE_PAIR') return 'PORT_NO_AVAILABLE_PAIR'
  return 'START_CONNECTOR_FAILED'
}

export function createDiagnosticReport(
  snapshot: DiagnosticReportSourceSnapshot,
  options: {
    readonly reportId?: string
    readonly generatedAtMs?: number
    readonly windowsVersion?: string
    readonly runtimeDsh?: string
  } = {},
): DiagnosticReportV1 {
  const errorCode = diagnosticErrorCodeFor(snapshot)
  const definition = DIAGNOSTIC_ERROR_CATALOG[errorCode]
  return validateDiagnosticReport({
    schemaVersion: 1,
    reportId: options.reportId ?? randomUUID(),
    generatedAtMs: options.generatedAtMs ?? Date.now(),
    versions: {
      connector: CONNECTOR_VERSION,
      supportedDsh: SUPPORTED_DSH_VERSION,
      windows: normalizeWindowsVersion(options.windowsVersion ?? windowsRelease()),
      runtimeDsh: options.runtimeDsh === 'UNSUPPORTED' ? 'UNSUPPORTED' : normalizeRuntimeDshVersion(options.runtimeDsh),
      protocols: { pairing: 1, sessionStream: 1, relayTransport: 1 },
    },
    status: {
      errorCode,
      errorStage: definition.stage,
      retryable: definition.retryable,
      connectorState: snapshot.connectorStatus.state,
      connectorFailureStage: snapshot.connectorStatus.failureStage,
      pairingPort: snapshot.connectorStatus.port,
      bootstrapPort: snapshot.connectorStatus.bootstrapPort,
      paired: snapshot.paired,
    },
  })
}

export class DiagnosticReportService extends Service {
  readonly typertRemote: {
    readonly service: DiagnosticReportService
    readonly serviceKey: typeof DIAGNOSTIC_REMOTE_NAMESPACE
    readonly namespace: typeof DIAGNOSTIC_REMOTE_NAMESPACE
  }

  constructor(ctx: Context, private readonly source: DiagnosticReportSource) {
    super(ctx, DIAGNOSTIC_REMOTE_NAMESPACE)
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: DIAGNOSTIC_REMOTE_NAMESPACE,
      namespace: DIAGNOSTIC_REMOTE_NAMESPACE,
    })
  }

  generate(): DiagnosticReportV1 {
    return createDiagnosticReport(this.source(), { runtimeDsh: readRuntimeDshVersion() })
  }
}
