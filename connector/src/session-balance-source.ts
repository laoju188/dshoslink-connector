import { projectBalance, type SessionBalance } from './session-balance.js'
import { symbols, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'credentials/record-updated'(key: string): void
    'loader/volatile-update'(): void
  }
}

const FAILED: SessionBalance = { status: 'query_failed' }
const UNSUPPORTED: SessionBalance = { status: 'unsupported' }
const PROVIDERS = ['deepseek-official', 'deepseek-account'] as const
type Provider = typeof PROVIDERS[number]

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize the official decimal-string format without rounding money through Number. */
function amount(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  const match = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d{1,3}))?$/i.exec(value)
  if (match === null) return undefined
  const whole = match[2] ?? ''
  const digits = whole + (match[3] ?? match[4] ?? '')
  const point = whole.length + Number(match[5] ?? '0')
  if (Math.abs(point) > 128) return undefined
  const integer = (point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')).replace(/^0+(?=\d)/, '')
  const fraction = (point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point)).replace(/0+$/, '')
  if (integer.length > 16 || fraction.length > 8) return undefined
  return (match[1] && (integer !== '0' || fraction !== '') ? '-' : '') + integer + (fraction ? '.' + fraction : '')
}

/** Exact same-currency addition, matching the API's total available balance. */
function addAmounts(left: string, right: string): string | undefined {
  const units = (value: string): bigint => {
    const negative = value.startsWith('-')
    const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.')
    const result = BigInt(integer! + fraction.padEnd(8, '0'))
    return negative ? -result : result
  }
  const total = units(left) + units(right)
  const digits = (total < 0n ? -total : total).toString().padStart(9, '0')
  return amount((total < 0n ? '-' : '') + digits.slice(0, -8) + '.' + digits.slice(-8))
}

/** Sum current recharge and bonus wallets per currency; never convert or mix currencies. */
export function projectAccountBalance(value: unknown): SessionBalance {
  if (value === null) return { status: 'not_configured' }
  if (!object(value) || value.status !== 'ready') return FAILED
  const rows: Array<{ currency: 'CNY' | 'USD'; totalBalance: string }> = []
  for (const wallets of [value.value, value.bonusWallets]) {
    if (!Array.isArray(wallets) || wallets.length > 2) return FAILED
    const seen = new Set<string>()
    for (const row of wallets) {
      if (!object(row) || (row.currency !== 'CNY' && row.currency !== 'USD') || seen.has(row.currency)) return FAILED
      seen.add(row.currency)
      const balance = amount(row.balance)
      if (balance === undefined) return FAILED
      const existing = rows.find(item => item.currency === row.currency)
      const totalBalance = existing ? addAmounts(existing.totalBalance, balance) : balance
      if (totalBalance === undefined) return FAILED
      if (existing) existing.totalBalance = totalBalance
      else rows.push({ currency: row.currency, totalBalance })
    }
  }
  if (rows.length === 0) return FAILED
  const row = rows.find(item => item.currency === 'CNY') ?? rows[0]!
  return { status: 'available', ...row }
}

interface Flight {
  readonly revision: object
  readonly stop: AbortController
  readonly result: Promise<SessionBalance>
}
interface State {
  service: unknown
  identity: unknown
  revision: object
  flight?: Flight
}

/** Uses only host-owned, display-safe services. Never reads or forwards credentials. */
export function createSessionBalanceReader(dependencies: {
  service(provider: Provider): unknown
  client(): { version: string; locale: string; timezoneOffsetSeconds: number }
  timeoutMs?: number
}) {
  let disposed = false
  const states = new Map<Provider, State>()
  const sync = (provider: Provider): State => {
    let service: unknown
    let identity: unknown
    try {
      service = dependencies.service(provider)
      // Cordis creates a fresh contextual Proxy on every get. Only compare its body;
      // calls must still use the current Proxy to preserve the caller's context.
      identity = object(service) ? Reflect.get(service, symbols.original) ?? service : service
    } catch { service = undefined; identity = undefined }
    let state = states.get(provider)
    if (state === undefined) {
      state = { service, identity, revision: {} }
      states.set(provider, state)
    } else {
      state.service = service
      if (state.identity !== identity) {
        state.identity = identity
        state.revision = {}
        state.flight?.stop.abort()
      }
    }
    return state
  }
  const supported = (provider: string): provider is Provider => PROVIDERS.some(item => item === provider)
  const invalidate = () => {
    for (const state of states.values()) {
      state.revision = {}
      state.flight?.stop.abort()
    }
  }
  return {
    revision(provider: string): unknown { return supported(provider) ? sync(provider).revision : undefined },
    read(provider: string): Promise<SessionBalance> {
      if (disposed) return Promise.resolve(FAILED)
      if (!supported(provider)) return Promise.resolve(UNSUPPORTED)
      const state = sync(provider)
      if (state.flight !== undefined) {
        return state.flight.revision === state.revision ? state.flight.result : Promise.resolve(FAILED)
      }
      const service = state.service
      const method = provider === 'deepseek-account' ? 'getBalance' : 'read'
      if (!object(service) || typeof service[method] !== 'function') return Promise.resolve(UNSUPPORTED)
      const revision = state.revision
      const stop = new AbortController()
      let timer: ReturnType<typeof setTimeout>
      const interrupted = new Promise<SessionBalance>(resolve => {
        stop.signal.addEventListener('abort', () => resolve(FAILED), { once: true })
        timer = setTimeout(() => stop.abort(), dependencies.timeoutMs ?? 5_000)
      })
      let flight: Flight
      const work = Promise.resolve().then(async () => {
        if (stop.signal.aborted || disposed) return FAILED
        try {
          const value = provider === 'deepseek-account'
            ? await (service.getBalance as (client: ReturnType<typeof dependencies.client>) => Promise<unknown>).call(service, dependencies.client())
            : await (service.read as () => Promise<unknown>).call(service)
          if (stop.signal.aborted || disposed || sync(provider).revision !== revision) return FAILED
          return provider === 'deepseek-account' ? projectAccountBalance(value) : projectBalance(value)
        } catch { return FAILED }
      }).finally(() => {
        if (state.flight === flight) state.flight = undefined
      })
      // A timed-out host query keeps its slot until it settles. Repeated taps cannot multiply it.
      const result = Promise.race([work, interrupted]).finally(() => { clearTimeout(timer); stop.abort() })
      flight = { revision, stop, result }
      state.flight = flight
      return result
    },
    invalidate,
    dispose() { disposed = true; invalidate() },
  }
}

export function registerSessionBalanceReader(ctx: Context, version: string) {
  const reader = createSessionBalanceReader({
    service: provider => ctx.get(provider === 'deepseek-account' ? 'deepseekAccount' : 'deepseekBalance'),
    client: () => ({ version, locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }),
  })
  // Same invalidation event used by the official account service; no credential values are read.
  ctx.on('credentials/record-updated', () => reader.invalidate())
  ctx.on('loader/volatile-update', () => reader.invalidate())
  // A service can be unloaded and re-provided with the same body between reads.
  ctx.on('internal/service', name => {
    if (name === 'deepseekAccount' || name === 'deepseekBalance') reader.invalidate()
  })
  ctx.effect(() => () => reader.dispose(), 'dshos-link-session-balance')
  return reader
}
