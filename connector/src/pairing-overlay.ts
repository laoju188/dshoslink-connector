import { Service, type Context } from '@deepseek-ai/cordis'
import { DshEnrollmentRemote } from './dsh-enrollment-remote.js'
import type { DshEnrollment } from './dsh-enrollment.js'
import type {
  PairingConnectorStatusSnapshot,
  PairingPortControl,
} from './pairing-port-control.js'
import { PAIRING_REMOTE_NAMESPACE } from './remote.js'

export const PAIRING_UI_PROOF_ENV = 'DSHOS_LINK_PAIRING_UI_PROOF'
export const MAX_INVITATION_TTL_MS = 120_000
export const PAIRING_MANAGEMENT_COMMAND_SUCCESS = '已在 DSH Web 中打开 DSHOS Link 配对管理。'
export const PAIRING_COMMAND_ARGUMENT_ERROR = '此命令不接受参数。'

export interface TransientInvitationSnapshot {readonly payload:string;readonly expiresAt:number}
export type TransientInvitationProvider = ()=>TransientInvitationSnapshot

export type PairingInvitationOverlayStatus =
  | 'INVITATION_ACTIVE'
  | 'WAITING_CONFIRMATION'
  | 'READY_TO_FINALIZE'
  | 'PENDING_COMMIT'

export interface PairingInvitationOverlaySnapshot extends TransientInvitationSnapshot {
  readonly status: PairingInvitationOverlayStatus
  readonly sessionId: string | null
}

export type PairingOverlaySnapshot =
  | PairingInvitationOverlaySnapshot
  | { readonly status: 'PAIRED'; readonly addressPayload?: string }
  | { readonly status: 'REVOKED' }

export type PairingOverlayComputerConfirmation =
  | { readonly ok: true }
  | { readonly ok: false; readonly attemptsRemaining: 1 | 2 }
  | { readonly ok: false; readonly code: string }

export type PairingOverlayComputerConfirmationResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly attemptsRemaining: 0 | 1 | 2 }

export interface PairingOverlayController {
  readonly invitationStore: TransientInvitationStore
  open(): PairingOverlaySnapshot
  snapshot(): PairingOverlaySnapshot | null
  regenerate(): PairingInvitationOverlaySnapshot
  close(): void
  confirmComputer(
    sessionId: string,
    verificationCode: string,
  ): PairingOverlayComputerConfirmation
  deny(): { readonly ok: boolean }
  rejectAndRegenerate(): PairingInvitationOverlaySnapshot
  revokePairedDevice(): { readonly status: 'REVOKED' }
  dispose(): void
}

interface CommandInvocation {
  readonly rawInput: string
}

export interface PairingCommandDefinition {
  readonly name: string
  readonly description: string
  readonly recordInput: false
  readonly handler: (invocation: CommandInvocation) => {
    readonly kind: 'success' | 'error'
    readonly text: string
  }
}

interface CommandsRegistrar {
  register(definition: PairingCommandDefinition): () => void
}

type CommandsContext = Context & { readonly commands: CommandsRegistrar }

export interface PairingOverlayProofOptions {
  readonly prepareEnrollmentAddress?: (expected:DshEnrollment)=>Promise<void>
  readonly enrollment?: () => DshEnrollment | undefined
  readonly env?: NodeJS.ProcessEnv
  readonly provider?: TransientInvitationProvider
  readonly ttlMs?: number
  readonly controller?: PairingOverlayController
  readonly commandEnabled?: boolean
  readonly disposeController?: boolean
  readonly portControl?: PairingPortControl
}

// Compatibility surface for existing host management; never generates an invitation.
export class TransientInvitationStore {
  snapshot():null{return null}
  open():never{throw Error('pairing_upgrade_required')}
  regenerate():never{throw Error('pairing_upgrade_required')}
  close():void{}
  dispose():void{}
}

export class PairingOverlayService extends Service {
  readonly typertRemote: {
    readonly service: PairingOverlayService
    readonly serviceKey: typeof PAIRING_REMOTE_NAMESPACE
    readonly namespace: typeof PAIRING_REMOTE_NAMESPACE
  }

  constructor(
    ctx: Context,
    private readonly store: TransientInvitationStore,
    private readonly controller?: PairingOverlayController,
    private readonly portControl?: PairingPortControl,
  ) {
    super(ctx, PAIRING_REMOTE_NAMESPACE)
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: PAIRING_REMOTE_NAMESPACE,
      namespace: PAIRING_REMOTE_NAMESPACE,
    })
  }

  snapshot(): PairingOverlaySnapshot | null {
    if (this.controller !== undefined) return this.controller.snapshot()
    return null
  }

  regenerate(): PairingInvitationOverlaySnapshot {
    throw Error('pairing_upgrade_required')
  }

  close(): void {
    if (this.controller === undefined) this.store.close()
    else this.controller.close()
  }

  confirmComputer(
    sessionId: string,
    verificationCode: string,
  ): PairingOverlayComputerConfirmationResult {
    const result = this.controller?.confirmComputer(sessionId, verificationCode)
    if (result?.ok === true) return { accepted: true }
    if (result !== undefined && 'attemptsRemaining' in result) {
      return { accepted: false, attemptsRemaining: result.attemptsRemaining }
    }
    if (result !== undefined && 'code' in result && result.code === 'PAIRING_DENIED') {
      return { accepted: false, attemptsRemaining: 0 }
    }
    throw new Error('Pairing confirmation action failed')
  }

  deny(): void {
    if (this.controller?.deny().ok !== true) {
      throw new Error('Pairing confirmation action failed')
    }
  }

  rejectAndRegenerate(): PairingInvitationOverlaySnapshot {
    if (this.controller === undefined) throw new Error('Pairing confirmation action failed')
    return this.controller.rejectAndRegenerate()
  }

  revokePairedDevice(): { readonly status: 'REVOKED' } {
    const result = this.controller?.revokePairedDevice()
    if (result?.status !== 'REVOKED') throw new Error('Pairing revocation action failed')
    return result
  }

  connectorStatus(): PairingConnectorStatusSnapshot | null {
    return this.portControl?.connectorStatus() ?? null
  }

  async setRemoteAccess(enabled: boolean): Promise<PairingConnectorStatusSnapshot> {
    if (typeof enabled !== 'boolean') throw Error('remote_access_invalid')
    if (!this.portControl?.setRemoteAccess) throw Error('remote_access_unavailable')
    return this.portControl.setRemoteAccess(enabled)
  }

  async repairPorts(): Promise<PairingConnectorStatusSnapshot> {
    if (this.portControl === undefined) throw new Error('Pairing port repair is unavailable')
    return this.portControl.repairPorts()
  }
}

export function registerPairingCodeCommands(ctx: Context): ReturnType<Context['inject']> {
  return ctx.inject(['commands'], injectedCtx => {
    for (const name of ['dshos-pair', 'dshos-register-computer']) {
      ;(injectedCtx as CommandsContext).commands.register({
        name,
        description: '查看 DSHOS Link 配对码连接方法。', recordInput: false,
        handler({ rawInput }) {
          if (rawInput.trim()) return { kind: 'error', text: PAIRING_COMMAND_ARGUMENT_ERROR }
          return { kind: 'success', text: '请在 DSH 的插件设置中打开 DSHOS Link，输入手机“配对 DSH”页面上的配对码，再回到手机确认。如果手机只有扫码入口，请先更新手机 App 至 1.0.7 或更新版本。' }
        },
      })
    }
  })
}

export function registerPairingOverlayProof(
  ctx: Context,
  options: PairingOverlayProofOptions = {},
): TransientInvitationStore {
  const store = options.controller?.invitationStore ?? new TransientInvitationStore()
  const pairing = new PairingOverlayService(ctx, store, options.controller, options.portControl)
  new DshEnrollmentRemote(ctx, options.enrollment ?? (() => undefined), pairing )
  if (options.controller === undefined || options.disposeController !== false) {
    ctx.effect(() => () => {
      if (options.controller === undefined) store.dispose()
      else options.controller.dispose()
    }, 'dshos-link-pairing-overlay-store')
  }
  return store
}
