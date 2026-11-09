import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

const MAX_DPAPI_OUTPUT_BYTES = 16 * 1024
const DPAPI_TIMEOUT_MS = 10_000

export class WindowsDataProtectionError extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled' | 'unavailable' | 'failed') {
    super(reason === 'unavailable' ? 'Windows CurrentUser data protection is unavailable' : 'Windows CurrentUser data protection failed')
    this.name = 'WindowsDataProtectionError'
  }
}
export interface WindowsDataProtectionOptions { readonly signal?: AbortSignal }
const PAIRING_IDENTITY_ENTROPY_LABEL = 'DSHOS-LINK/PAIRING-IDENTITY/V1'
const WEB_LAUNCH_ENTROPY_LABEL = 'DSHOS-LINK/WEB-LAUNCH/V1'
const RELAY_ROOT_KEY_ENTROPY_LABEL = 'DSHOS-LINK/RELAY-ROOT-KEY/V1'
const RELAY_CONNECTOR_CREDENTIAL_ENTROPY_LABEL =
  'DSHOS-LINK/RELAY-CONNECTOR-CREDENTIAL/V1'
const NOTIFICATION_CONNECTOR_CREDENTIAL_ENTROPY_LABEL =
  'DSHOS-LINK/CRITICAL-NOTIFICATION-CREDENTIAL/V1'

const PAIRING_IDENTITY_PROTECT_SCRIPT = dpapiScript('Protect', PAIRING_IDENTITY_ENTROPY_LABEL)
const PAIRING_IDENTITY_UNPROTECT_SCRIPT = dpapiScript('Unprotect', PAIRING_IDENTITY_ENTROPY_LABEL)
const RELAY_ROOT_KEY_PROTECT_SCRIPT = dpapiScript('Protect', RELAY_ROOT_KEY_ENTROPY_LABEL)
const RELAY_ROOT_KEY_UNPROTECT_SCRIPT = dpapiScript('Unprotect', RELAY_ROOT_KEY_ENTROPY_LABEL)
const RELAY_CONNECTOR_CREDENTIAL_PROTECT_SCRIPT = dpapiScript(
  'Protect', RELAY_CONNECTOR_CREDENTIAL_ENTROPY_LABEL,
)
const RELAY_CONNECTOR_CREDENTIAL_UNPROTECT_SCRIPT = dpapiScript(
  'Unprotect', RELAY_CONNECTOR_CREDENTIAL_ENTROPY_LABEL,
)
const NOTIFICATION_CONNECTOR_CREDENTIAL_PROTECT_SCRIPT = dpapiScript(
  'Protect', NOTIFICATION_CONNECTOR_CREDENTIAL_ENTROPY_LABEL,
)
const NOTIFICATION_CONNECTOR_CREDENTIAL_UNPROTECT_SCRIPT = dpapiScript(
  'Unprotect', NOTIFICATION_CONNECTOR_CREDENTIAL_ENTROPY_LABEL,
)

export interface WindowsCurrentUserDataProtector {
  protect(plaintext: Buffer, options?: WindowsDataProtectionOptions): Promise<Buffer>
  unprotect(ciphertext: Buffer, options?: WindowsDataProtectionOptions): Promise<Buffer>
}

function dpapiScript(operation: 'Protect' | 'Unprotect', entropyLabel: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$inputBytes = $null',
    '$resultBytes = $null',
    '$entropyBytes = $null',
    '$memory = $null',
    'try {',
    '  $memory = New-Object System.IO.MemoryStream',
    '  [Console]::OpenStandardInput().CopyTo($memory)',
    '  $inputBytes = $memory.ToArray()',
    `  $entropyBytes = [Text.Encoding]::UTF8.GetBytes('${entropyLabel}')`,
    `  $resultBytes = [Security.Cryptography.ProtectedData]::${operation}(`,
    '    $inputBytes,',
    '    $entropyBytes,',
    '    [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '  )',
    '  $output = [Console]::OpenStandardOutput()',
    '  $output.Write($resultBytes, 0, $resultBytes.Length)',
    '  $output.Flush()',
    '} catch {',
    '  exit 1',
    '} finally {',
    '  if ($memory -ne $null) { $memory.Dispose() }',
    '  if ($inputBytes -ne $null) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }',
    '  if ($resultBytes -ne $null) { [Array]::Clear($resultBytes, 0, $resultBytes.Length) }',
    '  if ($entropyBytes -ne $null) { [Array]::Clear($entropyBytes, 0, $entropyBytes.Length) }',
    '}',
  ].join('\n')
}

export function resolveTrustedWindowsPowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform !== 'win32') {
    throw new WindowsDataProtectionError('unavailable')
  }
  const systemRoot = env.SystemRoot
  if (typeof systemRoot !== 'string'
    || !/^[A-Za-z]:\\Windows$/i.test(systemRoot)
    || !win32.isAbsolute(systemRoot)) {
    throw new WindowsDataProtectionError('unavailable')
  }
  const executable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  try {
    if (!statSync(executable).isFile()
      || realpathSync.native(executable).toLowerCase() !== executable.toLowerCase()) {
      throw new Error()
    }
  } catch {
    throw new WindowsDataProtectionError('unavailable')
  }
  return executable
}

function runDpapi(powerShellPath: string, script: string, input: Buffer,
  options: WindowsDataProtectionOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new WindowsDataProtectionError('cancelled')); return }
    let child: ReturnType<typeof spawn> & { stdin: NonNullable<ReturnType<typeof spawn>['stdin']>; stdout: NonNullable<ReturnType<typeof spawn>['stdout']>; stderr: NonNullable<ReturnType<typeof spawn>['stderr']> }
    try { child = spawn(powerShellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) } catch { reject(new WindowsDataProtectionError('failed')); return }
    const chunks: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancelled)
      for (const chunk of chunks) chunk.fill(0)
      chunks.length = 0
    }
    const fail = (reason: WindowsDataProtectionError['reason'] = 'failed'): void => {
      if (settled) return
      settled = true
      cleanup()
      try { child.stdin.destroy() } catch { /* Best effort after settlement. */ }
      try { child.kill() } catch { /* Never replace the first failure. */ }
      reject(new WindowsDataProtectionError(reason))
    }
    const cancelled = (): void => fail('cancelled')
    const timer = setTimeout(() => fail('timeout'), DPAPI_TIMEOUT_MS)
    options.signal?.addEventListener('abort', cancelled, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) { chunk.fill(0); return }
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_DPAPI_OUTPUT_BYTES) {
        chunk.fill(0)
        fail()
        return
      }
      chunks.push(Buffer.from(chunk))
      chunk.fill(0)
    })
    child.stderr.resume()
    child.once('error', () => fail())
    child.once('close', code => {
      if (settled) return
      if (code !== 0 || outputBytes === 0) {
        fail()
        return
      }
      settled = true
      const output = Buffer.concat(chunks, outputBytes)
      cleanup()
      resolve(output)
    })
    child.stdin.once('error', () => fail())
    if (options.signal?.aborted) cancelled()
    if (!settled) {
      try { child.stdin.end(input) } catch { fail() }
    }
  })
}

export function createWindowsCurrentUserDataProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    PAIRING_IDENTITY_PROTECT_SCRIPT,
    PAIRING_IDENTITY_UNPROTECT_SCRIPT,
  )
}

export function createWindowsMessageQueueInitProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    dpapiScript('Protect', 'DSHOS-LINK/DSH-MESSAGE-QUEUE-INIT/V1'),
    dpapiScript('Unprotect', 'DSHOS-LINK/DSH-MESSAGE-QUEUE-INIT/V1'),
  )
}

export function createWindowsMessageQueueDataProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    dpapiScript('Protect', 'DSHOS-LINK/SESSION-MESSAGE-QUEUE/V1'),
    dpapiScript('Unprotect', 'DSHOS-LINK/SESSION-MESSAGE-QUEUE/V1'),
  )
}

export function createWindowsQueueContentInitProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    dpapiScript('Protect', 'DSHOS-LINK/QUEUE-MESSAGE-CONTENT-INIT/V1'),
    dpapiScript('Unprotect', 'DSHOS-LINK/QUEUE-MESSAGE-CONTENT-INIT/V1'),
  )
}

export function createWindowsQueueContentDataProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    dpapiScript('Protect', 'DSHOS-LINK/QUEUE-MESSAGE-CONTENT/V1'),
    dpapiScript('Unprotect', 'DSHOS-LINK/QUEUE-MESSAGE-CONTENT/V1'),
  )
}

export function createWindowsWebLaunchDataProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    dpapiScript('Protect', WEB_LAUNCH_ENTROPY_LABEL),
    dpapiScript('Unprotect', WEB_LAUNCH_ENTROPY_LABEL),
  )
}

export function createWindowsRelayRootKeyDataProtector(): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    RELAY_ROOT_KEY_PROTECT_SCRIPT,
    RELAY_ROOT_KEY_UNPROTECT_SCRIPT,
  )
}

export function createWindowsRelayConnectorCredentialDataProtector(
): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    RELAY_CONNECTOR_CREDENTIAL_PROTECT_SCRIPT,
    RELAY_CONNECTOR_CREDENTIAL_UNPROTECT_SCRIPT,
  )
}

export function createWindowsNotificationConnectorCredentialDataProtector(
): WindowsCurrentUserDataProtector {
  return createWindowsDataProtector(
    NOTIFICATION_CONNECTOR_CREDENTIAL_PROTECT_SCRIPT,
    NOTIFICATION_CONNECTOR_CREDENTIAL_UNPROTECT_SCRIPT,
  )
}

function createWindowsDataProtector(
  protectScript: string,
  unprotectScript: string,
): WindowsCurrentUserDataProtector {
  const powerShellPath = resolveTrustedWindowsPowerShellPath()
  return Object.freeze({
    protect(plaintext: Buffer, options?: WindowsDataProtectionOptions): Promise<Buffer> {
      return runDpapi(powerShellPath, protectScript, plaintext, options)
    },
    unprotect(ciphertext: Buffer, options?: WindowsDataProtectionOptions): Promise<Buffer> {
      return runDpapi(powerShellPath, unprotectScript, ciphertext, options)
    },
  })
}
