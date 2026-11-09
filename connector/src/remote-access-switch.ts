import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PausedRemoteIdentity {
  readonly identityId: string
  readonly pin: string
  readonly pairingId: string
  readonly mobilePublicKeyRaw: string
}
const fields = ['version', 'identityId', 'pin', 'pairingId', 'mobilePublicKeyRaw']
function fixed(value: unknown, size: number): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value)
    && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value
}
function valid(value: PausedRemoteIdentity): boolean {
  return fixed(value.identityId, 32) && fixed(value.pin, 32) && fixed(value.pairingId, 16) && fixed(value.mobilePublicKeyRaw, 32)
}
export function samePausedIdentity(a: PausedRemoteIdentity, b: PausedRemoteIdentity): boolean {
  return valid(a) && valid(b) && a.identityId === b.identityId && a.pin === b.pin
    && a.pairingId === b.pairingId && a.mobilePublicKeyRaw === b.mobilePublicKeyRaw
}
// Directory existence is the durable deny marker. A partial/corrupt record is
// still denied after restart. No retirement receipt or pairing file is altered.
export class RemoteAccessSwitch {
  readonly directory: string
  private readonly path: string
  private readonly resumedDirectory: string
  constructor(root: string) {
    this.directory = join(root, 'remote-access-paused-v1')
    this.path = join(this.directory, 'identity.json')
    this.resumedDirectory = join(root, 'remote-access-resumed-v1')
  }
  read(): PausedRemoteIdentity | null {
    try {
      const directory = lstatSync(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('remote_access_state_unavailable')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw Error('remote_access_state_unavailable')
    }
    return this.readIdentity(this.directory)
  }
  private readIdentity(directory: string): PausedRemoteIdentity {
    try {
      const path = join(directory, 'identity.json'), stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw Error()
      const text = readFileSync(path, 'utf8'), value = JSON.parse(text)
      if (!value || Object.keys(value).join(',') !== fields.join(',') || value.version !== 1
        || JSON.stringify(value) !== text || !valid(value)) throw Error()
      return { identityId: value.identityId, pin: value.pin, pairingId: value.pairingId, mobilePublicKeyRaw: value.mobilePublicKeyRaw }
    } catch { throw Error('remote_access_state_unavailable') }
  }
  pause(value: PausedRemoteIdentity): void {
    if (!valid(value)) throw Error('remote_access_identity_unavailable')
    const previous = this.read()
    if (previous) {
      if (!samePausedIdentity(previous, value)) throw Error('remote_access_identity_changed')
      return
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ version: 1, ...value }), 'utf8')
      fsyncSync(fd)
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  resume(expected: PausedRemoteIdentity): void {
    const current = this.read()
    if (!current || !samePausedIdentity(current, expected)) throw Error('remote_access_identity_changed')
    if (readdirSync(this.directory).join(',') !== 'identity.json') throw Error('remote_access_state_unavailable')
    // Clear any prior, already committed resume before reusing its fixed path.
    // Failure here leaves the complete pause record untouched and retryable.
    this.cleanResumed()
    // The owner's verified resume commits as one rename. Never delete the
    // identity inside the active deny marker: interrupted cleanup must not
    // strand a paused directory with no identity to authorize another retry.
    renameSync(this.directory, this.resumedDirectory)
    try { this.cleanResumed() } catch { /* Resume committed; retry bounded cleanup on the next resume. */ }
  }
  private cleanResumed(): void {
    try {
      const stat = lstatSync(this.resumedDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('remote_access_state_unavailable')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const entries = readdirSync(this.resumedDirectory)
    if (entries.length > 0) {
      if (entries.join(',') !== 'identity.json') throw Error('remote_access_state_unavailable')
      this.readIdentity(this.resumedDirectory)
      unlinkSync(join(this.resumedDirectory, 'identity.json'))
    }
    // Only a validated record or its empty interrupted-cleanup directory.
    // Unexpected files and links are never recursively removed.
    rmdirSync(this.resumedDirectory)
  }
}
