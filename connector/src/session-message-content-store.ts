import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import type { QueueProtector } from './session-message-queue-store.js'
import { QUEUE_CONTENT_MAX_BYTES, queueContentId, queueContentHash, readQueueContentReference,
  readQueueMessageContent, type QueueContentReference } from './session-message-content.js'

export const QUEUE_CONTENT_READ_BYTES = 16384
const CHUNK = 64 * 1024, TOTAL = 256 * 1024 * 1024, PHYSICAL = 544 * 1024 * 1024, PAGES = 69632
async function checkedPath(path: string, directory = false): Promise<void> {
  const absolute = resolve(path); let part = parse(absolute).root
  for (const name of absolute.slice(part.length).split(/[\\/]/)) {
    if (!name) continue
    part = join(part,name)
    if ((await lstat(part)).isSymbolicLink()) throw Error('queue_content_reparse')
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw Error('queue_content_reparse')
  const stat = await lstat(absolute)
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw Error('queue_content_path')
}
const associated = (scope: string,id: string,size: number,part: number): Buffer =>
  Buffer.from(JSON.stringify(['DSHOS-LINK/QUEUE-MESSAGE-CONTENT/V1',scope,id,size,part]))
interface Stored { size: number; metadata: Uint8Array }

// The owning runtime must serialize content preparation, queue binding and
// release. Storage alone never grants permission to enqueue, execute or replay.
export class QueueContentDatabase {
  private db: DatabaseSync | null = null
  private key: Buffer | null = null
  private constructor(private readonly file: string,private readonly assertOwner: () => void) {}
  static async open(directory: string,protector: QueueProtector,assertOwner: () => void,create = false): Promise<QueueContentDatabase> {
    assertOwner();await checkedPath(directory,true);assertOwner()
    const result = new QueueContentDatabase(join(directory,'queue-message-content-v1.sqlite'),assertOwner)
    let exists = true
    try { await checkedPath(result.file) } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') exists=false;else throw e }
    assertOwner();if (!exists && !create) throw Error('queue_content_database_missing')
    try {
      if (!exists) { const file=await open(result.file,'wx',0o600);try { assertOwner();await file.sync() } finally { await file.close() } }
      await result.physical();assertOwner()
      result.db=new DatabaseSync(result.file)
      result.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA max_page_count='+PAGES+';')
      if (result.db.prepare('PRAGMA page_size').get()?.page_size !== 4096
        || (result.db.prepare('PRAGMA page_count').get()?.page_count as number) > PAGES) throw Error('queue_content_database_limit')
      if (!exists) {
        const key=randomBytes(32);let sealed: Buffer
        try { sealed=await protector.protect(key);assertOwner() } catch(e) { key.fill(0);throw e }
        if (!Buffer.isBuffer(sealed) || !sealed.length || sealed.length>8192) { key.fill(0);throw Error('queue_content_key') }
        result.key=key;result.db.exec('BEGIN IMMEDIATE')
        try {
          result.db.exec('CREATE TABLE meta(id INTEGER PRIMARY KEY CHECK(id=1),protected_key BLOB NOT NULL);'
            +'CREATE TABLE contents(scope TEXT NOT NULL,id TEXT NOT NULL,size INTEGER NOT NULL,metadata BLOB NOT NULL,PRIMARY KEY(scope,id));'
            +'CREATE TABLE chunks(scope TEXT NOT NULL,id TEXT NOT NULL,part INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(scope,id,part),FOREIGN KEY(scope,id) REFERENCES contents(scope,id) ON DELETE CASCADE);PRAGMA user_version=1;')
          result.db.prepare('INSERT INTO meta VALUES(1,?)').run(sealed);result.db.exec('COMMIT')
        } catch(e) { result.db.exec('ROLLBACK');throw e }
      }
      if (result.db.prepare('PRAGMA user_version').get()?.user_version !== 1 || result.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
        || result.db.prepare('PRAGMA foreign_key_check').all().length) throw Error('queue_content_database_damaged')
      const meta=result.db.prepare('SELECT protected_key FROM meta WHERE id=1').get()
      if (!(meta?.protected_key instanceof Uint8Array) || !meta.protected_key.length || meta.protected_key.length>8192) throw Error('queue_content_key')
      if (!result.key) { result.key=await protector.unprotect(Buffer.from(meta.protected_key));assertOwner();if(!Buffer.isBuffer(result.key)||result.key.length!==32)throw Error('queue_content_key') }
      result.limits();await result.physical();result.current();return result
    } catch(e) { result.close();throw e }
  }
  close(): void { this.key?.fill(0);this.key=null;this.db?.close();this.db=null }
  private current(): DatabaseSync { this.assertOwner();if(!this.db||!this.key)throw Error('queue_content_closed');return this.db }
  private async physical(): Promise<void> {
    let total=0
    for(const path of [this.file,this.file+'-journal',this.file+'-wal',this.file+'-shm']) {
      try { await checkedPath(path);total+=(await lstat(path)).size }
      catch(e) { if(path===this.file||(e as NodeJS.ErrnoException).code!=='ENOENT')throw e }
    }
    if(total>PHYSICAL)throw Error('queue_content_database_limit')
  }
  private limits(): void {
    const db=this.current(), totals=db.prepare('SELECT count(*) n,coalesce(sum(size),0) bytes FROM contents').get()!
    const invalid=db.prepare('SELECT count(*) n FROM contents WHERE size<1 OR size>? OR length(metadata)>2048').get(QUEUE_CONTENT_MAX_BYTES)!
    const grouped=db.prepare('SELECT count(*) n FROM contents GROUP BY scope HAVING count(*)>17').get()
    const chunks=db.prepare('SELECT count(*) n,coalesce(sum(length(payload)),0) bytes FROM chunks').get()!
    const invalidChunks=db.prepare('SELECT count(*) n FROM chunks WHERE part<0 OR part>=512 OR part!=CAST(part AS INTEGER) OR length(payload)<29 OR length(payload)>?').get(CHUNK+28)!
    if((totals.n as number)>64||(totals.bytes as number)>TOTAL||invalid.n||grouped||invalidChunks.n||(chunks.n as number)>64*512||(chunks.bytes as number)>TOTAL+64*512*28)throw Error('queue_content_database_limit')
  }
  private seal(bytes: Buffer,scope: string,ref: QueueContentReference,part: number): Buffer {
    this.current();const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key!,iv)
    cipher.setAAD(associated(scope,ref.id,ref.bytes,part))
    const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()])
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted])
  }
  private unseal(bytes: unknown,scope: string,ref: QueueContentReference,part: number,limit: number): Buffer {
    this.current()
    if(!(bytes instanceof Uint8Array)||bytes.length<29||bytes.length>limit+28)throw Error('queue_content_ciphertext')
    const cipher=createDecipheriv('aes-256-gcm',this.key!,bytes.subarray(0,12))
    cipher.setAAD(associated(scope,ref.id,ref.bytes,part));cipher.setAuthTag(bytes.subarray(12,28))
    const plain=cipher.update(bytes.subarray(28))
    try { return Buffer.concat([plain,cipher.final()]) } finally { plain.fill(0) }
  }
  private reference(scope: string,reference: QueueContentReference): QueueContentReference {
    if(!queueContentId(scope,32))throw Error('queue_content_scope');return readQueueContentReference(reference)
  }
  private retained(scope: string,ref: QueueContentReference): Stored | null {
    const row=this.current().prepare('SELECT size,metadata FROM contents WHERE scope=? AND id=?').get(scope,ref.id) as unknown as Stored | undefined
    if(!row)return null
    if(row.size!==ref.bytes)throw Error('queue_content_conflict')
    const plain=this.unseal(row.metadata,scope,ref,-1,2048)
    try { if(plain.toString()!==JSON.stringify(ref))throw Error('queue_content_conflict') } finally { plain.fill(0) }
    return row
  }
  private readBytes(scope: string,ref: QueueContentReference,guard: () => void): Buffer {
    if(!this.retained(scope,ref))throw Error('queue_content_missing')
    const result=Buffer.alloc(ref.bytes);let offset=0
    try {
      const count=this.current().prepare('SELECT count(*) n FROM chunks WHERE scope=? AND id=?').get(scope,ref.id)!.n
      if(count!==Math.ceil(ref.bytes/CHUNK))throw Error('queue_content_chunks')
      const read=this.current().prepare('SELECT payload FROM chunks WHERE scope=? AND id=? AND part=?')
      for(let part=0;offset<ref.bytes;part++) {
        guard();this.current();const row=read.get(scope,ref.id,part),plain=this.unseal(row?.payload,scope,ref,part,CHUNK)
        try { if(plain.length!==Math.min(CHUNK,ref.bytes-offset))throw Error('queue_content_chunks');plain.copy(result,offset);offset+=plain.length }
        finally { plain.fill(0) }
      }
      if(queueContentHash(result)!==ref.sha256)throw Error('queue_content_digest')
      readQueueMessageContent(result);guard();this.current();return result
    } catch(e) { result.fill(0);throw e }
  }
  async read(scope: string,reference: QueueContentReference,guard: () => void): Promise<Buffer> {
    const ref=this.reference(scope,reference);guard();this.current();await this.physical();guard();return this.readBytes(scope,ref,guard)
  }
  // Per-page AEAD + exact encrypted reference validation. The reader must verify
  // the assembled payload SHA256 before parsing/display; native dispatch keeps
  // using read(), which verifies all chunks and the complete content locally.
  async readChunk(scope: string,reference: QueueContentReference,offset: number,guard: () => void): Promise<Buffer> {
    const ref=this.reference(scope,reference)
    if(!Number.isSafeInteger(offset)||offset<0||offset>=ref.bytes||offset%QUEUE_CONTENT_READ_BYTES!==0)throw Error('queue_content_offset')
    guard();this.current();await this.physical();guard()
    if(!this.retained(scope,ref))throw Error('queue_content_missing')
    const db=this.current(),part=Math.floor(offset/CHUNK)
    if(db.prepare('SELECT count(*) n FROM chunks WHERE scope=? AND id=?').get(scope,ref.id)!.n!==Math.ceil(ref.bytes/CHUNK))throw Error('queue_content_chunks')
    const row=db.prepare('SELECT payload FROM chunks WHERE scope=? AND id=? AND part=?').get(scope,ref.id,part)
    const plain=this.unseal(row?.payload,scope,ref,part,CHUNK)
    try {
      if(plain.length!==Math.min(CHUNK,ref.bytes-part*CHUNK))throw Error('queue_content_chunks')
      guard();this.current();return Buffer.from(plain.subarray(offset%CHUNK,offset%CHUNK+Math.min(QUEUE_CONTENT_READ_BYTES,ref.bytes-offset)))
    } finally {plain.fill(0)}
  }
  async put(scope: string,reference: QueueContentReference,content: Buffer,guard: () => void): Promise<void> {
    const ref=this.reference(scope,reference);guard();this.current()
    if(!Buffer.isBuffer(content)||content.length!==ref.bytes)throw Error('queue_content_digest')
    const bytes=Buffer.from(content)
    try {
      if(queueContentHash(bytes)!==ref.sha256)throw Error('queue_content_digest');readQueueMessageContent(bytes)
      await this.physical();guard();const db=this.current();db.exec('BEGIN IMMEDIATE')
      try {
        if(this.retained(scope,ref)) {
          const prior=this.readBytes(scope,ref,guard);prior.fill(0);guard();this.current();db.exec('COMMIT');return
        }
        const metadata=Buffer.from(JSON.stringify(ref))
        try { db.prepare('INSERT INTO contents VALUES(?,?,?,?)').run(scope,ref.id,ref.bytes,this.seal(metadata,scope,ref,-1)) }
        finally { metadata.fill(0) }
        const insert=db.prepare('INSERT INTO chunks VALUES(?,?,?,?)')
        for(let offset=0,part=0;offset<bytes.length;offset+=CHUNK,part++) {
          guard();this.current();insert.run(scope,ref.id,part,this.seal(bytes.subarray(offset,Math.min(bytes.length,offset+CHUNK)),scope,ref,part))
        }
        this.limits();guard();this.current();db.exec('COMMIT')
      } catch(e) { db.exec('ROLLBACK');throw e }
      // A lost post-commit check is unknown to the caller; stored bytes remain.
      guard();this.current()
    } finally { bytes.fill(0) }
  }
  async remove(scope: string,reference: QueueContentReference,assertUnreferenced: () => void): Promise<void> {
    const ref=this.reference(scope,reference);assertUnreferenced();this.current();await this.physical()
    const db=this.current();db.exec('BEGIN IMMEDIATE')
    try {
      if(this.retained(scope,ref)) { assertUnreferenced();this.current();db.prepare('DELETE FROM contents WHERE scope=? AND id=?').run(scope,ref.id) }
      assertUnreferenced();this.current();db.exec('COMMIT')
    } catch(e) { db.exec('ROLLBACK');throw e }
  }
}
