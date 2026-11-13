import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { resolveTrustedWindowsPowerShellPath } from './windows-dpapi.js'
import { registrationFailureExit, registrationWindowsFailure } from './registration-native-error.js'
import type { RegistrationProtector } from './dsh-registration-storage.js'

const MAX_INPUT = 8192, MAX_OUTPUT = 16384
// One short-lived worker per locked completion operation. The entropy and wire
// files are unchanged; no persistent plaintext cache or shared pairing worker.
const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security
$entropy=[Text.Encoding]::UTF8.GetBytes('DSHOS-LINK/COMPLETION/V1')
try {
 for($n=0;$n -lt 4096;$n++) {
  $line=[Console]::In.ReadLine(); if($null -eq $line){break}
  $bytes=$null; $result=$null
  try {
   if($line.Length -lt 5 -or $line.Length -gt 10925){throw 'invalid'}
   $bytes=[Convert]::FromBase64String($line.Substring(1))
   if($bytes.Length -lt 1 -or $bytes.Length -gt 8192){throw 'invalid'}
   if($line[0] -eq 'P'){$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
   elseif($line[0] -eq 'U'){$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
   else{throw 'invalid'}
   if($result.Length -lt 1 -or $result.Length -gt 16384){throw 'invalid'}
   [Console]::WriteLine([Convert]::ToBase64String($result)); [Console]::Out.Flush()
  } finally {
   if($null -ne $bytes){[Array]::Clear($bytes,0,$bytes.Length)}
   if($null -ne $result){[Array]::Clear($result,0,$result.Length)}
   $line=$null
  }
 }
} catch { ${registrationFailureExit} } finally { [Array]::Clear($entropy,0,$entropy.Length) }`

export function completionProtection(signal?: AbortSignal): {
  protector: RegistrationProtector; dispose(): Promise<void>
} {
  let child: ReturnType<typeof spawn> | undefined, ended: Promise<void> | undefined
  let failure: Error | undefined, disposed = false, calls = 0
  let pending: { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  let output = Buffer.alloc(0)
  const clearOutput = () => { output.fill(0); output = Buffer.alloc(0) }
  const fail = (error: Error) => {
    failure ??= error
    clearOutput()
    if (pending) { const p = pending; pending = undefined; clearTimeout(p.timer); p.reject(failure) }
    child?.stdin?.destroy(); child?.kill()
  }
  const abort = () => fail(Error('completion_cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  const start = () => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
    env.PSModulePath = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules')
    child = spawn(resolveTrustedWindowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] })
    ended = new Promise<void>(resolve => {
      child!.once('close', code => { if (!disposed || pending) fail(registrationWindowsFailure(code)); resolve() })
    })
    child.once('error', (e: NodeJS.ErrnoException) => fail(registrationWindowsFailure(undefined, e.code)))
    child.stdin!.once('error', (e: NodeJS.ErrnoException) => { if (!disposed) fail(registrationWindowsFailure(undefined, e.code)) })
    child.stderr!.resume()
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure || disposed) { chunk.fill(0); return }
      if (!pending || output.length + chunk.length > Math.ceil(MAX_OUTPUT / 3) * 4 + 2) {
        chunk.fill(0); fail(Error('registration_capacity')); return
      }
      const next = Buffer.concat([output, chunk]); output.fill(0); chunk.fill(0); output = next
      const newline = output.indexOf(10)
      if (newline < 0) return
      const text = output.subarray(0, newline).toString('ascii').replace(/\r$/, '')
      const value = Buffer.from(text, 'base64')
      if (newline !== output.length - 1 || !value.length || value.length > MAX_OUTPUT || value.toString('base64') !== text) {
        value.fill(0); fail(Error('registration_format')); return
      }
      const p = pending; pending = undefined; clearTimeout(p.timer); clearOutput(); p.resolve(value)
    })
  }
  const run = (method: 'P' | 'U', bytes: Buffer): Promise<Buffer> => {
    if (signal?.aborted) abort()
    if (disposed || failure) return Promise.reject(failure ?? Error('completion_protector_closed'))
    if (!bytes.length || bytes.length > MAX_INPUT) return Promise.reject(Error('registration_capacity'))
    if (pending || ++calls > 4096) { fail(Error('completion_protector_busy')); return Promise.reject(failure!) }
    try { if (!child) start() } catch (e) { fail(e instanceof Error ? e : Error('registration_failed')); return Promise.reject(failure!) }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject, timer: setTimeout(() => fail(Error('registration_timeout')), 10000) }
      const input = Buffer.from(method + bytes.toString('base64') + '\n')
      child!.stdin!.write(input, error => { input.fill(0); if (error && !disposed) fail(registrationWindowsFailure(undefined, (error as NodeJS.ErrnoException).code)) })
    })
  }
  return {
    protector: { protect: b => run('P', b), unprotect: b => run('U', b) },
    async dispose() {
      disposed = true; signal?.removeEventListener('abort', abort)
      if (pending) fail(Error('completion_protector_closed'))
      clearOutput(); child?.stdin?.end()
      if (child && ended) {
        const timer = setTimeout(() => child?.kill(), 1000)
        try { await ended } finally { clearTimeout(timer) }
      }
    },
  }
}
