import { z } from 'zod/mini'
import { LATEST_SUPPORTED_DSH_VERSION } from './connector-metadata.js'

export const DIAGNOSTIC_REMOTE_NAMESPACE = 'dshosDiagnostics'
export const DIAGNOSTIC_REPORT_SCHEMA_VERSION = 1 as const
export const DIAGNOSTIC_REPORT_MAX_BYTES = 4_096

export type DiagnosticStage =
  | 'NONE'
  | 'INSTALLATION'
  | 'STARTUP'
  | 'PORT'
  | 'PAIRING'
  | 'TLS'
  | 'AUTH'
  | 'LAN'
  | 'RELAY'
  | 'DSH_VERSION'

export type DiagnosticErrorCode =
  | 'OK'
  | 'INSTALL_CONNECTOR_MISSING'
  | 'INSTALL_PACKAGE_INVALID'
  | 'START_DSH_UNAVAILABLE'
  | 'START_CONNECTOR_FAILED'
  | 'START_RESTART_REQUIRED'
  | 'PORT_PAIRING_HTTPS_CONFLICT'
  | 'PORT_BOOTSTRAP_HTTP_CONFLICT'
  | 'PORT_CONFIGURATION_FAILED'
  | 'PORT_NO_AVAILABLE_PAIR'
  | 'PORT_REPAIR_IN_PROGRESS'
  | 'PAIRING_NOT_CONFIGURED'
  | 'PAIRING_INVITATION_UNAVAILABLE'
  | 'TLS_CERTIFICATE_UNAVAILABLE'
  | 'TLS_HANDSHAKE_FAILED'
  | 'AUTH_BINDING_MISSING'
  | 'AUTH_DEVICE_REVOKED'
  | 'LAN_PRIVATE_ADDRESS_UNAVAILABLE'
  | 'LAN_CONNECTION_FAILED'
  | 'RELAY_SUBSCRIPTION_REQUIRED'
  | 'RELAY_CONNECT_FAILED'
  | 'RELAY_AUTH_FAILED'
  | 'DSH_VERSION_UNSUPPORTED'

export interface DiagnosticErrorDefinition {
  readonly stage: DiagnosticStage
  readonly retryable: boolean
}

export const DIAGNOSTIC_ERROR_CATALOG = Object.freeze({
  OK: { stage: 'NONE', retryable: false },
  INSTALL_CONNECTOR_MISSING: { stage: 'INSTALLATION', retryable: false },
  INSTALL_PACKAGE_INVALID: { stage: 'INSTALLATION', retryable: false },
  START_DSH_UNAVAILABLE: { stage: 'STARTUP', retryable: true },
  START_CONNECTOR_FAILED: { stage: 'STARTUP', retryable: true },
  START_RESTART_REQUIRED: { stage: 'STARTUP', retryable: true },
  PORT_PAIRING_HTTPS_CONFLICT: { stage: 'PORT', retryable: true },
  PORT_BOOTSTRAP_HTTP_CONFLICT: { stage: 'PORT', retryable: true },
  PORT_CONFIGURATION_FAILED: { stage: 'PORT', retryable: true },
  PORT_NO_AVAILABLE_PAIR: { stage: 'PORT', retryable: true },
  PORT_REPAIR_IN_PROGRESS: { stage: 'PORT', retryable: true },
  PAIRING_NOT_CONFIGURED: { stage: 'PAIRING', retryable: true },
  PAIRING_INVITATION_UNAVAILABLE: { stage: 'PAIRING', retryable: true },
  TLS_CERTIFICATE_UNAVAILABLE: { stage: 'TLS', retryable: true },
  TLS_HANDSHAKE_FAILED: { stage: 'TLS', retryable: true },
  AUTH_BINDING_MISSING: { stage: 'AUTH', retryable: true },
  AUTH_DEVICE_REVOKED: { stage: 'AUTH', retryable: false },
  LAN_PRIVATE_ADDRESS_UNAVAILABLE: { stage: 'LAN', retryable: true },
  LAN_CONNECTION_FAILED: { stage: 'LAN', retryable: true },
  RELAY_SUBSCRIPTION_REQUIRED: { stage: 'RELAY', retryable: false },
  RELAY_CONNECT_FAILED: { stage: 'RELAY', retryable: true },
  RELAY_AUTH_FAILED: { stage: 'RELAY', retryable: true },
  DSH_VERSION_UNSUPPORTED: { stage: 'DSH_VERSION', retryable: false },
} as const satisfies Readonly<Record<DiagnosticErrorCode, DiagnosticErrorDefinition>>)

for (const definition of Object.values(DIAGNOSTIC_ERROR_CATALOG)) {
  Object.freeze(definition)
}

export type DiagnosticConnectorState =
  | 'PAUSED' | 'READY'
  | 'PORT_CONFLICT'
  | 'NO_PRIVATE_ADDRESS'
  | 'DSH_UNAVAILABLE'
  | 'REPAIRING'
  | 'RESTART_REQUIRED'
  | 'FAILED'

export type DiagnosticFailureStage =
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

export interface DiagnosticReportV1 {
  readonly schemaVersion: 1
  readonly reportId: string
  readonly generatedAtMs: number
  readonly versions: {
    readonly connector: string
    readonly supportedDsh: string
    readonly windows: string
    readonly runtimeDsh?: string
    readonly protocols?: { readonly pairing: 1; readonly sessionStream: 1; readonly relayTransport: 1 }
  }
  readonly status: {
    readonly errorCode: DiagnosticErrorCode
    readonly errorStage: DiagnosticStage
    readonly retryable: boolean
    readonly connectorState: DiagnosticConnectorState
    readonly connectorFailureStage: DiagnosticFailureStage
    readonly pairingPort: number
    readonly bootstrapPort: number
    readonly paired: boolean
  }
}

const diagnosticStageSchema = z.union([
  z.literal('NONE'), z.literal('INSTALLATION'), z.literal('STARTUP'),
  z.literal('PORT'), z.literal('PAIRING'), z.literal('TLS'), z.literal('AUTH'),
  z.literal('LAN'), z.literal('RELAY'), z.literal('DSH_VERSION'),
])

const diagnosticErrorCodeSchema = z.union([
  z.literal('OK'),
  z.literal('INSTALL_CONNECTOR_MISSING'), z.literal('INSTALL_PACKAGE_INVALID'),
  z.literal('START_DSH_UNAVAILABLE'), z.literal('START_CONNECTOR_FAILED'),
  z.literal('START_RESTART_REQUIRED'),
  z.literal('PORT_PAIRING_HTTPS_CONFLICT'), z.literal('PORT_BOOTSTRAP_HTTP_CONFLICT'),
  z.literal('PORT_CONFIGURATION_FAILED'), z.literal('PORT_NO_AVAILABLE_PAIR'),
  z.literal('PORT_REPAIR_IN_PROGRESS'),
  z.literal('PAIRING_NOT_CONFIGURED'), z.literal('PAIRING_INVITATION_UNAVAILABLE'),
  z.literal('TLS_CERTIFICATE_UNAVAILABLE'), z.literal('TLS_HANDSHAKE_FAILED'),
  z.literal('AUTH_BINDING_MISSING'), z.literal('AUTH_DEVICE_REVOKED'),
  z.literal('LAN_PRIVATE_ADDRESS_UNAVAILABLE'), z.literal('LAN_CONNECTION_FAILED'),
  z.literal('RELAY_SUBSCRIPTION_REQUIRED'), z.literal('RELAY_CONNECT_FAILED'),
  z.literal('RELAY_AUTH_FAILED'), z.literal('DSH_VERSION_UNSUPPORTED'),
])

const connectorStateSchema = z.union([z.literal('PAUSED'),
  z.literal('READY'), z.literal('PORT_CONFLICT'), z.literal('NO_PRIVATE_ADDRESS'),
  z.literal('DSH_UNAVAILABLE'), z.literal('REPAIRING'),
  z.literal('RESTART_REQUIRED'), z.literal('FAILED'),
])

const connectorFailureStageSchema = z.union([z.literal('ACCESS_CONTROL'),
  z.literal('NONE'), z.literal('PAIRING_HTTPS'), z.literal('BOOTSTRAP_HTTP'),
  z.literal('CONFIGURATION'), z.literal('NO_AVAILABLE_PAIR'), z.literal('UNKNOWN'),
  z.literal('SECURE_STORAGE_TIMEOUT'), z.literal('SECURE_STORAGE'), z.literal('IDENTITY'), z.literal('STORAGE'), z.literal('REGISTRATION'),
])

// Version metadata is bounded data, not the phone compatibility contract.
export const DIAGNOSTIC_VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-(?:alpha|beta|rc|dev|next)\.(?:0|[1-9]\d{0,5}))?$/
const diagnosticVersionSchema = z.string().check(z.regex(DIAGNOSTIC_VERSION_PATTERN))

export const WINDOWS_RELEASE_PATTERN = /^10\.0\.\d{4,6}$/
const windowsVersionSchema = z.union([
  z.string().check(z.regex(WINDOWS_RELEASE_PATTERN)),
  z.literal('UNAVAILABLE'),
])
const portSchema = z.number().check(z.int(), z.gte(1), z.lte(65_535))
const generatedAtSchema = z.number().check(z.int(), z.gte(0), z.lte(Number.MAX_SAFE_INTEGER))

export const DIAGNOSTIC_REPORT_V1_SCHEMA = z.readonly(z.strictObject({
  schemaVersion: z.literal(DIAGNOSTIC_REPORT_SCHEMA_VERSION),
  reportId: z.string().check(z.regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )),
  generatedAtMs: generatedAtSchema,
  versions: z.readonly(z.strictObject({
    connector: diagnosticVersionSchema,
    supportedDsh: diagnosticVersionSchema,
    windows: windowsVersionSchema,
    runtimeDsh: z.optional(z.union([
      diagnosticVersionSchema,
      z.literal('UNSUPPORTED'), z.literal('UNAVAILABLE'),
    ])),
    protocols: z.optional(z.readonly(z.strictObject({
      pairing: z.literal(1), sessionStream: z.literal(1), relayTransport: z.literal(1),
    }))),
  })),
  status: z.readonly(z.strictObject({
    errorCode: diagnosticErrorCodeSchema,
    errorStage: diagnosticStageSchema,
    retryable: z.boolean(),
    connectorState: connectorStateSchema,
    connectorFailureStage: connectorFailureStageSchema,
    pairingPort: portSchema,
    bootstrapPort: portSchema,
    paired: z.boolean(),
  })),
}))

function invalidDiagnosticReport(): never {
  throw new Error('Invalid diagnostic report')
}

export function validateDiagnosticReport(value: unknown): DiagnosticReportV1 {
  let report: DiagnosticReportV1
  try {
    report = DIAGNOSTIC_REPORT_V1_SCHEMA.parse(value) as DiagnosticReportV1
  } catch {
    return invalidDiagnosticReport()
  }
  const definition = DIAGNOSTIC_ERROR_CATALOG[report.status.errorCode]
  if (definition.stage !== report.status.errorStage
    || definition.retryable !== report.status.retryable
    || report.status.pairingPort === report.status.bootstrapPort
    || new TextEncoder().encode(JSON.stringify(report)).byteLength > DIAGNOSTIC_REPORT_MAX_BYTES) {
    return invalidDiagnosticReport()
  }
  return report
}

export function serializeDiagnosticReport(value: unknown): string {
  const serialized = JSON.stringify(validateDiagnosticReport(value), null, 2)
  if (new TextEncoder().encode(serialized).byteLength > DIAGNOSTIC_REPORT_MAX_BYTES) {
    return invalidDiagnosticReport()
  }
  return serialized
}

export function formatDiagnosticSummary(value: unknown): string {
  const report = validateDiagnosticReport(value)
  return [
    'DSHOS Link 脱敏诊断',
    `报告编号：${report.reportId}`,
    `生成时间：${report.generatedAtMs}`,
    `连接器版本：${report.versions.connector}`,
    `最新支持的 DSH：${LATEST_SUPPORTED_DSH_VERSION}`,
    `实际 DSH：${report.versions.runtimeDsh ?? 'UNAVAILABLE'}`,
    `协议版本（配对/会话流/中继传输）：${report.versions.protocols === undefined ? 'UNAVAILABLE' : '1/1/1'}`,
    `Windows 版本：${report.versions.windows}`,
    `错误码：${report.status.errorCode}`,
    `错误阶段：${report.status.errorStage}`,
    `连接器状态：${report.status.connectorState}`,
    `监听端口：${report.status.pairingPort}/${report.status.bootstrapPort}`,
    `已配对：${report.status.paired ? '是' : '否'}`,
    `可重试：${report.status.retryable ? '是' : '否'}`,
    `建议：${diagnosticRecoveryHint(report)}`,
  ].join('\n')
}

function diagnosticRecoveryHint(report: DiagnosticReportV1): string {
  if (report.versions.runtimeDsh === 'UNSUPPORTED' || report.status.errorCode === 'DSH_VERSION_UNSUPPORTED') {
    return `请核对 DSH 版本，最新支持的版本为 ${LATEST_SUPPORTED_DSH_VERSION}。`
  }
  switch (report.status.errorCode) {
    case 'OK': return '电脑端连接器可用；手机连接失败时请检查是否处于同一局域网。'
    case 'START_DSH_UNAVAILABLE': return '请确认原 DSH 正在运行，待其启动完成后重试。'
    case 'START_RESTART_REQUIRED': return '请在当前任务结束后重新启动原 DSH。'
    case 'INSTALL_CONNECTOR_MISSING': return '请在原 DSH 环境安装连接器。'
    case 'START_CONNECTOR_FAILED': return '请在原 DSH 的设置 → 插件中检查 DSHOS Link 状态。'
    case 'AUTH_DEVICE_REVOKED': return '电脑已撤销手机信任，请在电脑重新配对。'
    case 'PAIRING_NOT_CONFIGURED': return '请在电脑插件页生成配对二维码，再用手机扫描。'
    case 'LAN_PRIVATE_ADDRESS_UNAVAILABLE': return '请检查电脑局域网连接和网卡地址。'
    case 'PORT_PAIRING_HTTPS_CONFLICT':
    case 'PORT_BOOTSTRAP_HTTP_CONFLICT': return '请在插件页修复手机连接端口；保留原 DSH 网页端口。'
    default: return '请保留此诊断，在原 DSH 插件页按当前状态重试；不要新建另一套 DSH。'
  }
}
