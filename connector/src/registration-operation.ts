import { AsyncLocalStorage } from 'node:async_hooks'
import { observeStartupStorageFailure } from './startup-observation.js'
import { registrationNativeCause } from './registration-native-error.js'
import type { RegistrationGuard } from './dsh-registration-storage.js'

export type RegistrationStep = 'path' | 'read' | 'decode' | 'decrypt' | 'validate' | 'encrypt' | 'write'
export type RegistrationRecord = 'material' | 'source' | 'intent' | 'pairing_intent' | 'registry' | 'activation' | 'recovery'
export interface RegistrationReadEvent { record: RegistrationRecord; step: RegistrationStep; milliseconds: number; remaining: number; result: 'pending' | 'ok' | 'cached' | 'failed'; cause: string }
interface Operation {
  guard: RegistrationGuard; signal: AbortSignal; remaining(): number; now(): number
  observe?(event: RegistrationReadEvent): void
  active: boolean
  // Cipher bytes are compared on every read. No file/stat check is skipped.
  cache: Map<object, { cipher: Buffer; value: unknown }>
}
const operations = new AsyncLocalStorage<Operation>()
export const registrationOperation = () => operations.getStore()
export function assertRegistrationOperation(): void {
  const op = operations.getStore()
  if (!op) return
  if (!op.active || op.signal.aborted) throw Error('enrollment_cancelled')
  op.guard.assertHeld()
}
export async function withRegistrationOperation<T>(options: Omit<Operation, 'active' | 'cache'>, action: () => Promise<T>): Promise<T> {
  const op: Operation = { ...options, active: true, cache: new Map() }
  return operations.run(op, async () => {
    try { return await action() }
    finally { op.active = false; for (const entry of op.cache.values()) entry.cipher.fill(0); op.cache.clear() }
  })
}
export async function registrationStep<T>(record: RegistrationRecord, step: RegistrationStep, action: () => Promise<T>, cached = false): Promise<T> {
  const op = operations.getStore(), start = op?.now() ?? 0
  const notify = (result: RegistrationReadEvent['result'], error?: unknown) => {
    if (!op) return
    const message = error instanceof Error ? error.message : ''
    // Allowlisted categories only. Never include file paths or original error text.
    const cause = message === 'enrollment_cancelled' || message === 'registration_timeout' ? 'deadline_or_cancel'
      : message === 'registration_reparse' ? 'unsafe_path'
      : message === 'registration_format' ? 'record_invalid'
      : error ? registrationNativeCause(error) : 'none'
    try { op.observe?.({ record, step, milliseconds: Math.max(0, Math.floor(op.now() - start)),
      remaining: Math.max(0, Math.floor(op.remaining())), result, cause }) } catch { /* Optional diagnostics. */ }
  }
  let value: T | undefined
  try { assertRegistrationOperation(); notify('pending'); value = await action(); assertRegistrationOperation(); notify(cached ? 'cached' : 'ok'); return value }
  catch (error) {
    if(step==='decrypt'&&Buffer.isBuffer(value))value.fill(0)
    observeStartupStorageFailure(record,step,error);notify('failed', error);throw error
  }
}
