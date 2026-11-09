import { spawn } from 'node:child_process'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { resolveTrustedWindowsPowerShellPath } from './windows-dpapi.js'
import { registrationFailureExit, registrationWindowsFailure } from './registration-native-error.js'
import { registrationJson, registrationBytes } from './dsh-registration-contract.js'
import { registrationOperation, assertRegistrationOperation, registrationStep, type RegistrationRecord } from './registration-operation.js'
export interface RegistrationGuard { assertHeld(): void }
export interface RegistrationLease extends RegistrationGuard { release(): Promise<void> }
export interface RegistrationProtector { protect(bytes: Buffer): Promise<Buffer>; unprotect(bytes: Buffer): Promise<Buffer> }

export async function registrationPath(path: string): Promise<void> {
  const absolute = resolve(path)
  let part = parse(absolute).root
  for (const name of absolute.slice(part.length).split(/[\\/]/)) {
    if (!name) continue
    part = join(part, name)
    if ((await lstat(part)).isSymbolicLink()) throw Error('registration_reparse')
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw Error('registration_reparse')
}
const shellOptions = () => {
  // Windows environment keys are case-insensitive, but a spread creates a plain
  // object. Remove every spelling before pinning the trusted Windows modules.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
  env.PSModulePath = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules')
  return { shell: false as const, windowsHide: true, env }
}
function windows(script: string, input: Buffer, limit = 16384): Promise<Buffer> {
  assertRegistrationOperation()
  const operation = registrationOperation()
  if (input.length > limit) return Promise.reject(Error('registration_capacity'))
  return new Promise((resolve, reject) => {
    const child = spawn(resolveTrustedWindowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], shellOptions())
    const chunks: Buffer[] = []; let size = 0, settled = false, timedOut = false
    const finish = (ok: boolean, exitCode?: number | null, nativeCode?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); operation?.signal.removeEventListener('abort', abort)
      const output = ok ? Buffer.concat(chunks) : null
      chunks.forEach(c => c.fill(0))
      if (output) resolve(output)
      else { child.kill(); reject(operation?.signal.aborted ? Error('enrollment_cancelled') : timedOut ? Error('registration_timeout') : registrationWindowsFailure(exitCode, nativeCode)) }
    }
    const abort = () => finish(false)
    const timer = setTimeout(() => { timedOut=true;finish(false) }, Math.max(1, Math.min(10000, operation?.remaining() ?? 10000)))
    operation?.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) finish(false); else if (!settled) chunks.push(Buffer.from(chunk)) })
    child.stderr.resume(); child.once('error', (error: NodeJS.ErrnoException) => finish(false, undefined, error.code)); child.stdin.once('error', (error: NodeJS.ErrnoException) => finish(false, undefined, error.code))
    child.once('close', code => finish(code === 0 && size > 0, code)); child.stdin.end(input)
  })
}
export function registrationProtector(purpose: 'COMPUTER-REGISTRY/V1' | 'DSH-REGISTRATION/V2' | 'DSH-REGISTRATION-INTENT/V2' | 'CLOUD-PAIRING/V3' | 'SUPPORT-OUTBOX/V1' | 'COMPLETION/V1'): RegistrationProtector {
  if (!['COMPUTER-REGISTRY/V1', 'DSH-REGISTRATION/V2', 'DSH-REGISTRATION-INTENT/V2', 'CLOUD-PAIRING/V3','SUPPORT-OUTBOX/V1','COMPLETION/V1'].includes(purpose)) throw Error('registration_purpose')
  const operation = (method: 'Protect' | 'Unprotect', bytes: Buffer): Promise<Buffer> => {
    const large = purpose === 'CLOUD-PAIRING/V3'||purpose==='SUPPORT-OUTBOX/V1'
    const limit = large ? 32768 : 8192
    if (!bytes.length || bytes.length > limit) return Promise.reject(Error('registration_capacity'))
    return windows(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security
$memory=New-Object IO.MemoryStream; $bytes=$null; $result=$null
try {
 [Console]::OpenStandardInput().CopyTo($memory); $bytes=$memory.ToArray()
 $entropy=[Text.Encoding]::UTF8.GetBytes('DSHOS-LINK/${purpose}')
 $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $out=[Console]::OpenStandardOutput(); $out.Write($result,0,$result.Length); $out.Flush()
} catch { ${registrationFailureExit} } finally { $memory.Dispose(); if($null -ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)}; if($null -ne $result){[Array]::Clear($result,0,$result.Length)} }`, bytes, large ? 32768 : 16384)
  }
  return { protect: b => operation('Protect', b), unprotect: b => operation('Unprotect', b) }
}
export async function registrationDirectory(directory: string): Promise<void> {
  let parent = resolve(directory)
  for (;;) {
    try { await registrationPath(parent); break }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(parent) === parent) throw e; parent = dirname(parent) }
  }
  await mkdir(directory, { recursive: true }); await registrationPath(directory)
  await windows(`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true)
try {
 $p=[Console]::In.ReadToEnd(); $item=Get-Item -LiteralPath $p -Force
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'invalid'}
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
 $existing=Get-Acl -LiteralPath $p
 $secure=$existing.AreAccessRulesProtected -and $existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
 foreach($rule in $existing.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if($rule.IdentityReference.Value -ne $sid.Value -and $rule.IdentityReference.Value -ne 'S-1-5-18'){$secure=$false}
 }
 if($secure){[Console]::Write('ok'); exit 0}
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
 $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl',$inherit,'None','Allow'))
 Set-Acl -LiteralPath $p -AclObject $acl; [Console]::Write('ok')
} catch { ${registrationFailureExit} }`, Buffer.from(resolve(directory)))
}
export async function registrationLock(directory: string): Promise<RegistrationLease> {
  const operation = registrationOperation()
  await registrationDirectory(directory)
  const file = join(directory, 'computer-registry.guard')
  if (/[\r\n]/.test(file)) throw Error('registration_path')
  try { await registrationPath(file); const s = await lstat(file); if (!s.isFile() || s.nlink !== 1) throw Error('registration_guard') }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  assertRegistrationOperation()
  return new Promise((resolve, reject) => {
    const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true); $stream=$null
try { $p=[Console]::In.ReadLine(); $stream=[IO.File]::Open($p,'OpenOrCreate','ReadWrite','None'); [Console]::WriteLine('ready'); [Console]::Out.Flush(); $null=[Console]::In.ReadToEnd() }
catch { $code=$_.Exception.GetBaseException().HResult -band 65535; if($code -eq 32 -or $code -eq 33){[Console]::WriteLine('busy'); [Console]::Out.Flush(); exit 1}; ${registrationFailureExit} } finally { if($null -ne $stream){$stream.Dispose()} }`
    const child = spawn(resolveTrustedWindowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], shellOptions())
    let ready = false, alive = true, releasing = false, output = '', nativeCode: unknown, closedResolve!: () => void
    const closed = new Promise<void>(r => { closedResolve = r })
    const abort = () => { child.kill(); if(!ready)reject(Error('enrollment_cancelled')) }
    const timer = setTimeout(() => { child.kill(); reject(Error('registration_lock_timeout')) }, Math.max(1,Math.min(10000,operation?.remaining()??10000)))
    operation?.signal.addEventListener('abort',abort,{once:true})
    const finish = (code?: number | null) => { alive = false; clearTimeout(timer); operation?.signal.removeEventListener('abort',abort);closedResolve(); if (!ready) reject(output.trim()==='busy'?Error('registration_busy'):registrationWindowsFailure(code,nativeCode)) }
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 32) { child.kill(); return }
      if (!ready && output.trim() === 'ready') {
        ready = true; clearTimeout(timer)
        resolve({ assertHeld() { if (!alive || releasing) throw Error('registration_lock_lost') },
          async release() { releasing = true; child.stdin.end(); const end = setTimeout(() => child.kill(), 2000); await closed; clearTimeout(end) } })
      }
    })
    child.stderr.resume(); child.once('error', (error: NodeJS.ErrnoException) => { nativeCode=error.code;finish() }); child.once('close', finish)
    child.stdin.once('error', (error: NodeJS.ErrnoException) => { nativeCode=error.code;child.kill(); finish() }); child.stdin.write(file + '\n')
  })
}
export class RegistrationFile<T> {
  constructor(readonly path: string, private readonly protector: RegistrationProtector, private readonly valid: (v: unknown) => v is T,
    private readonly record: RegistrationRecord = 'recovery') {}
  async read(): Promise<T | null> {
    const present = await registrationStep(this.record, 'path', async () => {
      try { await registrationPath(this.path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
    })
    if (!present) {
      const cache = registrationOperation()?.cache
      cache?.get(this)?.cipher.fill(0); cache?.delete(this)
      return null
    }
    const bytes = await registrationStep(this.record, 'read', async () => {
    const handle = await open(this.path, 'r')
    try {
      const s = await handle.stat()
      if (!s.isFile() || s.nlink !== 1 || s.size < 1 || s.size > 16384) throw Error('registration_file')
      const buffer = Buffer.alloc(16385); let length = 0
      while (length < buffer.length) { const r = await handle.read(buffer, length, buffer.length - length, null); if (!r.bytesRead) break; length += r.bytesRead }
      if (length > 16384) throw Error('registration_capacity')
      return buffer.subarray(0, length)
    } finally { await handle.close() }
    })
    const cipher = await registrationStep(this.record, 'decode', async () => {
    const outer = registrationJson(bytes, 16384)
    if (Object.keys(outer).join(',') !== 'format,protected' || outer.format !== 1 || typeof outer.protected !== 'string') throw Error('registration_format')
    const cipher = Buffer.from(outer.protected, 'base64')
    if (!cipher.length || cipher.length > 8192 || cipher.toString('base64') !== outer.protected) throw Error('registration_format')
    return cipher
    })
    const op = registrationOperation(), previous = op?.cache.get(this)
    if (previous?.cipher.equals(cipher)) return registrationStep(this.record, 'validate', async () => {
      const value = structuredClone(previous.value); if (!this.valid(value)) throw Error('registration_format'); return value
    }, true)
    const plain = await registrationStep(this.record, 'decrypt', () => this.protector.unprotect(cipher))
    try { return await registrationStep(this.record, 'validate', async () => {
      const v = registrationJson(plain); if (!this.valid(v)) throw Error('registration_format')
      if (op) { previous?.cipher.fill(0); op.cache.set(this, { cipher: Buffer.from(cipher), value: structuredClone(v) }) }
      return v
    }) } finally { plain.fill(0) }
  }
  async write(value: T, guard: RegistrationGuard): Promise<void> {
    guard.assertHeld(); if (!this.valid(value)) throw Error('registration_format')
    await this.read(); guard.assertHeld()
    const plain = registrationBytes(value)
    if (plain.length > 4096) { plain.fill(0); throw Error('registration_capacity') }
    let cipher: Buffer
    try { cipher = await registrationStep(this.record, 'encrypt', () => this.protector.protect(plain)) } finally { plain.fill(0) }
    if (!cipher.length || cipher.length > 8192) throw Error('registration_capacity')
    await registrationStep(this.record, 'write', async () => {
      await registrationPath(dirname(this.path)); guard.assertHeld()
      const temporary = this.path + '.tmp', handle = await open(temporary, 'wx', 0o600)
      try {
        try { guard.assertHeld(); await handle.writeFile(registrationBytes({ format: 1, protected: cipher.toString('base64') })); guard.assertHeld(); await handle.sync() }
        finally { await handle.close() }
        await registrationPath(temporary); guard.assertHeld(); await rename(temporary, this.path); guard.assertHeld()
        const committed = await open(this.path, 'r+')
        try { guard.assertHeld(); await committed.sync() } finally { await committed.close() }
      } catch (e) { try { await unlink(temporary) } catch (c) { if ((c as NodeJS.ErrnoException).code !== 'ENOENT') throw c }; throw e }
    })
  }
  async remove(expected: T, guard: RegistrationGuard): Promise<void> {
    guard.assertHeld(); const current = await this.read(); guard.assertHeld()
    if (!registrationBytes(expected).equals(registrationBytes(current))) throw Error('registration_changed')
    await unlink(this.path)
  }
}
