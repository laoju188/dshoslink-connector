import { DSH_QUEUE_PATH, DSH_QUEUE_PREFIX } from './dsh-message-queue-contract.js'
import { createDesktopSessionsHandler, DESKTOP_HOST_PATH, DESKTOP_SESSIONS_PATH, DESKTOP_SESSION_ACTION_PATH, DESKTOP_WORKSPACE_ACTION_PATH,
  type DesktopSessionsSource, type DesktopForkJournal } from './desktop-sessions.js'
import { DshMessageQueueHttp } from './dsh-message-queue-http.js'
import type { DshMessageQueueRuntime } from './dsh-message-queue-runtime.js'
import { isDiagnosticReadBody, createDiagnosticReadHandler, type DiagnosticReadSource } from './diagnostic-http.js'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import { SessionImageService, type SessionImageSource } from './session-image.js'
import { SESSION_IMAGE_PATH } from './session-image-contract.js'
import { SESSION_IMAGE_MESSAGE_PATH, SessionImageMessageService } from './session-image-message.js'
import {
  createSessionControlRequestHandler,
  SESSION_CANCEL_PATH,
  SESSION_STATE_PATH,
  type SessionControlSource,
} from './session-control.js'
import {
  createSessionApprovalDecisionRequestHandler,
  createSessionApprovalListRequestHandler,
  SESSION_APPROVAL_DECISION_PATH,
  SESSION_APPROVAL_LIST_PATH,
  type SessionApprovalSource,
} from './session-approval.js'
import {
  createSessionQuestionListRequestHandler,
  createSessionQuestionResponseRequestHandler,
  SESSION_QUESTION_LIST_PATH,
  SESSION_QUESTION_RESPONSE_PATH,
  type SessionQuestionSource,
} from './session-question.js'
import {
  createSessionCreateRequestHandler,
  SESSION_CREATE_PATH,
  type SessionCreateSource,
  type SessionCreateWorkspaceSource,
} from './session-create.js'
import {
  createSessionDetailRequestHandler,
  SESSION_DETAIL_PATH,
  type SessionDetailSource,
} from './session-detail.js'
import {
  SESSION_FILE_ABORT_PATH,
  SESSION_FILE_CHUNK_PATH,
  SESSION_FILE_FINISH_PATH,
  SESSION_FILE_START_PATH,
  SessionFileUploadService,
  type SessionFileSource,
} from './session-file.js'
import {
  createSessionListRequestHandler,
  SESSION_LIST_PATH,
  type SessionListAuthorizer,
  type SessionListSource,
} from './session-list.js'
import {
  createSessionMessageRequestHandler,
  SESSION_MESSAGE_PATH,
  type SessionMessageSource,
} from './session-message.js'
import {
  createSessionModelRequestHandler,
  SESSION_MODELS_PATH,
  SESSION_MODEL_SELECT_PATH,
  type SessionModelSource,
} from './session-model.js'
import {
  createSessionUsageRequestHandler,
  SESSION_USAGE_PATH,
  type SessionUsageSource,
} from './session-usage.js'
import {
  createSessionStreamRequestHandler,
  SESSION_STREAM_PATH,
  type SessionStreamSource,
} from './session-stream.js'
import {
  createCriticalNotificationRequestHandler,
  CRITICAL_NOTIFICATION_PATH,
  type CriticalNotificationSource,
} from './critical-notification.js'

const SESSION_PATHS = new Set([
  DESKTOP_HOST_PATH, DESKTOP_SESSIONS_PATH, DESKTOP_SESSION_ACTION_PATH, DESKTOP_WORKSPACE_ACTION_PATH,
  DSH_QUEUE_PATH,
  SESSION_LIST_PATH,
  SESSION_DETAIL_PATH,
  SESSION_MESSAGE_PATH,
  SESSION_IMAGE_PATH,
  SESSION_IMAGE_MESSAGE_PATH,
  SESSION_STATE_PATH,
  SESSION_CANCEL_PATH,
  SESSION_APPROVAL_LIST_PATH,
  SESSION_APPROVAL_DECISION_PATH,
  SESSION_QUESTION_LIST_PATH,
  SESSION_QUESTION_RESPONSE_PATH,
  SESSION_CREATE_PATH,
  SESSION_MODELS_PATH,
  SESSION_MODEL_SELECT_PATH,
  SESSION_USAGE_PATH,
  SESSION_STREAM_PATH,
  CRITICAL_NOTIFICATION_PATH,
  SESSION_FILE_START_PATH,
  SESSION_FILE_CHUNK_PATH,
  SESSION_FILE_FINISH_PATH,
  SESSION_FILE_ABORT_PATH,
])

// Successful content access, not balance polling, AUTH, heartbeats or diagnostics.
const USE_PATHS = new Set([DESKTOP_SESSIONS_PATH, DESKTOP_SESSION_ACTION_PATH, DESKTOP_WORKSPACE_ACTION_PATH,
  SESSION_LIST_PATH, SESSION_DETAIL_PATH, SESSION_CREATE_PATH, SESSION_MESSAGE_PATH, SESSION_IMAGE_MESSAGE_PATH,
  SESSION_APPROVAL_DECISION_PATH, SESSION_QUESTION_RESPONSE_PATH, SESSION_MODEL_SELECT_PATH, SESSION_FILE_FINISH_PATH])
function isUsageRequest(request:PairingV1HttpRequest):boolean {
  if(USE_PATHS.has(request.path.split(/[?#]/,1)[0]!))return true
  if(request.path!==DSH_QUEUE_PATH||request.method!=='POST'||request.body.byteLength>32768)return false
  try{
    const contract=(JSON.parse(Buffer.from(request.body).toString('utf8')) as {contract?:unknown}).contract
    // Queue snapshots, capabilities, resolution and prepare are background or
    // preparatory work. A successful commit/content response is business access.
    return contract===DSH_QUEUE_PREFIX+'commit-v2'||contract===DSH_QUEUE_PREFIX+'content-v1'
  }catch{return false}
}
export interface SessionRequestRouterDependencies {
  readonly observeBusinessRequest?: () => (() => void) | undefined
  readonly desktopSessionsSource?: DesktopSessionsSource
  readonly desktopForkJournal?: DesktopForkJournal
  readonly messageQueueRuntime?: DshMessageQueueRuntime
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
  readonly sessionCreateSource?: SessionCreateSource
  readonly sessionCreateWorkspaceSource?: SessionCreateWorkspaceSource
}

export function isSessionRequestPath(path: string): boolean {
  return SESSION_PATHS.has(path)
}

export class SessionRequestRouter {
  private readonly desktopSessionsHandler
  private readonly messageQueue?: DshMessageQueueHttp
  private readonly diagnosticHandler
  private readonly sessionListHandler
  private readonly sessionDetailHandler
  private readonly sessionImageService: SessionImageService
  private readonly sessionImageMessageService: SessionImageMessageService
  private readonly sessionMessageHandler
  private readonly sessionControlHandler
  private readonly sessionApprovalListHandler
  private readonly sessionApprovalDecisionHandler
  private readonly sessionQuestionListHandler
  private readonly sessionQuestionResponseHandler
  private readonly sessionCreateHandler
  private readonly sessionModelHandler
  private readonly sessionUsageHandler
  private readonly sessionStreamHandler
  private readonly criticalNotificationHandler
  private readonly sessionFileService: SessionFileUploadService

  constructor(private readonly authorizer: SessionListAuthorizer, private readonly dependencies: SessionRequestRouterDependencies = {}) {
    this.desktopSessionsHandler = createDesktopSessionsHandler(authorizer, dependencies.desktopSessionsSource, dependencies.desktopForkJournal)
    if (dependencies.messageQueueRuntime) this.messageQueue = new DshMessageQueueHttp(authorizer, dependencies.messageQueueRuntime)
    this.diagnosticHandler = createDiagnosticReadHandler(authorizer, dependencies.diagnosticSource)
    this.sessionListHandler = createSessionListRequestHandler(authorizer, dependencies.sessionListSource)
    this.sessionDetailHandler = createSessionDetailRequestHandler(authorizer, dependencies.sessionDetailSource)
    this.sessionImageService = new SessionImageService(authorizer, dependencies.sessionImageSource)
    this.sessionImageMessageService = new SessionImageMessageService(authorizer, dependencies.sessionMessageSource)
    this.sessionMessageHandler = createSessionMessageRequestHandler(authorizer, dependencies.sessionMessageSource)
    this.sessionControlHandler = createSessionControlRequestHandler(authorizer, dependencies.sessionControlSource)
    this.sessionApprovalListHandler = createSessionApprovalListRequestHandler(
      authorizer,
      dependencies.sessionApprovalSource,
    )
    this.sessionApprovalDecisionHandler = createSessionApprovalDecisionRequestHandler(
      authorizer,
      dependencies.sessionApprovalSource,
    )
    this.sessionQuestionListHandler = createSessionQuestionListRequestHandler(
      authorizer,
      dependencies.sessionQuestionSource,
    )
    this.sessionQuestionResponseHandler = createSessionQuestionResponseRequestHandler(
      authorizer,
      dependencies.sessionQuestionSource,
    )
    this.sessionCreateHandler = createSessionCreateRequestHandler(
      authorizer,
      dependencies.sessionCreateWorkspaceSource,
      dependencies.sessionCreateSource,
    )
    this.sessionModelHandler = createSessionModelRequestHandler(authorizer, dependencies.sessionModelSource)
    this.sessionUsageHandler = createSessionUsageRequestHandler(authorizer, dependencies.sessionUsageSource)
    this.sessionStreamHandler = createSessionStreamRequestHandler(authorizer, dependencies.sessionStreamSource)
    this.criticalNotificationHandler = createCriticalNotificationRequestHandler(
      authorizer,
      dependencies.criticalNotificationSource,
    )
    this.sessionFileService = new SessionFileUploadService(authorizer, dependencies.sessionFileSource)
  }

  async handle(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    let observed: (() => void) | undefined
    try { if (isUsageRequest(request)) {
      const captured=this.dependencies.observeBusinessRequest?.()
      if(captured&&this.authorizer.authorize(request.authorization,request.connectionGeneration)) observed=captured
    } }
    catch { /* Optional evidence never changes authorization or the response. */ }
    const response=await this.dispatch(request)
    try { if(observed && response.status===200 && !request.signal?.aborted &&
      this.authorizer.authorize(request.authorization,request.connectionGeneration)) observed?.() } catch { /* Optional. */ }
    return response
  }
  private async dispatch(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if ([DESKTOP_HOST_PATH, DESKTOP_SESSIONS_PATH, DESKTOP_SESSION_ACTION_PATH, DESKTOP_WORKSPACE_ACTION_PATH].includes(barePath)) return this.desktopSessionsHandler(request)
    if (barePath === DSH_QUEUE_PATH) return this.messageQueue?.handle(request) ?? { status: 404, body: '' }
    if (barePath === SESSION_STATE_PATH && isDiagnosticReadBody(request.body)) return this.diagnosticHandler(request)
    if (barePath === SESSION_LIST_PATH) return this.sessionListHandler(request)
    if (barePath === SESSION_DETAIL_PATH) return this.sessionDetailHandler(request)
    if (barePath === SESSION_IMAGE_PATH) return this.sessionImageService.handle(request)
    if (barePath === SESSION_IMAGE_MESSAGE_PATH) return this.sessionImageMessageService.handle(request)
    if (barePath === SESSION_MESSAGE_PATH) return this.sessionMessageHandler(request)
    if (barePath === SESSION_STATE_PATH || barePath === SESSION_CANCEL_PATH) {
      return this.sessionControlHandler(request)
    }
    if (barePath === SESSION_APPROVAL_LIST_PATH) return this.sessionApprovalListHandler(request)
    if (barePath === SESSION_APPROVAL_DECISION_PATH) return this.sessionApprovalDecisionHandler(request)
    if (barePath === SESSION_QUESTION_LIST_PATH) return this.sessionQuestionListHandler(request)
    if (barePath === SESSION_QUESTION_RESPONSE_PATH) return this.sessionQuestionResponseHandler(request)
    if (barePath === SESSION_CREATE_PATH) return this.sessionCreateHandler(request)
    if (barePath === SESSION_MODELS_PATH || barePath === SESSION_MODEL_SELECT_PATH) {
      return this.sessionModelHandler(request)
    }
    if (barePath === SESSION_USAGE_PATH) return this.sessionUsageHandler(request)
    if (barePath === SESSION_STREAM_PATH) return this.sessionStreamHandler(request)
    if (barePath === CRITICAL_NOTIFICATION_PATH) return this.criticalNotificationHandler(request)
    if (barePath === SESSION_FILE_START_PATH
      || barePath === SESSION_FILE_CHUNK_PATH
      || barePath === SESSION_FILE_FINISH_PATH
      || barePath === SESSION_FILE_ABORT_PATH) return this.sessionFileService.handle(request)
    return { status: 404, body: '' }
  }

  dispose(): Promise<void> {
    this.messageQueue?.close()
    this.sessionDetailHandler.dispose()
    this.sessionImageService.dispose()
    this.sessionImageMessageService.dispose()
    return this.sessionFileService.dispose()
  }
}
