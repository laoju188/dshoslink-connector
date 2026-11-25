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

/** Adapt a validated amount to the numeric two-decimal balance field on existing phones. */
export function displayBalance(balance: SessionBalance, rc5Account = false): SessionBalance {
  if (balance.status !== 'available') return balance
  const negative = balance.totalBalance.startsWith('-')
  const [whole, fraction = ''] = (negative ? balance.totalBalance.slice(1) : balance.totalBalance).split('.')
  let cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
  // The rc.5 account UI truncates positive money, rounds debts, and shows
  // nonzero sub-cent debts as -0.01. The old phone field cannot carry "<0.01".
  if ((!rc5Account || negative) && (fraction[2] ?? '0') >= '5') cents++
  if (rc5Account && negative && cents === 0n && /[1-9]/.test(fraction)) cents = 1n
  const digits = cents.toString().padStart(3, '0')
  if (digits.length > 18) return { status: 'query_failed' }
  const totalBalance = (negative && cents !== 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2)
  return { status: 'available', currency: balance.currency, totalBalance }
}
