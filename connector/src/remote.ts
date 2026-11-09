import {ENTRY_EVENTS,ENTRY_BLOCK_REASONS,validEntry} from './pairing-entry-observation.js'
import { z } from 'zod/mini'
import {
  DIAGNOSTIC_REMOTE_NAMESPACE,
  DIAGNOSTIC_REPORT_V1_SCHEMA,
} from './diagnostic-contract.js'

export const PAIRING_REMOTE_NAMESPACE = 'dshosPairing'
export const DEFAULT_WORKSPACE_REMOTE_NAMESPACE = 'dshosWorkspace'

const invitationFields = { payload: z.string(), expiresAt: z.number() }
const sessionIdSchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{22}$/))
const invitationSchema = z.union([
  z.readonly(z.strictObject({
    ...invitationFields,
    status: z.literal('INVITATION_ACTIVE'),
    sessionId: z.union([sessionIdSchema, z.null()]),
  })),
  z.readonly(z.strictObject({
    ...invitationFields,
    status: z.union([
      z.literal('WAITING_CONFIRMATION'),
      z.literal('READY_TO_FINALIZE'),
      z.literal('PENDING_COMMIT'),
    ]),
    sessionId: sessionIdSchema,
  })),
])

const computerConfirmationSchema = z.union([
  z.readonly(z.strictObject({ accepted: z.literal(true) })),
  z.readonly(z.strictObject({
    accepted: z.literal(false),
    attemptsRemaining: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })),
])

const pairedSnapshotSchema = z.readonly(z.strictObject({
  status: z.literal('PAIRED'),
  addressPayload: z.optional(z.string().check(
    z.regex(/^DSHOSLINK-ADDRESS-V1\.[A-Za-z0-9_-]{1,105}$/),
  )),
}))
const revokedSnapshotSchema = z.readonly(z.strictObject({ status: z.literal('REVOKED') }))
const overlaySnapshotSchema = z.union([
  invitationSchema,
  pairedSnapshotSchema,
  revokedSnapshotSchema,
])
const snapshotResultSchema = z.union([z.null(), overlaySnapshotSchema])
const connectorStatusSchema = z.readonly(z.strictObject({
  state: z.union([
    z.literal('READY'),
    z.literal('PORT_CONFLICT'),
    z.literal('NO_PRIVATE_ADDRESS'),
    z.literal('DSH_UNAVAILABLE'),
    z.literal('REPAIRING'),
    z.literal('RESTART_REQUIRED'),
    z.literal('FAILED'),
    z.literal('PAUSED'),
  ]),
  port: z.number(),
  bootstrapPort: z.number(),
  failureStage: z.union([
    z.literal('NONE'),
    z.literal('PAIRING_HTTPS'),
    z.literal('BOOTSTRAP_HTTP'),
    z.literal('CONFIGURATION'),
    z.literal('NO_AVAILABLE_PAIR'),
    z.literal('UNKNOWN'),
    z.literal('ACCESS_CONTROL'),
    z.literal('SECURE_STORAGE_TIMEOUT'),
    z.literal('SECURE_STORAGE'),
    z.literal('IDENTITY'),
    z.literal('STORAGE'),
    z.literal('REGISTRATION'),
  ]),
  repairAvailable: z.boolean(),
}))
const connectorStatusResultSchema = z.union([z.null(), connectorStatusSchema])

export const PAIRING_REMOTE_DESCRIPTORS = [
  {
    id: '@dshos-link/connector#dshosPairing/setRemoteAccess', service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE, method: 'setRemoteAccess', invocation: { kind: 'direct' },
    parameters: [{ name: 'enabled', wire: 'enabled', source: 'json', codec: { mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/setRemoteAccess:enabled', schema: z.boolean(), create: () => z.boolean() } }],
    result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosPairing/setRemoteAccess:result',
      schema: connectorStatusSchema, create: () => connectorStatusSchema },
  },
  {
    id: '@dshos-link/connector#dshosPairing/snapshot',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'snapshot',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/snapshot:result',
      schema: snapshotResultSchema,
      create: () => snapshotResultSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/connectorStatus',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'connectorStatus',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/connectorStatus:result',
      schema: connectorStatusResultSchema,
      create: () => connectorStatusResultSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/repairPorts',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'repairPorts',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/repairPorts:result',
      schema: connectorStatusSchema,
      create: () => connectorStatusSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/regenerate',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'regenerate',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/regenerate:result',
      schema: invitationSchema,
      create: () => invitationSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/close',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'close',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/close:result',
      schema: z.undefined(),
      create: () => z.undefined(),
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/confirmComputer',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'confirmComputer',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'sessionId',
      wire: 'sessionId',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@dshos-link/connector#dshosPairing/confirmComputer:sessionId',
        schema: sessionIdSchema,
        create: () => sessionIdSchema,
      },
    }, {
      name: 'verificationCode',
      wire: 'verificationCode',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@dshos-link/connector#dshosPairing/confirmComputer:verificationCode',
        schema: z.string(),
        create: () => z.string(),
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/confirmComputer:result',
      schema: computerConfirmationSchema,
      create: () => computerConfirmationSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/rejectAndRegenerate',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'rejectAndRegenerate',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/rejectAndRegenerate:result',
      schema: invitationSchema,
      create: () => invitationSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosPairing/revokePairedDevice',
    service: PAIRING_REMOTE_NAMESPACE,
    namespace: PAIRING_REMOTE_NAMESPACE,
    method: 'revokePairedDevice',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosPairing/revokePairedDevice:result',
      schema: revokedSnapshotSchema,
      create: () => revokedSnapshotSchema,
    },
  },
] as const

const defaultWorkspaceSnapshotSchema = z.union([
  z.readonly(z.strictObject({ status: z.literal('not_configured') })),
  z.readonly(z.strictObject({ status: z.literal('unavailable') })),
  z.readonly(z.strictObject({ status: z.literal('ready'), title: z.string() })),
])
const workspaceIdSchema = z.string().check(z.regex(/^.{1,256}$/s))

export const DEFAULT_WORKSPACE_REMOTE_DESCRIPTORS = [
  {
    id: '@dshos-link/connector#dshosWorkspace/snapshot',
    service: DEFAULT_WORKSPACE_REMOTE_NAMESPACE,
    namespace: DEFAULT_WORKSPACE_REMOTE_NAMESPACE,
    method: 'snapshot',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosWorkspace/snapshot:result',
      schema: defaultWorkspaceSnapshotSchema,
      create: () => defaultWorkspaceSnapshotSchema,
    },
  },
  {
    id: '@dshos-link/connector#dshosWorkspace/select',
    service: DEFAULT_WORKSPACE_REMOTE_NAMESPACE,
    namespace: DEFAULT_WORKSPACE_REMOTE_NAMESPACE,
    method: 'select',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'workspaceId',
      wire: 'workspaceId',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: '@dshos-link/connector#dshosWorkspace/select:workspaceId',
        schema: workspaceIdSchema,
        create: () => workspaceIdSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosWorkspace/select:result',
      schema: defaultWorkspaceSnapshotSchema,
      create: () => defaultWorkspaceSnapshotSchema,
    },
  },
] as const

export const DIAGNOSTIC_REMOTE_DESCRIPTORS = [
  {
    id: '@dshos-link/connector#dshosDiagnostics/generate',
    service: DIAGNOSTIC_REMOTE_NAMESPACE,
    namespace: DIAGNOSTIC_REMOTE_NAMESPACE,
    method: 'generate',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosDiagnostics/generate:result',
      schema: DIAGNOSTIC_REPORT_V1_SCHEMA,
      create: () => DIAGNOSTIC_REPORT_V1_SCHEMA,
    },
  },
] as const

const enrollmentSnapshot = z.strictObject({ payload: z.string(), sessionId: sessionIdSchema, expiresAt: z.number(),
  remainingMilliseconds: z.optional(z.number().check(z.minimum(0), z.maximum(300000))), computerVerified: z.optional(z.boolean()) })
const enrollmentSnapshotResult = z.union([enrollmentSnapshot, z.null()])
const enrollmentExpectedSession = z.union([sessionIdSchema, z.null()])
const enrollmentLegacyPayload = z.union([z.string().check(z.maxLength(4096)), z.null()])
const enrollmentFlowStatus = z.strictObject({ connectorStatus: connectorStatusResultSchema, legacySnapshot: snapshotResultSchema,
  enrollment: z.union([z.strictObject({ window: enrollmentSnapshotResult, legacyAllowed: z.boolean(), legacyManagement: z.optional(z.boolean()),
    addressRecovery: z.optional(z.enum(['updating', 'required'])) }), z.null()]) })
const enrollmentCode = z.string()
const enrollmentConfirmation = z.strictObject({ confirmed: z.boolean(), remainingAttempts: z.number() })
const enrollmentClosed = z.strictObject({ closed: z.boolean() })
const enrollmentDisplayed = z.strictObject({ recorded: z.boolean() })
const enrollmentRefreshed = z.strictObject({ refreshed: z.boolean() })
export const ENROLLMENT_REMOTE_DESCRIPTORS = [
  {
    id:'@dshos-link/connector#dshosEnrollment/display',service:'dshosEnrollment',namespace:'dshosEnrollment',method:'display',
    invocation:{kind:'direct'},parameters:[
      {name:'sessionId',wire:'sessionId',source:'json',codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosEnrollment/display:sessionId',schema:sessionIdSchema,create:()=>sessionIdSchema}},
      {name:'shown',wire:'shown',source:'json',codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosEnrollment/display:shown',schema:z.boolean(),create:()=>z.boolean()}},
    ],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosEnrollment/display:result',schema:enrollmentDisplayed,create:()=>enrollmentDisplayed},
  },
  {
    id:'@dshos-link/connector#dshosEnrollment/refreshExpired',service:'dshosEnrollment',namespace:'dshosEnrollment',method:'refreshExpired',
    invocation:{kind:'direct'},parameters:[
      {name:'sessionId',wire:'sessionId',source:'json',codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosEnrollment/refreshExpired:sessionId',schema:sessionIdSchema,create:()=>sessionIdSchema}},
    ],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosEnrollment/refreshExpired:result',schema:enrollmentRefreshed,create:()=>enrollmentRefreshed},
  },
  {
    id: '@dshos-link/connector#dshosEnrollment/status', service: 'dshosEnrollment', namespace: 'dshosEnrollment', method: 'status',
    invocation: { kind: 'direct' }, parameters: [],
    result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosEnrollment/status:result',
      schema: enrollmentFlowStatus, create: () => enrollmentFlowStatus },
  },
  {
    id: '@dshos-link/connector#dshosEnrollment/start', service: 'dshosEnrollment', namespace: 'dshosEnrollment', method: 'start',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'expectedSessionId', wire: 'expectedSessionId', source: 'json', codec: { mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosEnrollment/start:expectedSessionId', schema: enrollmentExpectedSession, create: () => enrollmentExpectedSession } },
      { name: 'expectedLegacyPayload', wire: 'expectedLegacyPayload', source: 'json', codec: { mode: 'strict',
        typeSymbol: '@dshos-link/connector#dshosEnrollment/start:expectedLegacyPayload', schema: enrollmentLegacyPayload, create: () => enrollmentLegacyPayload } }],
    result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosEnrollment/start:result',
      schema: enrollmentSnapshot, create: () => enrollmentSnapshot },
  },
  {
    id: '@dshos-link/connector#dshosEnrollment/confirmComputer', service: 'dshosEnrollment', namespace: 'dshosEnrollment', method: 'confirmComputer',
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict',
        typeSymbol: '@dshos-link/connector#dshosEnrollment/confirmComputer:sessionId', schema: sessionIdSchema, create: () => sessionIdSchema } },
      { name: 'verificationCode', wire: 'verificationCode', source: 'json', codec: { mode: 'strict',
        typeSymbol: '@dshos-link/connector#dshosEnrollment/confirmComputer:verificationCode', schema: enrollmentCode, create: () => enrollmentCode } },
    ],
    result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosEnrollment/confirmComputer:result',
      schema: enrollmentConfirmation, create: () => enrollmentConfirmation },
  },
  {
    id: '@dshos-link/connector#dshosEnrollment/close', service: 'dshosEnrollment', namespace: 'dshosEnrollment', method: 'close',
    invocation: { kind: 'direct' }, parameters: [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: { mode: 'strict',
      typeSymbol: '@dshos-link/connector#dshosEnrollment/close:sessionId', schema: sessionIdSchema, create: () => sessionIdSchema } }],
    result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosEnrollment/close:result',
      schema: enrollmentClosed, create: () => enrollmentClosed },
  },
] as const

const connectorUpdateSchema = z.readonly(z.strictObject({
  status: z.enum(['checking', 'available', 'current', 'unavailable']),
  currentVersion: z.string(), latestVersion: z.string(),
}))
const connectorUpgradeStartSchema=z.strictObject({started:z.boolean(),reason:z.string()})
export const CONNECTOR_UPDATE_REMOTE_DESCRIPTORS = [{
  id: '@dshos-link/connector#dshosUpdate/snapshot', service: 'dshosUpdate', namespace: 'dshosUpdate', method: 'snapshot',
  invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosUpdate/snapshot:result',
    schema: connectorUpdateSchema, create: () => connectorUpdateSchema },
}, {
  id: '@dshos-link/connector#dshosUpdate/check', service: 'dshosUpdate', namespace: 'dshosUpdate', method: 'check',
  invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosUpdate/check:result',
    schema: connectorUpdateSchema, create: () => connectorUpdateSchema },
}, {
  id: '@dshos-link/connector#dshosUpdate/upgrade', service:'dshosUpdate', namespace:'dshosUpdate', method:'upgrade',
  invocation:{kind:'direct'},parameters:[],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosUpdate/upgrade:result',
    schema:connectorUpgradeStartSchema,create:()=>connectorUpgradeStartSchema},
}] as const

const pairingDiagnosticsSchema = z.readonly(z.strictObject({
  enabled: z.boolean(), available: z.boolean(), forcedOff: z.boolean(), pendingDisable: z.boolean(),
}))
export const PAIRING_DIAGNOSTICS_REMOTE_DESCRIPTORS = [{
  id: '@dshos-link/connector#dshosPairingDiagnostics/snapshot', service: 'dshosPairingDiagnostics',
  namespace: 'dshosPairingDiagnostics', method: 'snapshot', invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosPairingDiagnostics/snapshot:result',
    schema: pairingDiagnosticsSchema, create: () => pairingDiagnosticsSchema },
}, {
  id: '@dshos-link/connector#dshosPairingDiagnostics/setEnabled', service: 'dshosPairingDiagnostics',
  namespace: 'dshosPairingDiagnostics', method: 'setEnabled', invocation: { kind: 'direct' },
  parameters: [{ name: 'enabled', wire: 'enabled', source: 'json', codec: { mode: 'strict',
    typeSymbol: '@dshos-link/connector#dshosPairingDiagnostics/setEnabled:enabled', schema: z.boolean(), create: () => z.boolean() } }],
  result: { mode: 'strict', typeSymbol: '@dshos-link/connector#dshosPairingDiagnostics/setEnabled:result',
    schema: pairingDiagnosticsSchema, create: () => pairingDiagnosticsSchema },
}] as const

const supportReceiptSchema=z.strictObject({accepted:z.literal(true),feedbackId:z.string(),attemptId:z.string()})
const supportClientRequestId=z.optional(z.string().check(z.regex(/^[a-f0-9]{32}$/)))
const supportClientFailureTime=z.optional(z.number().check(z.int(),z.minimum(0),z.maximum(Number.MAX_SAFE_INTEGER)))
const supportStatusSchema=z.strictObject({retryAfterMs:z.number().check(z.minimum(0),z.maximum(60000)),
  outcome:z.enum(['idle','sending','sent','unconfirmed','expired','limited','preparing']),clientRequestId:supportClientRequestId})
const supportLanSchema=z.strictObject({message:z.string().check(z.maxLength(500)),nextStep:z.string().check(z.maxLength(500))})
export const SUPPORT_REMOTE_DESCRIPTORS=[{
  id:'@dshos-link/connector#dshosSupport/checkLan',service:'dshosSupport',namespace:'dshosSupport',method:'checkLan',
  invocation:{kind:'direct'},parameters:[],
  result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosSupport/checkLan:result',schema:supportLanSchema,create:()=>supportLanSchema},
},{
  id:'@dshos-link/connector#dshosSupport/status',service:'dshosSupport',namespace:'dshosSupport',method:'status',
  invocation:{kind:'direct'},parameters:[],
  result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosSupport/status:result',schema:supportStatusSchema,create:()=>supportStatusSchema},
},{
  id:'@dshos-link/connector#dshosSupport/send',service:'dshosSupport',namespace:'dshosSupport',method:'send',
  invocation:{kind:'direct'},parameters:[
    // DSH checks missing wire fields before schema decoding. Both layers must
    // describe optional inputs; the client omits undefined values from JSON.
    {name:'clientUpdateFailureAtMs',wire:'clientUpdateFailureAtMs',source:'json',acceptsUndefined:true,codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosSupport/send:clientUpdateFailureAtMs',schema:supportClientFailureTime,create:()=>supportClientFailureTime}},
    {name:'clientRequestId',wire:'clientRequestId',source:'json',acceptsUndefined:true,codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosSupport/send:clientRequestId',schema:supportClientRequestId,create:()=>supportClientRequestId}},
  ],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosSupport/send:result',schema:supportReceiptSchema,create:()=>supportReceiptSchema},
}] as const

const cloudViewSchema=z.strictObject({available:z.boolean(),phase:z.enum(['loading','disabled','ready','waiting','completing','paired','connected','ended','problem']),
  message:z.string(),canEnter:z.boolean(),canCancel:z.boolean(),retryAfterMs:z.number().check(z.minimum(0),z.maximum(300000))})
const cloudCodeSchema=z.string().check(z.regex(/^(?=[0-9０-９ -]{8,24}$)(?:[ -]*[0-9０-９]){8}[ -]*$/))
const cloudSuspended=z.strictObject({suspended:z.literal(true)})
const cloudViewIdSchema=z.number().check(z.int(),z.minimum(1),z.maximum(Number.MAX_SAFE_INTEGER))
const cloudViewParameter={name:'viewId',wire:'viewId',source:'json',codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing:viewId',schema:cloudViewIdSchema,create:()=>cloudViewIdSchema}} as const
const entryEventSchema=z.enum(ENTRY_EVENTS)
const entryReceiptSchema=z.strictObject({recorded:z.boolean()})
const entryCycleSchema=z.optional(cloudViewIdSchema)
const inputFactsSchema=z.strictObject({visible:z.boolean(),inputStarted:z.boolean(),inputValid:z.boolean(),submitClicked:z.boolean(),blockedReason:z.enum(ENTRY_BLOCK_REASONS)}).check(z.refine(validEntry))
const claimEntrySchema=z.optional(z.strictObject({cycle:cloudViewIdSchema,observation:inputFactsSchema}))
export const CLOUD_PAIRING_REMOTE_DESCRIPTORS=[
  {id:'@dshos-link/connector#dshosCloudPairing/observeEntry',service:'dshosCloudPairing',namespace:'dshosCloudPairing',method:'observeEntry',
    invocation:{kind:'direct'},parameters:[cloudViewParameter,{name:'event',wire:'event',source:'json',codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/event',schema:entryEventSchema,create:()=>entryEventSchema}},
      {name:'cycle',wire:'cycle',source:'json',acceptsUndefined:true,codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/cycle',schema:entryCycleSchema,create:()=>entryCycleSchema}}],
    result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/observeEntry:result',schema:entryReceiptSchema,create:()=>entryReceiptSchema}},
  {id:'@dshos-link/connector#dshosCloudPairing/openView',service:'dshosCloudPairing',namespace:'dshosCloudPairing',method:'openView',
    invocation:{kind:'direct'},parameters:[],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/openView:result',schema:cloudViewIdSchema,create:()=>cloudViewIdSchema}},
  {id:'@dshos-link/connector#dshosCloudPairing/status',service:'dshosCloudPairing',namespace:'dshosCloudPairing',method:'status',
    invocation:{kind:'direct'},parameters:[cloudViewParameter],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/status:result',schema:cloudViewSchema,create:()=>cloudViewSchema}},
  {id:'@dshos-link/connector#dshosCloudPairing/claim',service:'dshosCloudPairing',namespace:'dshosCloudPairing',method:'claim',
    invocation:{kind:'direct'},parameters:[cloudViewParameter,{name:'code',wire:'code',source:'json',codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/claim:code',schema:cloudCodeSchema,create:()=>cloudCodeSchema}},
      {name:'entry',wire:'entry',source:'json',acceptsUndefined:true,codec:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/claim:entry',schema:claimEntrySchema,create:()=>claimEntrySchema}}],
    result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/claim:result',schema:cloudViewSchema,create:()=>cloudViewSchema}},
  {id:'@dshos-link/connector#dshosCloudPairing/cancel',service:'dshosCloudPairing',namespace:'dshosCloudPairing',method:'cancel',
    invocation:{kind:'direct'},parameters:[cloudViewParameter],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/cancel:result',schema:cloudViewSchema,create:()=>cloudViewSchema}},
  {id:'@dshos-link/connector#dshosCloudPairing/suspend',service:'dshosCloudPairing',namespace:'dshosCloudPairing',method:'suspend',
    invocation:{kind:'direct'},parameters:[cloudViewParameter],result:{mode:'strict',typeSymbol:'@dshos-link/connector#dshosCloudPairing/suspend:result',schema:cloudSuspended,create:()=>cloudSuspended}},
] as const

const serviceAccessViewSchema=z.strictObject({message:z.string(),restricted:z.boolean(),needsCheck:z.boolean(),checking:z.boolean(),
  retryAfterMs:z.number().check(z.minimum(0),z.maximum(10000))})
export const SERVICE_ACCESS_REMOTE_DESCRIPTORS=['status','refresh'].map(method=>({
  id:`@dshos-link/connector#dshosServiceAccess/${method}`,service:'dshosServiceAccess',namespace:'dshosServiceAccess',method,
  invocation:{kind:'direct' as const},parameters:[],result:{mode:'strict' as const,typeSymbol:`@dshos-link/connector#dshosServiceAccess/${method}:result`,
    schema:serviceAccessViewSchema,create:()=>serviceAccessViewSchema}} as const))
export const REMOTE_DESCRIPTORS = [
  ...PAIRING_REMOTE_DESCRIPTORS,
  ...DEFAULT_WORKSPACE_REMOTE_DESCRIPTORS,
  ...ENROLLMENT_REMOTE_DESCRIPTORS,
  ...CONNECTOR_UPDATE_REMOTE_DESCRIPTORS,
  ...PAIRING_DIAGNOSTICS_REMOTE_DESCRIPTORS,
  ...SUPPORT_REMOTE_DESCRIPTORS,
  ...CLOUD_PAIRING_REMOTE_DESCRIPTORS,
  ...SERVICE_ACCESS_REMOTE_DESCRIPTORS,
] as const

export const TYPERT_REMOTE = {
  package: '@dshos-link/connector',
  descriptors: REMOTE_DESCRIPTORS,
}

export default TYPERT_REMOTE
