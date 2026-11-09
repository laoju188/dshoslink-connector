import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { registrationPath, type RegistrationProtector, type RegistrationGuard } from './dsh-registration-storage.js'

interface ProtectedRecord<T> { contract: string; sequence: number; previous: string | null; value: T }
const hash = (text: string): string => createHash('sha256').update(text).digest('base64url')

/** V3-only bounded storage; no change to V2 record sizes or file formats.
 * Caller holds the existing directory lease across read/network/write work. */
export class CloudPairingFile<T> {
  constructor(readonly path: string, private readonly protector: RegistrationProtector,
    private readonly valid: (value: unknown) => value is T,
    private readonly transition: (old: T | null, next: T) => boolean) {}
  private async bytes(path: string): Promise<Buffer | null> {
    try { await registrationPath(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const file = await open(path, 'r')
    let failure: unknown
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 32_768) throw Error('cloud_pairing_file_capacity')
      const bytes = Buffer.alloc(32_769); let size = 0
      while (size < bytes.length) { const result = await file.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead }
      if (size < 1 || size > 32_768) throw Error('cloud_pairing_file_capacity')
      return bytes.subarray(0, size)
    } catch (error) { failure = error; throw error }
    finally { try { await file.close() } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure,error], failure instanceof Error ? failure.message : 'cloud_pairing_read_failed', {cause:failure})
      throw error
    } }
  }
  private async decode(cipher: Buffer): Promise<{ text: string; record: ProtectedRecord<T> }> {
    const plain = await this.protector.unprotect(cipher)
    try {
      if (plain.length < 1 || plain.length > 24_000) throw Error('cloud_pairing_file_capacity')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plain), record = JSON.parse(text) as ProtectedRecord<T>
      if (JSON.stringify(record) !== text || Object.keys(record).join(',') !== 'contract,sequence,previous,value' ||
        record.contract !== 'dshos-cloud-protected-record-v3' || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
        !(record.previous === null || typeof record.previous === 'string' && /^[A-Za-z0-9_-]{43}$/.test(record.previous)) ||
        !this.valid(record.value)) throw Error('cloud_pairing_file_invalid')
      return { text, record }
    } finally { plain.fill(0) }
  }
  private async state(guard: RegistrationGuard): Promise<{ text: string; record: ProtectedRecord<T> } | null> {
    guard.assertHeld(); const oldBytes = await this.bytes(this.path); guard.assertHeld()
    const old = oldBytes ? await this.decode(oldBytes) : null; guard.assertHeld()
    const pendingBytes = await this.bytes(this.path + '.tmp'); guard.assertHeld()
    if (!pendingBytes) return old
    const pending = await this.decode(pendingBytes); guard.assertHeld()
    if (pending.record.sequence !== (old?.record.sequence ?? 0) + 1 || pending.record.previous !== (old ? hash(old.text) : null) ||
      !this.transition(old?.record.value ?? null, pending.record.value)) throw Error('cloud_pairing_interrupted_write_conflict')
    await rename(this.path + '.tmp', this.path); guard.assertHeld(); await this.sync(guard)
    return pending
  }
  private async sync(guard: RegistrationGuard): Promise<void> {
    guard.assertHeld(); const file = await open(this.path, 'r+')
    let failure: unknown
    try { await file.sync(); guard.assertHeld() } catch (error) { failure=error; throw error }
    finally { try { await file.close() } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure,error], failure instanceof Error ? failure.message : 'cloud_pairing_sync_failed', {cause:failure})
      throw error
    } }
  }
  async read(guard: RegistrationGuard): Promise<T | null> {
    const stored = await this.state(guard); guard.assertHeld()
    return stored ? structuredClone(stored.record.value) : null
  }
  async write(next: T, expected: T | null, guard: RegistrationGuard): Promise<void> {
    guard.assertHeld()
    if (!this.valid(next) || !this.transition(expected, next)) throw Error('cloud_pairing_transition')
    const old = await this.state(guard); guard.assertHeld()
    if (JSON.stringify(old?.record.value ?? null) !== JSON.stringify(expected)) throw Error('cloud_pairing_source_changed')
    if (JSON.stringify(expected) === JSON.stringify(next)) { if (old) await this.sync(guard); return }
    const record: ProtectedRecord<T> = { contract: 'dshos-cloud-protected-record-v3',
      sequence: (old?.record.sequence ?? 0) + 1, previous: old ? hash(old.text) : null, value: next }
    const plain = Buffer.from(JSON.stringify(record))
    if (plain.length > 24_000) { plain.fill(0); throw Error('cloud_pairing_file_capacity') }
    let cipher: Buffer
    try { cipher = await this.protector.protect(plain) } finally { plain.fill(0) }
    guard.assertHeld()
    if (!cipher.length || cipher.length > 32_768) throw Error('cloud_pairing_file_capacity')
    await registrationPath(dirname(this.path)); guard.assertHeld()
    const temporary = this.path + '.tmp', file = await open(temporary, 'wx', 0o600)
    let owned: Awaited<ReturnType<typeof file.stat>> | undefined
    let closed = false, committed = false, flushed = false, failure: unknown
    try {
      owned = await file.stat()
      guard.assertHeld(); await file.writeFile(cipher); await file.sync(); flushed = true; await file.close(); closed = true
      guard.assertHeld(); await registrationPath(temporary); guard.assertHeld()
      await rename(temporary, this.path); committed = true; guard.assertHeld(); await this.sync(guard)
    } catch (error) { failure = error }
    finally {
      const cleanup: unknown[] = []
      if (!closed) try { await file.close() } catch (error) { cleanup.push(error) }
      cipher.fill(0)
      // A complete temporary record is recovery evidence, including when rename
      // or the lease check failed. Only discard this call's incomplete file.
      if (!committed && !flushed && owned) try {
        guard.assertHeld(); const current = await lstat(temporary); guard.assertHeld()
        if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino)
          throw Error('cloud_pairing_temporary_replaced')
        await unlink(temporary)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanup.push(error) }
      if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup],
        failure instanceof Error ? failure.message : 'cloud_pairing_cleanup_failed', { cause: failure })
    }
    if (failure !== undefined) throw failure
  }
}
