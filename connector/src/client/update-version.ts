// Browser-safe comparison shared with the host.
/** Compare stable releases numerically. Never upgrade channels or suggest a downgrade. */
export function isNewerStableVersion(current: string, latest: string): boolean {
  const pattern = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})(?![\s\S])/
  if (!pattern.test(current) || !pattern.test(latest)) return false
  const a = current.split('.').map(Number), b = latest.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i]! > a[i]!
  return false
}

