import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { startupStorageError, startupFailureReason } from './startup-observation.js'

const RECORD_FIELDS = [
  'pairingVersion',
  'pairingId',
  'mobilePublicKeyRaw',
  'createdAt',
  'updatedAt',
  'status',
]
const IDENTITY_ENVELOPE_FIELDS = ['storageVersion', 'identityId', 'record']
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const STATUSES = new Set(['pending', 'active', 'revoked'])

export type PairingTrustStatus = 'pending' | 'active' | 'revoked'

export interface PairingTrustRecord {
  pairingVersion: 1
  pairingId: string
  mobilePublicKeyRaw: string
  createdAt: number
  updatedAt: number
  status: PairingTrustStatus
}

export interface PairingTrustStore {
  read(): PairingTrustRecord | null
  replace(record: PairingTrustRecord): void
  deletePending(pairingId?: string): void
  deleteRevoked?(expected: PairingTrustRecord): void
}

function storageFailure(error?: unknown): never {
  throw startupStorageError('Pairing trust storage failed', error)
}

function decodeCanonical(value: unknown, length: number): boolean {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === length && decoded.toString('base64url') === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateRecord(value: unknown): PairingTrustRecord {
  if (!isRecord(value)
    || Object.keys(value).length !== RECORD_FIELDS.length
    || !Object.keys(value).every((field, index) => field === RECORD_FIELDS[index])
    || value.pairingVersion !== 1
    || !decodeCanonical(value.pairingId, 16)
    || !decodeCanonical(value.mobilePublicKeyRaw, 32)
    || !Number.isSafeInteger(value.createdAt)
    || (value.createdAt as number) < 0
    || !Number.isSafeInteger(value.updatedAt)
    || (value.updatedAt as number) < (value.createdAt as number)
    || !STATUSES.has(value.status as string)) {
    throw new TypeError('Invalid Pairing V1 trust record')
  }
  return value as unknown as PairingTrustRecord
}

function copyRecord(record: PairingTrustRecord): PairingTrustRecord {
  const value = validateRecord(record)
  return {
    pairingVersion: 1,
    pairingId: value.pairingId,
    mobilePublicKeyRaw: value.mobilePublicKeyRaw,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    status: value.status,
  }
}

function validateIdentityId(value: unknown): string {
  if (typeof value !== 'string' || !decodeCanonical(value, 32)) storageFailure()
  return value
}

function copyIdentityEnvelope(identityId: string, value: unknown) {
  if (!isRecord(value)
    || Object.keys(value).length !== IDENTITY_ENVELOPE_FIELDS.length
    || !Object.keys(value).every((field, index) => field === IDENTITY_ENVELOPE_FIELDS[index])
    || value.storageVersion !== 1
    || !decodeCanonical(value.identityId, 32)) {
    storageFailure({ startupReason: 'record_invalid' })
  }
  if (value.identityId !== identityId) storageFailure({ startupReason: 'identity_mismatch' })
  return {
    storageVersion: 1 as const,
    identityId,
    record: copyRecord(validateRecord(value.record)),
  }
}

export class InMemoryPairingTrustStore implements PairingTrustStore {
  private record: PairingTrustRecord | undefined

  constructor(initial?: PairingTrustRecord) {
    if (initial !== undefined) {
      const value = copyRecord(initial)
      if (value.status !== 'pending') this.record = value
    }
  }

  read(): PairingTrustRecord | null {
    return this.record === undefined ? null : copyRecord(this.record)
  }

  replace(record: PairingTrustRecord): void {
    this.record = copyRecord(record)
  }

  deletePending(pairingId?: string): void {
    if (this.record?.status !== 'pending') return
    if (pairingId !== undefined && this.record.pairingId !== pairingId) return
    this.record = undefined
  }
  deleteRevoked(expected: PairingTrustRecord): void {
    if (expected.status !== 'revoked' || JSON.stringify(this.read()) !== JSON.stringify(expected)) storageFailure()
    this.record = undefined
  }
}

export class FilePairingTrustStore implements PairingTrustStore {
  constructor(private readonly path: string) {
    if (typeof path !== 'string' || path.length === 0) storageFailure()
    this.deletePending()
  }

  read(): PairingTrustRecord | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      storageFailure(error)
    }
    try {
      const value: unknown = JSON.parse(text)
      const record = copyRecord(validateRecord(value))
      if (JSON.stringify(record) !== text) throw new TypeError()
      return record
    } catch {
      storageFailure({ startupReason: 'record_invalid' })
    }
  }

  replace(record: PairingTrustRecord): void {
    const value = copyRecord(record)
    const temporaryPath = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
      writeFileSync(temporaryPath, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
      renameSync(temporaryPath, this.path)
    } catch {
      storageFailure()
    } finally {
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // The atomic destination is authoritative; stale temp cleanup is best effort.
      }
    }
  }

  deletePending(pairingId?: string): void {
    const record = this.read()
    if (record?.status !== 'pending') return
    if (pairingId !== undefined && record.pairingId !== pairingId) return
    try {
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure(error)
    }
  }
  deleteRevoked(expected: PairingTrustRecord): void {
    if (expected.status !== 'revoked' || JSON.stringify(this.read()) !== JSON.stringify(expected)) storageFailure()
    try { rmSync(this.path) } catch { storageFailure() }
  }
}

/**
 * Binds the exact public Pairing V1 trust record to an already established
 * connector identity. It neither creates nor selects that identity.
 */
export class IdentityBoundFilePairingTrustStore implements PairingTrustStore {
  private readonly identityId: string

  constructor(private readonly path: string, identityId: string) {
    if (typeof path !== 'string' || path.length === 0) storageFailure()
    this.identityId = validateIdentityId(identityId)
    this.deletePending()
  }

  read(): PairingTrustRecord | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          if (statSync(dirname(this.path)).isDirectory()) return null
        } catch (parentError) {
          // A missing or unreadable parent is not a missing trust record.
          storageFailure(parentError)
        }
      }
      storageFailure(error)
    }
    try {
      const envelope = copyIdentityEnvelope(this.identityId, JSON.parse(text))
      if (JSON.stringify(envelope) !== text) storageFailure()
      return copyRecord(envelope.record)
    } catch (error) {
      storageFailure(startupFailureReason(error) === 'unknown' ? { startupReason: 'record_invalid' } : error)
    }
  }

  replace(record: PairingTrustRecord): void {
    const envelope = {
      storageVersion: 1 as const,
      identityId: this.identityId,
      record: copyRecord(record),
    }
    const temporaryPath = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let descriptor: number | undefined
    let failed = false
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(envelope), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporaryPath, this.path)
    } catch {
      failed = true
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          failed = true
        }
      }
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // The destination is authoritative; stale temp cleanup is best effort.
      }
    }
    if (failed) storageFailure()
  }

  deletePending(pairingId?: string): void {
    const record = this.read()
    if (record?.status !== 'pending') return
    if (pairingId !== undefined && record.pairingId !== pairingId) return
    try {
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure(error)
    }
  }
  deleteRevoked(expected: PairingTrustRecord): void {
    if (expected.status !== 'revoked' || JSON.stringify(this.read()) !== JSON.stringify(expected)) storageFailure()
    try { rmSync(this.path) } catch { storageFailure() }
  }
}
