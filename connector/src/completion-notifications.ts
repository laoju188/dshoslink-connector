import { createHash } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { CloudPairingFile } from './cloud-pairing-storage.js'
import { registrationDirectory, registrationLock, registrationProtector, type RegistrationProtector } from './dsh-registration-storage.js'

export interface CompletionProof {
  eventId: string; sessionId: string; replySeq: number; endSeq: number; completionAtMs: number
}
interface RecordValue { version: 1; proof: CompletionProof; delivered: boolean; read: boolean }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function validCompletion(v: unknown): v is CompletionProof {
  if (!v || typeof v !== 'object') return false
  const p = v as CompletionProof
  return Object.keys(p).sort().join(',') === 'completionAtMs,endSeq,eventId,replySeq,sessionId'
    && typeof p.eventId === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(p.eventId)
    && typeof p.sessionId === 'string' && p.sessionId.length > 0 && p.sessionId.length <= 256
    && Number.isSafeInteger(p.replySeq) && p.replySeq >= 0
    && Number.isSafeInteger(p.endSeq) && p.endSeq > p.replySeq
    && Number.isSafeInteger(p.completionAtMs) && p.completionAtMs >= 0
}
export function completionProof(sessionId: string, endSeq: number, turn: number,
  completionAtMs: number, replySeq: number): CompletionProof {
  const eventId = createHash('sha256').update(JSON.stringify([
    'DSHOS completion v1', sessionId, endSeq, turn, completionAtMs,
  ])).digest().subarray(0, 16).toString('base64url')
  const proof = { eventId, sessionId, replySeq, endSeq, completionAtMs }
  if (!validCompletion(proof)) throw Error('completion_invalid')
  return proof
}
const valid = (v: unknown): v is RecordValue => !!v && typeof v === 'object'
  && Object.keys(v).sort().join(',') === 'delivered,proof,read,version'
  && (v as RecordValue).version === 1 && typeof (v as RecordValue).delivered === 'boolean'
  && typeof (v as RecordValue).read === 'boolean' && validCompletion((v as RecordValue).proof)

/** Separate, protected metadata only. Never writes host sessions or pairing files.
 * A full/corrupt journal fails closed for reminders, not for chat or pairing. */
export class CompletionJournal {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly root: string,
    private readonly protector: RegistrationProtector = registrationProtector('COMPLETION/V1'),
    private readonly prepare = registrationDirectory, private readonly lock = registrationLock) {}
  private file(directory: string, id: string): CloudPairingFile<RecordValue> {
    return new CloudPairingFile(join(directory, id + '.bin'), this.protector, valid,
      (old, next) => !old || JSON.stringify(old.proof) === JSON.stringify(next.proof)
        && (!old.delivered || next.delivered) && (!old.read || next.read))
  }
  private access<T>(owner: string, run: (directory: string,
    lease: Awaited<ReturnType<typeof registrationLock>>) => Promise<T>): Promise<T> {
    const task = this.tail.then(() => this.accessLocked(owner, run))
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
  private async accessLocked<T>(owner: string, run: (directory: string,
    lease: Awaited<ReturnType<typeof registrationLock>>) => Promise<T>): Promise<T> {
    if (!owner || owner === 'null') throw Error('completion_owner_unavailable')
    const directory = join(this.root, digest(owner))
    await this.prepare(directory)
    const lease = await this.lock(directory)
    try { return await run(directory, lease) } finally { await lease.release() }
  }
  async save(owner: string, proof: CompletionProof): Promise<void> {
    if (!validCompletion(proof)) throw Error('completion_invalid')
    await this.access(owner, async (directory, lease) => {
      const file = this.file(directory, proof.eventId), old = await file.read(lease)
      if (!old) {
        let names = (await readdir(directory)).filter(f => /^[A-Za-z0-9_-]{22}\.bin$/.test(f))
        if (names.length >= 900) {
          for (const name of names) {
            const previous = await this.file(directory, name.slice(0,-4)).read(lease)
            if (previous?.read && previous.delivered && previous.proof.completionAtMs < Date.now()-86400000) {
              lease.assertHeld(); await unlink(join(directory,name)); lease.assertHeld()
            }
          }
          names = (await readdir(directory)).filter(f => /^[A-Za-z0-9_-]{22}\.bin$/.test(f))
        }
        if (names.length >= 1000) throw Error('completion_capacity')
      }
      await file.write({ version: 1, proof, delivered: old?.delivered ?? false, read: old?.read ?? false }, old, lease)
    })
  }
  async read(owner: string, ids?: readonly string[], pendingOnly = false): Promise<CompletionProof[]> {
    if (ids && (ids.length > 100 || ids.some(id => !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(id)))) throw Error('completion_ids')
    return this.access(owner, async (directory, lease) => {
      const names = ids?.map(id => id + '.bin') ?? (await readdir(directory)).filter(f => /^[A-Za-z0-9_-]{22}\.bin$/.test(f))
      if (names.length > 1000) throw Error('completion_capacity')
      const result: CompletionProof[] = []
      for (const name of names) {
        const record = await this.file(directory, name.slice(0, -4)).read(lease)
        if (record && (!pendingOnly || !record.delivered)) result.push(record.proof)
      }
      return result.sort((a, b) => a.completionAtMs - b.completionAtMs)
    })
  }
  async accepted(owner: string, id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{21}[AQgw]$/.test(id)) throw Error('completion_id')
    await this.access(owner, async (directory, lease) => {
      const file = this.file(directory, id), old = await file.read(lease)
      if (old) await file.write({ ...old, delivered: true }, old, lease)
    })
  }
  async markRead(owner: string, ids: readonly string[]): Promise<void> {
    if (ids.length>100 || ids.some(id=>!/^[A-Za-z0-9_-]{21}[AQgw]$/.test(id))) throw Error('completion_ids')
    await this.access(owner,async(directory,lease)=>{
      for(const id of ids){const file=this.file(directory,id),old=await file.read(lease)
        if(old&&!old.read)await file.write({...old,read:true},old,lease)
      }
    })
  }
}
