export type SessionBalance =
  | { readonly status: 'available'; readonly currency: 'CNY' | 'USD'; readonly totalBalance: string }
  | { readonly status: 'unsupported' | 'not_configured' | 'credential_rejected' | 'query_failed' }

export function projectBalance(value: unknown): SessionBalance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('status' in value)) return { status: 'query_failed' }
  const keys = Object.keys(value).sort().join(',')
  if (value.status === 'available') {
    if (keys !== 'currency,status,totalBalance' || !('currency' in value) || !('totalBalance' in value)
      || (value.currency !== 'CNY' && value.currency !== 'USD')
      || typeof value.totalBalance !== 'string' || value.totalBalance.length > 26
      || !/^-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?$/.test(value.totalBalance)) return { status: 'query_failed' }
    return { status: 'available', currency: value.currency, totalBalance: value.totalBalance }
  }
  if (keys === 'status' && (value.status === 'unsupported' || value.status === 'not_configured'
    || value.status === 'credential_rejected' || value.status === 'query_failed')) return { status: value.status }
  return { status: 'query_failed' }
}
