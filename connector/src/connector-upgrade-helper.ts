import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_LEGACY_HELPERS } from './connector-upgrade-legacy.js'

/** Only replace the exact helper we shipped. Preserve modified or unknown bundles. */
export function isKnownLegacyHelper(profileDir: string, version: string | undefined): boolean {
  const expected = version ? KNOWN_LEGACY_HELPERS[version] : undefined
  if (!expected) return false
  const root = join(profileDir, 'node_modules', '@dshos-link', 'connector-updater')
  const actual: Record<string, string> = {}
  try {
    const walk = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir)) {
        if (!prefix && entry === 'node_modules') continue
        const path = join(dir, entry), name = prefix + entry, stat = lstatSync(path)
        if (stat.isSymbolicLink()) throw Error('linked-helper-file')
        if (stat.isDirectory()) walk(path, name + '/')
        else if (stat.isFile()) actual[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
        else throw Error('unknown-helper-file')
      }
    }
    walk(root)
    return expected.some(files => Object.keys(actual).length === Object.keys(files).length
      && Object.entries(files).every(([name, digest]) => actual[name] === digest)
    )
  } catch { return false }
}

export type HelperCoordinator = {
  pending: unknown
  io: { read(): { phase: string; needsRecovery?: boolean } | null; exclusive<T>(work: () => Promise<T>): Promise<T> }
}

export function helperCanMigrate(coordinator: HelperCoordinator): boolean {
  if (coordinator.pending) return false
  const job = coordinator.io.read()
  return job === null || (['succeeded', 'restored', 'failed'].includes(job.phase) && job.needsRecovery === false)
}

/** A host-rejected helper has no service. Keep its journal and use the same
 * <operation.json>.lock protocol as the official helper, without stealing locks. */
export async function withInactiveHelperLock<T>(profileDir: string, work: () => Promise<T>): Promise<T> {
  const root=join(profileDir,'.dshos-link','plugin-updater-v1');mkdirSync(root,{recursive:true})
  const file=join(root,'operation.json.lock'),record=`${process.pid}\n`
  const fd=openSync(file,'wx',0o600)
  try { writeFileSync(fd,record);fsyncSync(fd) } finally { closeSync(fd) }
  try { return await work() } finally {
    const stat=lstatSync(file)
    if(stat.isFile()&&!stat.isSymbolicLink()&&readFileSync(file,'utf8')===record)unlinkSync(file)
  }
}

export function inactiveHelperCanMigrate(profileDir: string): boolean {
  try {
    const file=join(profileDir,'.dshos-link','plugin-updater-v1','operation.json'),stat=lstatSync(file)
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)return false
    const job=JSON.parse(readFileSync(file,'utf8'))
    return Boolean(job&&!Array.isArray(job)&&['succeeded','restored','failed'].includes(job.phase)&&job.needsRecovery===false
      && ['previousVersion','targetVersion'].every(key=>job[key]===undefined||job[key]===''||(typeof job[key]==='string'&&/^\d+\.\d+\.\d+$/.test(job[key])))
      && (job.reason===undefined||typeof job.reason==='string')&&(job.restoring===undefined||typeof job.restoring==='boolean'))
  } catch(error) { return (error as NodeJS.ErrnoException).code==='ENOENT' }
}
