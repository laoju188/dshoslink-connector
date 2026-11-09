// Compiled into the DSH provider, never imported by the connector request handler.
export type BalanceResult =
  | { status: 'available'; currency: 'CNY' | 'USD'; totalBalance: string }
  | { status: 'unsupported' | 'not_configured' | 'credential_rejected' | 'query_failed' }

export const BALANCE_TIMEOUT_MS = 5_000
export const BALANCE_MAX_BYTES = 16_384

interface Connection { baseURL: string }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function officialEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL)
    return url.origin === 'https://api.deepseek.com' && url.username === ''
      && url.password === '' && url.search === '' && url.hash === ''
      && ['/', '/v1', '/v1/', '/anthropic', '/anthropic/'].includes(url.pathname)
  } catch { return false }
}

function amount(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 26
    && /^-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?$/.test(value)
}

export function parseBalance(value: unknown): BalanceResult {
  if (!object(value) || typeof value.is_available !== 'boolean'
    || !Array.isArray(value.balance_infos) || value.balance_infos.length < 1
    || value.balance_infos.length > 2) return { status: 'query_failed' }
  const rows: { currency: 'CNY' | 'USD'; totalBalance: string }[] = []
  for (const row of value.balance_infos) {
    if (!object(row) || (row.currency !== 'CNY' && row.currency !== 'USD')
      || !amount(row.total_balance) || !amount(row.granted_balance)
      || !amount(row.topped_up_balance)
      || rows.some(item => item.currency === row.currency)) return { status: 'query_failed' }
    rows.push({ currency: row.currency, totalBalance: row.total_balance })
  }
  // Never add balances in different currencies. Prefer CNY when both exist.
  const row = rows.find(item => item.currency === 'CNY') ?? rows[0]!
  return { status: 'available', currency: row.currency, totalBalance: row.totalBalance }
}

export function createBalanceReader<T extends Connection>(dependencies: {
  options(): T
  resolveApiKey(connection: T): Promise<string>
  fetch?: typeof fetch
  timeoutMs?: number
}): { read(): Promise<BalanceResult>; dispose(): void } {
  let disposed = false
  let running: AbortController | undefined
  const fetchBalance = dependencies.fetch ?? fetch
  return {
    async read(): Promise<BalanceResult> {
      if (disposed || running !== undefined) return { status: 'query_failed' }
      const controller = new AbortController()
      running = controller
      let timer: ReturnType<typeof setTimeout> | undefined
      const interrupted = new Promise<BalanceResult>(resolve => {
        controller.signal.addEventListener('abort', () => resolve({ status: 'query_failed' }), { once: true })
        timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? BALANCE_TIMEOUT_MS)
      })
      const operation = async (): Promise<BalanceResult> => {
        try {
          const connection = dependencies.options()
          if (!officialEndpoint(connection.baseURL)) return { status: 'unsupported' }
          let key: string
          try { key = await dependencies.resolveApiKey(connection) } catch (error) {
            return { status: object(error) && error.code === 'MISSING_CREDENTIAL'
              ? 'not_configured' : 'query_failed' }
          }
          if (controller.signal.aborted || disposed || dependencies.options() !== connection) {
            return { status: 'query_failed' }
          }
          const response = await fetchBalance('https://api.deepseek.com/user/balance', {
            method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            redirect: 'error', signal: controller.signal,
          })
          if (controller.signal.aborted) {
            await response.body?.cancel().catch(() => undefined)
            return { status: 'query_failed' }
          }
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined)
            return { status: response.status === 401 || response.status === 403
              ? 'credential_rejected' : 'query_failed' }
          }
          if (response.body === null) return { status: 'query_failed' }
          const reader = response.body.getReader()
          const decoder = new TextDecoder('utf-8', { fatal: true })
          let text = ''
          let size = 0
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.byteLength
              if (size > BALANCE_MAX_BYTES || controller.signal.aborted) return { status: 'query_failed' }
              text += decoder.decode(chunk.value, { stream: true })
            }
            text += decoder.decode()
          } finally { await reader.cancel().catch(() => undefined) }
          if (disposed || controller.signal.aborted || dependencies.options() !== connection) {
            return { status: 'query_failed' }
          }
          if (await dependencies.resolveApiKey(connection) !== key || disposed
            || controller.signal.aborted || dependencies.options() !== connection) {
            return { status: 'query_failed' }
          }
          return parseBalance(JSON.parse(text))
        } catch { return { status: 'query_failed' } }
      }
      const work = operation().finally(() => { if (running === controller) running = undefined })
      try { return await Promise.race([work, interrupted]) } finally {
        clearTimeout(timer)
        controller.abort()
        // Busy remains set until non-cooperative dependencies settle as well.
      }
    },
    dispose() { disposed = true; running?.abort() },
  }
}
