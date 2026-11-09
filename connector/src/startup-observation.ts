import { randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { STARTUP_REASONS, copyStartupDiagnostic, type StartupStorageDetail, type StartupDiagnostic, type StartupReason, type StartupStep } from './startup-diagnostic.js'

const startupContext = new AsyncLocalStorage<{ owner: StartupObservation; active: boolean; failures: WeakMap<object, StartupStorageDetail> }>()
export function observeStartupStorageFailure(record: StartupStorageDetail['record'], step: StartupStorageDetail['step'], error: unknown): void {
  // Capture only inside the owning startup action; ordinary pairing tasks are untouched.
  const context=startupContext.getStore()
  if (context?.active && error && typeof error === 'object' && !context.failures.has(error)) {
    context.failures.set(error, { record, step })
  }
}

function failedStorage(error: unknown, failures: WeakMap<object, StartupStorageDetail>, depth = 0): StartupStorageDetail | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return undefined
  try {
    return failures.get(error) ?? failedStorage(error instanceof AggregateError ? error.errors[0] : (error as { cause?: unknown }).cause, failures, depth + 1)
  } catch { return undefined }
}

export function startupFailureReason(error: unknown, depth = 0): StartupReason {
  try { return classifyStartupFailure(error, depth) }
  catch { return 'unknown' } // Diagnostics must never replace cleanup or the original failure.
}
function classifyStartupFailure(error: unknown, depth: number): StartupReason {
  if (depth > 3) return 'unknown'
  if (error instanceof AggregateError) return startupFailureReason(error.errors[0], depth + 1)
  const e = error as { code?: unknown; reason?: unknown; message?: unknown; cause?: unknown; startupReason?: unknown } | null
  if (STARTUP_REASONS.includes(e?.startupReason as StartupReason)) return e!.startupReason as StartupReason
  const reason = e?.reason ?? e?.message
  if (['timeout','registration_timeout','registration_lock_timeout'].includes(String(reason))) return 'timeout'
  if (['cancelled','enrollment_cancelled','cloud_pairing_context_ended'].includes(String(reason))) return 'cancelled'
  if (['registration_busy','cloud_pairing_storage_busy'].includes(String(reason))) return 'busy'
  if (reason === 'registration_lock_lost') return 'lock_lost'
  if (['registration_reparse','registration_guard','registration_path'].includes(String(reason))) return 'unsafe_path'
  if (['registration_format','registration_file','registration_capacity'].includes(String(reason)) || error instanceof SyntaxError) return 'record_invalid'
  if (['EACCES','EPERM'].includes(String(e?.code))) return 'access_denied'
  if (e?.code === 'ENOSPC') return 'disk_full'
  if (['EBUSY','ETXTBSY'].includes(String(e?.code))) return 'file_busy'
  if (['ENOENT','ENOTDIR'].includes(String(e?.code))) return 'missing_path'
  if (['EIO','EROFS','EMFILE','ENFILE','EISDIR'].includes(String(e?.code))) return 'io_failed'
  if (e?.code === 'DSH_PROTECTION_FAILED' || reason === 'failed' && error instanceof Error && error.constructor.name === 'WindowsDataProtectionError') return 'protection_failed'
  if (reason === 'unavailable') return 'unavailable'
  if (reason === 'port_conflict' || e?.code === 'EADDRINUSE') return 'port_conflict'
  if (reason === 'address_unavailable' || e?.code === 'EADDRNOTAVAIL') return 'address_unavailable'
  return e?.cause ? startupFailureReason(e.cause, depth + 1) : 'unknown'
}

/** Keep only a safe classification on generic storage errors; never raw exceptions. */
export function startupStorageError(message: string, error?: unknown): Error {
  return Object.assign(new Error(message), { startupReason: startupFailureReason(error) })
}

export class StartupObservation {
  private readonly id = randomBytes(16).toString('base64url')
  private readonly start: number
  private current: StartupStep = 'connection_runtime'
  private last: StartupStep | 'none' = 'none'
  private failure?: StartupDiagnostic
  constructor(private readonly now = Date.now, completedStep: StartupStep | 'none' = 'none') {
    this.start = now()
    this.last = completedStep
  }
  async run<T>(step: StartupStep, action: () => Promise<T>): Promise<T> {
    this.current = step
    const context={owner:this,active:true,failures:new WeakMap<object, StartupStorageDetail>()}
    return startupContext.run(context, async () => {
      try { const value = await action(); this.last = step; return value }
      catch (error) { this.fail(error); throw error }
      finally { context.active=false }
    })
  }
  sync<T>(step: StartupStep, action: () => T): T {
    this.current = step
    try { const value = action(); this.last = step; return value }
    catch (error) { this.fail(error); throw error }
  }
  fail(error: unknown, step = this.current): StartupDiagnostic {
    const context = startupContext.getStore()
    const storage = context?.active && context.owner === this ? failedStorage(error, context.failures) : undefined
    this.failure ??= { version: 1, attemptId: this.id, startedAtMs: this.start, failedAtMs: Math.max(this.start, this.now()),
      step, lastSuccess: this.last, reason: startupFailureReason(error), ...(storage ? { storage: { ...storage } } : {}) }
    return copyStartupDiagnostic(this.failure)
  }
}
