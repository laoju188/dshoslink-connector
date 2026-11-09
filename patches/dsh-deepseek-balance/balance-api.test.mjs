import assert from 'node:assert/strict'
import test from 'node:test'
import { createBalanceReader, parseBalance, BALANCE_MAX_BYTES } from './balance-api.ts'

const payload = (total = '12.3400', currency = 'CNY') => ({
  is_available: true,
  balance_infos: [{ currency, total_balance: total, granted_balance: '0.00', topped_up_balance: total }],
})
function fixture(overrides = {}) {
  const connection = { baseURL: 'https://api.deepseek.com' }
  let calls = 0
  const reader = createBalanceReader({
    options: () => connection,
    resolveApiKey: async () => 'fake-test-key',
    fetch: async (url, init) => {
      calls++
      assert.equal(url, 'https://api.deepseek.com/user/balance')
      assert.equal(init.redirect, 'error')
      assert.equal(init.method, 'GET')
      assert.equal(init.headers.Authorization, 'Bearer fake-test-key')
      return Response.json(payload())
    },
    ...overrides,
  })
  return { reader, connection, calls: () => calls }
}

test('preserves decimal amounts and zero/negative balances without floating point', () => {
  for (const total of ['0.00', '-0.01', '9999999999999999.12345678', '12.3400']) {
    assert.deepEqual(parseBalance(payload(total)), { status: 'available', currency: 'CNY', totalBalance: total })
  }
  const data = payload('4.20', 'USD')
  data.is_available = false
  assert.deepEqual(parseBalance(data), { status: 'available', currency: 'USD', totalBalance: '4.20' })
})

test('rejects malformed, duplicate, oversized and non-decimal amounts', () => {
  for (const total of [0, null, 'NaN', '1e3', '01.0', '1\n', '1.123456789', '9'.repeat(40)]) {
    assert.deepEqual(parseBalance(payload(total)), { status: 'query_failed' })
  }
  for (const data of [null, {}, { ...payload(), is_available: 1 }, payload('1', 'XXX'),
    { ...payload(), balance_infos: [] }, { ...payload(), balance_infos: [...payload().balance_infos, ...payload().balance_infos] }]) {
    assert.deepEqual(parseBalance(data), { status: 'query_failed' })
  }
})

test('selects CNY rather than adding different currencies and drops private extra fields', () => {
  const data = { ...payload(), key: 'private', balance_infos: [...payload('8', 'USD').balance_infos, ...payload('2').balance_infos] }
  assert.deepEqual(parseBalance(data), { status: 'available', currency: 'CNY', totalBalance: '2' })
})

test('queries only official endpoint and exposes only normalized result', async () => {
  const f = fixture()
  assert.deepEqual(await f.reader.read(), { status: 'available', currency: 'CNY', totalBalance: '12.3400' })
  assert.equal(f.calls(), 1)
  for (const baseURL of ['http://api.deepseek.com', 'https://evil.example', 'https://api.deepseek.com:444',
    'https://api.deepseek.com@evil.example', 'https://api.deepseek.com/proxy', 'https://api.deepseek.com/?x=1']) {
    let credentials = 0
    const f = fixture({ options: () => ({ baseURL }), resolveApiKey: async () => { credentials++; return 'fake' } })
    assert.deepEqual(await f.reader.read(), { status: 'unsupported' })
    assert.equal(credentials, 0)
    assert.equal(f.calls(), 0)
  }
})

test('Messages and OpenAI official base paths use the fixed balance endpoint', async () => {
  for (const path of ['/anthropic', '/anthropic/', '/v1', '/v1/', '/']) {
    const connection = { baseURL: 'https://api.deepseek.com' + path }
    const f = fixture({ options: () => connection })
    assert.deepEqual(await f.reader.read(), { status: 'available', currency: 'CNY', totalBalance: '12.3400' }, path)
    assert.equal(f.calls(), 1)
    f.reader.dispose()
  }
})

test('Messages lookalikes never resolve credentials or make a balance request', async () => {
  for (const baseURL of ['https://api.deepseek.com/anthropic/proxy', 'https://api.deepseek.com/anthropic?x=1',
    'https://api.deepseek.com/anthropic#x', 'https://user:pass@api.deepseek.com/anthropic',
    'https://api.deepseek.com.evil.example/anthropic', 'https://api.deepseek.com/anthropic%2f']) {
    const connection = { baseURL }
    let credentials = 0
    const f = fixture({ options: () => connection, resolveApiKey: async () => { credentials++; return 'fake' } })
    assert.deepEqual(await f.reader.read(), { status: 'unsupported' })
    assert.equal(credentials, 0)
    assert.equal(f.calls(), 0)
    f.reader.dispose()
  }
})

test('normalizes credentials and upstream errors without exporting raw text', async () => {
  const missing = fixture({ resolveApiKey: async () => { throw Object.assign(new Error('secret'), { code: 'MISSING_CREDENTIAL' }) } })
  assert.deepEqual(await missing.reader.read(), { status: 'not_configured' })
  for (const status of [301, 401, 403, 429, 500]) {
    const f = fixture({ fetch: async () => new Response('secret', { status }) })
    assert.deepEqual(await f.reader.read(), { status: [401, 403].includes(status) ? 'credential_rejected' : 'query_failed' })
  }
  const f = fixture({ fetch: async () => { throw new Error('secret') } })
  assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
})

test('caps streamed response bytes and rejects malformed UTF8/JSON', async () => {
  for (const body of [' '.repeat(BALANCE_MAX_BYTES + 1), '{broken', new Uint8Array([0xff])]) {
    const f = fixture({ fetch: async () => new Response(body) })
    assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
  }
})

test('timeout includes credential resolution and keeps at most one unresolved operation', async () => {
  let calls = 0
  const f = fixture({ timeoutMs: 15, resolveApiKey: async () => { calls++; return new Promise(() => {}) } })
  assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
  assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
  assert.equal(calls, 1)
  assert.equal(f.calls(), 0)
})

test('disposal cancels pending reads and prevents later queries', async () => {
  let pending
  const f = fixture({ resolveApiKey: () => new Promise(resolve => { pending = resolve }) })
  const read = f.reader.read()
  f.reader.dispose()
  assert.deepEqual(await read, { status: 'query_failed' })
  pending('fake-test-key')
  await Promise.resolve()
  assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
  assert.equal(f.calls(), 0)
})

test('does not send a key after the configuration snapshot changes', async () => {
  let connection = { baseURL: 'https://api.deepseek.com' }
  const f = fixture({ options: () => connection, resolveApiKey: async () => {
    connection = { baseURL: 'https://api.deepseek.com/v1' }
    return 'fake-test-key'
  } })
  assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
  assert.equal(f.calls(), 0)
})

test('discards a response when the credential changes during the request', async () => {
  let key = 'before'
  const f = fixture({ resolveApiKey: async () => key, fetch: async () => { key = 'after'; return Response.json(payload()) } })
  assert.deepEqual(await f.reader.read(), { status: 'query_failed' })
})
