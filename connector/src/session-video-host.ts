import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { win32 } from 'node:path'
import type { AudioSourceReference } from './session-audio-contract.js'
import { closedOutputLease, type OutputLease } from './session-output-lease.js'
import type { VideoFile } from './session-video.js'

const samePath = (a: string, b: string) => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase()
const sameFile = (a: BigIntStats, b: BigIntStats) => b.isFile() && !b.isSymbolicLink() &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** Keep the source's Windows read lease and descriptor for the whole preview. */
export async function openHostVideo(ctx: Context, source: AudioSourceReference, check: () => void): Promise<VideoFile> {
  const attachments = ctx.get('attachments') as unknown as { fileHostPath?(ref: unknown): string } | undefined
  const path = source.attachment ? attachments?.fileHostPath?.(source.attachment) : source.file
  const fs = ctx.get('fs') as unknown as {
    resolve(path: string): Promise<unknown>
    processPath(ref: unknown): string
    stat(ref: unknown): Promise<{ type: string; size?: number } | undefined>
  } | undefined
  if (typeof path !== 'string' || !/^[a-z]:[\\/]/i.test(path) || path.slice(2).includes(':') || !fs?.processPath)
    throw Error('video_unavailable')
  const resolved = await fs.resolve(path)
  check()
  const fact = await fs.stat(resolved)
  check()
  if (fact?.type !== 'file' || !samePath(fs.processPath(resolved), path) || !samePath(await realpath(path), path))
    throw Error('video_unavailable')
  const named = await lstat(path, { bigint: true })
  check()
  if (!named.isFile() || named.isSymbolicLink() || named.ino === 0n || Number(named.size) !== fact.size)
    throw Error('video_unavailable')
  let lease: OutputLease | undefined
  let handle: FileHandle | undefined
  try {
    lease = await closedOutputLease(path)
    check()
    handle = await open(path, 'r')
    check()
    const original = await handle.stat({ bigint: true })
    const verifyPath = async (): Promise<void> => {
      const current = await lstat(path, { bigint: true })
      if (!sameFile(named, current) || !samePath(await realpath(path), path)) throw Error('video_changed')
    }
    await verifyPath()
    check()
    lease.assertHeld()
    if (!sameFile(named, original) || !Number.isSafeInteger(Number(original.size))) throw Error('video_changed')
    const locked = lease, file = handle
    const revision = createHash('sha256').update([original.dev, original.ino, original.size, original.mtimeNs,
      original.ctimeNs, original.birthtimeNs].join(':')).digest('hex')
    lease = undefined
    handle = undefined
    return {
      bytes: Number(original.size),
      revision,
      async read(offset, length, current) {
        locked.assertHeld()
        current()
        const data = Buffer.alloc(length)
        try {
          let read = 0
          while (read < length) {
            const part = await file.read(data, read, length - read, offset + read)
            current()
            locked.assertHeld()
            if (!part.bytesRead) throw Error('video_changed')
            read += part.bytesRead
          }
          if (!sameFile(original, await file.stat({ bigint: true }))) throw Error('video_changed')
          await verifyPath()
          current()
          locked.assertHeld()
          return data
        } catch (error) { data.fill(0); throw error }
      },
      async close() { try { await file.close() } finally { await locked.release() } },
    }
  } finally { try { await handle?.close() } finally { await lease?.release() } }
}
