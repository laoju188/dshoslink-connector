/** Child processes emit only an exit category; stderr and private paths are never retained. */
export const registrationFailureExit = `$native=$_.Exception.GetBaseException(); $nativeCode=$native.HResult -band 65535
if($native -is [UnauthorizedAccessException] -or $nativeCode -eq 5){exit 10}
if($nativeCode -eq 112){exit 11}
if($native -is [Security.Cryptography.CryptographicException]){exit 13}
if($native -is [IO.IOException]){exit 12}
exit 1`

export function registrationWindowsFailure(exitCode?: number | null, nativeCode?: unknown): Error {
  const code = exitCode === 10 ? 'EACCES' : exitCode === 11 ? 'ENOSPC' : exitCode === 12 ? 'EIO'
    : exitCode === 13 ? 'DSH_PROTECTION_FAILED'
    : ['EACCES', 'EPERM', 'ENOSPC', 'EIO'].includes(String(nativeCode)) ? String(nativeCode) : 'UNKNOWN'
  return new Error('registration_windows', { cause: { code } })
}

export function registrationNativeCause(error: unknown, depth = 0): string {
  if (depth > 3) return 'unknown'
  const e = error as { code?: unknown; cause?: unknown } | null
  if (['EACCES', 'EPERM'].includes(String(e?.code))) return 'access_denied'
  if (e?.code === 'ENOSPC') return 'disk_full'
  if (['EIO', 'EROFS', 'EMFILE', 'ENFILE'].includes(String(e?.code))) return 'io_failed'
  if (e?.code === 'DSH_PROTECTION_FAILED') return 'protection_failed'
  return e?.cause ? registrationNativeCause(e.cause, depth + 1) : 'unknown'
}
