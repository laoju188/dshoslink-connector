import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionBalanceReader, projectAccountBalance, registerSessionBalanceReader } from '../src/session-balance-source.js'
import { Context } from '@deepseek-ai/cordis'
import { createSessionUsageRequestHandler } from '../src/session-usage.js'

const client = () => ({ version: '0.2.1-rc.2', locale: 'zh-CN', timezoneOffsetSeconds: 28800 })
const ready = (balance = '12.50', currency = 'CNY') => ({
  status: 'ready', value: [{ currency, balance }], bonusWallets: [],
})
const available = (totalBalance: string, currency = 'CNY') => ({ status: 'available', currency, totalBalance })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

test('official account available balance includes same-currency bonuses without private fields', () => {
  assert.deepEqual(projectAccountBalance({ ...ready(), bonusWallets: [{currency:'CNY',balance:'500'}], private: 'must-not-leak' }), available('512.5'))
  assert.deepEqual(projectAccountBalance({ status: 'ready', value: [
    { currency: 'USD', balance: '100' }, { currency: 'CNY', balance: '2.5' },
  ], bonusWallets: [] }), available('2.5'))
  assert.deepEqual(projectAccountBalance(ready('1.25', 'USD')), available('1.25', 'USD'))
})

test('decimal conversion is exact, including zero, debt and scientific notation', () => {
  for (const [input, output] of [
    ['0', '0'], ['-0.000', '0'], ['.50', '0.5'], ['-01.200', '-1.2'],
    ['1e2', '100'], ['12.5e-1', '1.25'], ['1e-8', '0.00000001'],
    ['9007199254740993.12345678', '9007199254740993.12345678'],
  ]) assert.deepEqual(projectAccountBalance(ready(input)), available(output!))
})

test('only the rc.5 account route adapts higher precision wallet amounts to the phone', async () => {
  const account = { getBalance: async () => ready('37.586123456') }
  const read = async (version: string, hostKind: 'desktop' | 'web') => {
    const ctx = new Context()
    ctx.provide('deepseekAccount', account)
    const reader = registerSessionBalanceReader(ctx, version, hostKind)
    try { return await reader.read('deepseek-account') } finally { await ctx.fiber.dispose() }
  }
  assert.equal((await read('0.2.2-rc.5', 'desktop')).status, 'available')
  assert.deepEqual(await read('0.2.2-rc.3', 'desktop'), { status: 'query_failed' })
  assert.deepEqual(await read('0.2.2-rc.5', 'web'), { status: 'query_failed' })
})

test('missing and invalid account money never become a zero balance', () => {
  for (const value of [undefined, {}, { status: 'failed' }, { status: 'ready', value: [] },
    ready('NaN'), ready('Infinity'), ready('1e999'), ready('0.000000001'), ready('1', 'XXX'),
    ready('10000000000000000'), { status: 'ready', value: [{ currency: 'CNY', balance: 12 }] },
    { status: 'ready', value: [{ currency: 'CNY', balance: '1' }, { currency: 'CNY', balance: '2' }] },
  ]) assert.deepEqual(projectAccountBalance(value), { status: 'query_failed' })
  assert.deepEqual(projectAccountBalance(null), { status: 'not_configured' })
})

test('both routes use only their own safe host service and preserve its this binding', async () => {
  let accountCalls = 0, apiCalls = 0
  const account = { async getBalance(c: unknown) { assert.equal(this, account); assert.deepEqual(c, client()); accountCalls++; return ready() } }
  const api = { async read() { assert.equal(this, api); apiCalls++; return available('7.25') } }
  const reader = createSessionBalanceReader({ client, service: p => p === 'deepseek-account' ? account : api })
  for (const provider of ['deepseek-official', 'deepseek-account', 'deepseek-official', 'deepseek-account']) {
    assert.deepEqual(await reader.read(provider), available(provider === 'deepseek-account' ? '12.5' : '7.25'))
  }
  assert.equal(accountCalls, 2); assert.equal(apiCalls, 2)
  reader.dispose()
})

test('unavailable/old host service and unsupported providers remain explicit', async () => {
  const reader = createSessionBalanceReader({ client, service: () => undefined })
  for (const p of ['deepseek-official', 'deepseek-account', 'other']) assert.deepEqual(await reader.read(p), { status: 'unsupported' })
  reader.dispose(); assert.deepEqual(await reader.read('deepseek-account'), { status: 'query_failed' })
})

test('simultaneous conversations share one in-flight query but never completed cached money', async () => {
  const gate = deferred<unknown>(); let calls = 0, amount = '3'
  const account = { async getBalance() { calls++; return calls === 1 ? gate.promise : ready(amount) } }
  const reader = createSessionBalanceReader({ client, service: () => account })
  const a = reader.read('deepseek-account'), b = reader.read('deepseek-account')
  await Promise.resolve(); assert.equal(calls, 1)
  gate.resolve(ready('2')); assert.deepEqual(await Promise.all([a, b]), [available('2'), available('2')])
  amount = '4'; assert.deepEqual(await reader.read('deepseek-account'), available('4')); assert.equal(calls, 2)
  reader.dispose()
})

test('credential change discards the in-flight balance and next read uses the new account', async () => {
  const gate = deferred<unknown>(); let calls = 0
  const service = { async getBalance() { return ++calls === 1 ? gate.promise : ready('8') } }
  const reader = createSessionBalanceReader({ client, service: () => service })
  const previous = reader.revision('deepseek-account'), pending = reader.read('deepseek-account')
  await Promise.resolve(); reader.invalidate()
  assert.notEqual(reader.revision('deepseek-account'), previous)
  assert.deepEqual(await pending, { status: 'query_failed' })
  gate.resolve(ready('99')); await new Promise(r => setImmediate(r))
  assert.deepEqual(await reader.read('deepseek-account'), available('8'))
  reader.dispose()
})

test('service replacement discards old results without cross-provider leakage', async () => {
  const gate = deferred<unknown>()
  let account = { async getBalance(): Promise<unknown> { return gate.promise } }
  const api = { async read() { return available('40') } }
  const reader = createSessionBalanceReader({ client, service: p => p === 'deepseek-account' ? account : api })
  const pending = reader.read('deepseek-account'); await Promise.resolve()
  account = { async getBalance() { return ready('4') } }; reader.revision('deepseek-account')
  assert.deepEqual(await pending, { status: 'query_failed' })
  assert.deepEqual(await reader.read('deepseek-official'), available('40'))
  gate.resolve(ready('99')); await new Promise(r => setImmediate(r))
  assert.deepEqual(await reader.read('deepseek-account'), available('4')); reader.dispose()
})

test('timeout is bounded and repeated reads do not multiply a non-cooperative host query', async () => {
  const gate = deferred<unknown>(); let calls = 0
  const service = { async getBalance() { calls++; return gate.promise } }
  const reader = createSessionBalanceReader({ client, service: () => service, timeoutMs: 15 })
  assert.deepEqual(await reader.read('deepseek-account'), { status: 'query_failed' })
  for (let i = 0; i < 6; i++) assert.deepEqual(await reader.read('deepseek-account'), { status: 'query_failed' })
  assert.equal(calls, 1); gate.resolve(ready('500')); await new Promise(r => setImmediate(r))
  reader.dispose()
})

test('query errors, signed-out state and disposal return safe status only', async () => {
  for (const method of [async () => { throw Error('private upstream data') }, async () => null, async () => ({ status: 'failed' })]) {
    const reader = createSessionBalanceReader({ client, service: () => ({ getBalance: method }) })
    const value = await reader.read('deepseek-account')
    assert.notEqual(value.status, 'available'); assert.equal(JSON.stringify(value).includes('private'), false)
    reader.dispose()
  }
  const gate = deferred<unknown>(), service = { getBalance: () => gate.promise }
  const reader = createSessionBalanceReader({ client, service: () => service })
  const pending = reader.read('deepseek-account'); await Promise.resolve(); reader.dispose()
  assert.deepEqual(await pending, { status: 'query_failed' }); gate.resolve(ready())
})

test('credential switch after balance resolves but before final model check cannot return stale money', async () => {
  const service = { async getBalance() { return ready('99') } }
  const reader = createSessionBalanceReader({ client, service: () => service })
  let modelCalls = 0
  const handler = createSessionUsageRequestHandler({ authorize: () => true }, {
    async history(r) { return { rpcId: r.rpcId, result: { ok: true, value: { events: [], hasMore: false } } } },
    async models(r) {
      if (++modelCalls === 2) reader.invalidate()
      return { rpcId: r.rpcId, result: { ok: true, value: { current: { provider: 'deepseek-account', model: 'deepseek-flash' }, routable: true, groups: [], failures: [] } } }
    },
    balance: p => reader.read(p), balanceRevision: p => reader.revision(p),
  })
  const response = await handler({ method: 'POST', path: '/dshos/v1/session-usage', contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ type: 'session_usage_request', protocolVersion: 2, sessionId: 'a' })) })
  assert.deepEqual(response, { status: 409, body: '' }); reader.dispose()
})

test('real Cordis host wiring invalidates both routes on credential/config events', async () => {
  const ctx = new Context()
  ctx.provide('deepseekBalance', { async read() { return available('1') } })
  ctx.provide('deepseekAccount', { async getBalance(c: unknown) {
    assert.equal((c as { version: string }).version, '0.2.1-rc.2'); return ready('2')
  } })
  const reader = registerSessionBalanceReader(ctx, '0.2.1-rc.2')
  assert.deepEqual(await reader.read('deepseek-official'), available('1'))
  assert.deepEqual(await reader.read('deepseek-account'), available('2'))
  for (const event of ['credentials/record-updated', 'loader/volatile-update'] as const) {
    const api = reader.revision('deepseek-official'), account = reader.revision('deepseek-account')
    if (event === 'credentials/record-updated') ctx.emit(event, 'test-credential-key')
    else ctx.emit(event)
    assert.notEqual(reader.revision('deepseek-official'), api)
    assert.notEqual(reader.revision('deepseek-account'), account)
  }
  await ctx.fiber.dispose()
  assert.deepEqual(await reader.read('deepseek-account'), { status: 'query_failed' })
})
