import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { readQueueRecord, queueRecordCanRetire, type QueueRecord, type QueueStore } from './session-message-queue.js'

export interface QueueProtector { protect(bytes: Buffer): Promise<Buffer>; unprotect(bytes: Buffer): Promise<Buffer> }
const MAX_PLAINTEXT = 512 * 1024
const MAX_TOTAL = 3 * 1024 * 1024
const MAX_SCOPES = 32
const MAX_PHYSICAL = 8 * 1024 * 1024

async function checkedPath(file: string, directory = false): Promise<void> {
  const absolute = resolve(file)
  let part = parse(absolute).root
  for (const name of absolute.slice(part.length).split(/[\\/]/)) {
    if (!name) continue
    part = join(part, name)
    if ((await lstat(part)).isSymbolicLink()) throw Error('queue_reparse_point')
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw Error('queue_reparse_point')
  const stat = await lstat(absolute)
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw Error('queue_path_invalid')
}
const aad = (scope: string, revision: number): Buffer => Buffer.from(JSON.stringify(['DSHOS-LINK/SESSION-MESSAGE-QUEUE/V1', scope, revision]))
const validScope = (scope: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(scope)
  && Buffer.from(scope, 'base64url').length === 32 && Buffer.from(scope, 'base64url').toString('base64url') === scope

// PC-local, encrypted queue state. The caller supplies an already protected
// application directory and retains its OS owner lease through every operation.
// No plaintext queue content, account identifier, host path or key is put in SQL.
// A random database key is protected by Windows CurrentUser DPAPI once at open;
// bounded AES-GCM records avoid spawning PowerShell for every queue mutation.
export class MessageQueueDatabase {
  private db: DatabaseSync | null = null
  private key: Buffer | null = null
  private constructor(private readonly file: string, private readonly assertOwner: () => void) {}

  static async open(directory: string, protector: QueueProtector, assertOwner: () => void,
    create = false): Promise<MessageQueueDatabase> {
    assertOwner()
    await checkedPath(directory, true)
    assertOwner()
    const result = new MessageQueueDatabase(join(directory, 'message-queue-v1.sqlite'), assertOwner)
    let exists = true
    try { await checkedPath(result.file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; else throw error }
    assertOwner()
    if (!exists && !create) throw Error('queue_database_missing')
    try {
      if (!exists) {
        const handle = await open(result.file, 'wx', 0o600)
        try { assertOwner(); await handle.sync() } finally { await handle.close() }
      }
      await result.physical()
      assertOwner()
      result.db = new DatabaseSync(result.file)
      result.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA max_page_count=896;')
      if (result.db.prepare('PRAGMA page_size').get()?.page_size !== 4096
        || (result.db.prepare('PRAGMA page_count').get()?.page_count as number) > 896) throw Error('queue_database_limit')
      if (!exists) {
        const key = randomBytes(32)
        let sealed: Buffer
        try { sealed = await protector.protect(key); assertOwner() }
        catch (error) { key.fill(0); throw error }
        if (!Buffer.isBuffer(sealed) || sealed.length === 0 || sealed.length > 8192) { key.fill(0); throw Error('queue_key_invalid') }
        result.key = key
        result.db.exec('BEGIN IMMEDIATE')
        try {
          result.db.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), protected_key BLOB NOT NULL);'
            + 'CREATE TABLE queues (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload BLOB NOT NULL); PRAGMA user_version=1;')
          result.db.prepare('INSERT INTO meta VALUES(1,?)').run(sealed)
          result.db.exec('COMMIT')
        } catch (error) { result.db.exec('ROLLBACK'); throw error }
      }
      if (result.db.prepare('PRAGMA user_version').get()?.user_version !== 1
        || result.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw Error('queue_database_damaged')
      const meta = result.db.prepare('SELECT protected_key FROM meta WHERE id=1').get()
      if (!(meta?.protected_key instanceof Uint8Array) || !meta.protected_key.length || meta.protected_key.length > 8192) throw Error('queue_key_invalid')
      if (result.key === null) {
        result.key = await protector.unprotect(Buffer.from(meta.protected_key))
        assertOwner()
        if (!Buffer.isBuffer(result.key) || result.key.length !== 32) throw Error('queue_key_invalid')
      }
      const totals = result.db.prepare('SELECT count(*) n, coalesce(sum(length(payload)),0) bytes FROM queues').get()!
      if ((totals.n as number) > MAX_SCOPES || (totals.bytes as number) > MAX_TOTAL) throw Error('queue_database_limit')
      await result.physical()
      result.current()
      return result
    } catch (error) {
      // Keep ambiguous or damaged evidence. A later open never silently recreates it.
      result.close()
      throw error
    }
  }

  close(): void { this.key?.fill(0); this.key = null; this.db?.close(); this.db = null }
  private current(): DatabaseSync {
    this.assertOwner()
    if (!this.db || !this.key) throw Error('queue_database_closed')
    return this.db
  }
  private async physical(): Promise<void> {
    let bytes = 0
    for (const file of [this.file, this.file + '-journal', this.file + '-wal', this.file + '-shm']) {
      try { await checkedPath(file); bytes += (await lstat(file)).size }
      catch (error) { if (file === this.file || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (bytes > MAX_PHYSICAL) throw Error('queue_database_limit')
  }
  private decode(scope: string, revision: number, payload: unknown): QueueRecord {
    if (!(payload instanceof Uint8Array) || payload.length < 29 || payload.length > MAX_PLAINTEXT + 28) throw Error('queue_ciphertext_invalid')
    const bytes = Buffer.from(payload), decipher = createDecipheriv('aes-256-gcm', this.key!, bytes.subarray(0, 12))
    decipher.setAAD(aad(scope, revision)); decipher.setAuthTag(bytes.subarray(12, 28))
    let plain: Buffer | null = null
    try {
      plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plain), value: unknown = JSON.parse(text)
      if (JSON.stringify(value) !== text) throw Error('queue_record_invalid')
      const record = readQueueRecord(value)
      if (record.scope !== scope || record.revision !== revision) throw Error('queue_record_scope')
      return record
    } finally { plain?.fill(0) }
  }
  private encode(record: QueueRecord): Buffer {
    const plain = Buffer.from(JSON.stringify(record))
    try {
      if (plain.length > MAX_PLAINTEXT) throw Error('queue_record_limit')
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key!, nonce)
      cipher.setAAD(aad(record.scope, record.revision))
      const bytes = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes])
    } finally { plain.fill(0) }
  }
  // Bounded authenticated scan under the same exclusive runtime owner. The
  // callback must fence any resident coordinator before its durable row goes.
  async retireExpired(now: number, retire: (record: QueueRecord) => boolean): Promise<string[]> {
    await this.physical()
    const db = this.current(), removed: string[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      const records = db.prepare('SELECT scope,revision,payload FROM queues').all()
        .map(row => this.decode(row.scope as string, row.revision as number, row.payload))
      // Validate the whole scan before closing residents or changing any row.
      const expired = records.filter(record => queueRecordCanRetire(record, now))
      for (const record of expired) {
        this.current()
        if (!retire(record)) continue
        this.current()
        db.prepare('DELETE FROM queues WHERE scope=? AND revision=?').run(record.scope, record.revision)
        removed.push(record.scope)
      }
      db.exec('COMMIT'); return removed
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  forScope(scope: string): QueueStore {
    if (!validScope(scope)) throw Error('queue_scope')
    this.current()
    return Object.freeze({
      read: async (): Promise<QueueRecord | null> => {
        await this.physical()
        const row = this.current().prepare('SELECT revision,payload FROM queues WHERE scope=?').get(scope)
        return row ? this.decode(scope, row.revision as number, row.payload) : null
      },
      compareAndSwap: async (expectedRevision: number | null, value: QueueRecord, assertCurrent?: () => void): Promise<void> => {
        const record = readQueueRecord(value)
        if (record.scope !== scope || (expectedRevision === null ? record.revision !== 1
          : !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || record.revision !== expectedRevision + 1)) throw Error('queue_revision_changed')
        await this.physical()
        const db = this.current(), payload = this.encode(record)
        db.exec('BEGIN IMMEDIATE')
        try {
          const row = db.prepare('SELECT revision,payload FROM queues WHERE scope=?').get(scope)
          if ((row?.revision ?? null) !== expectedRevision) throw Error('queue_storage_conflict')
          if (row) {
            const before = this.decode(scope, row.revision as number, row.payload)
            if (record.highWater < before.highWater) throw Error('queue_clock')
          }
          const totals = db.prepare('SELECT count(*) n, coalesce(sum(length(payload)),0) bytes FROM queues').get()!
          if (!row && (totals.n as number) >= MAX_SCOPES || (totals.bytes as number) - (row ? (row.payload as Uint8Array).length : 0) + payload.length > MAX_TOTAL) throw Error('queue_database_limit')
          this.current(); assertCurrent?.()
          db.prepare('INSERT INTO queues(scope,revision,payload) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(scope, record.revision, payload)
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
    })
  }
}
