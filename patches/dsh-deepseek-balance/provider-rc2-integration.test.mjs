import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, symlink, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { buildProvider } from './build.mjs'

assert.ok(process.env.DSH_BALANCE_TEST_PACKAGE, 'Set DSH_BALANCE_TEST_PACKAGE to the official DSH 0.2.2-rc.2 provider directory')
const official = resolve(process.env.DSH_BALANCE_TEST_PACKAGE)
const version = JSON.parse(await readFile(join(official, 'package.json'), 'utf8')).version
assert.equal(version, '0.2.2-rc.2')
const upstreamRequire = createRequire(join(official, 'package.json'))
const { Context } = await import(pathToFileURL(upstreamRequire.resolve('@deepseek-ai/cordis')).href)
const validationRoot = resolve(process.env.DSH_BALANCE_TEST_OUTPUT ?? tmpdir())
await mkdir(validationRoot, { recursive: true })
const sandbox = await mkdtemp(join(validationRoot, 'provider-tests-'))
const validBalance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '7.80', granted_balance: '0', topped_up_balance: '7.80' }] }
const available = { status: 'available', currency: 'CNY', totalBalance: '7.80' }

async function fixture(name, mutation) {
  const output = join(sandbox, name)
  await buildProvider(official, output)
  if (mutation) {
    const file = join(output, 'lib/balance-provider.js')
    const source = await readFile(file, 'utf8')
    assert.equal(source.split(mutation).length, 2)
    await writeFile(file, source.replace(mutation, ''))
  }
  await symlink(resolve(official, '../..'), join(output, 'node_modules'), 'junction')
  // Only redirect module resolution to the integrated core; upstream API-key logic is untouched.
  const apiKeySource = await readFile(upstreamRequire.resolve('@deepseek-ai/dsh-llm-deepseek-api-key'), 'utf8')
  const specifier = '"@deepseek-ai/dsh-llm-deepseek"'
  assert.equal(apiKeySource.split(specifier).length, 2)
  await writeFile(join(output, 'api-key.mjs'), apiKeySource.replace(specifier, JSON.stringify(pathToFileURL(join(output, 'lib/index.js')).href)))
  return { core: await import(pathToFileURL(join(output, 'lib/index.js')).href),
    plugin: await import(pathToFileURL(join(output, 'api-key.mjs')).href), output }
}
function context(core, resolveKey = async () => ({ value: 'synthetic-test-key' })) {
  const ctx = new Context()
  let registrations = 0
  ctx.provide('launchEnvironment', { get: () => undefined, getFrom: () => undefined })
  ctx.provide('credentials', { resolve: resolveKey })
  ctx.provide('llm', { registerConfigurableProviders() {}, registerAdapter(routes, adapter) {
    assert.ok(adapter instanceof core.DeepSeekAdapter)
    registrations++
    return { replace() {} }
  } })
  return { ctx, registrations: () => registrations }
}

test(`${version} core build is reproducible, preserves exports and rejects changed source`, async () => {
  const a = join(sandbox, 'deterministic-a'), b = join(sandbox, 'deterministic-b')
  await buildProvider(official, a); await buildProvider(official, b)
  for (const file of ['lib/index.js', 'lib/balance-api.js', 'lib/balance-provider.js', 'package.json', 'dshos-source.json']) {
    assert.deepEqual(await readFile(join(a, file)), await readFile(join(b, file)))
  }
  const original = (await readFile(join(official, 'lib/index.js'), 'utf8')).replaceAll('\r\n', '\n')
  const patched = await readFile(join(a, 'lib/index.js'), 'utf8')
  assert.equal(patched.replace('import { registerBalanceProvider } from "./balance-provider.js";\n', '')
    .replace('\tregisterBalanceProvider(ctx, provider, dependencies);\n', ''), original)
  await assert.rejects(buildProvider(official, a))
  const altered = join(sandbox, 'altered')
  await mkdir(join(altered, 'lib'), { recursive: true })
  await writeFile(join(altered, 'package.json'), await readFile(join(official, 'package.json')))
  await writeFile(join(altered, 'lib/index.js'), original + '\n// changed\n')
  await assert.rejects(buildProvider(altered, join(sandbox, 'rejected')), /baseline mismatch/)
})

test(`real ${version} API-key plugin and Cordis retain the adapter and expose normalized balance`, async () => {
  const { core, plugin } = await fixture('api-key')
  const { ctx, registrations } = context(core)
  const prior = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance')
    assert.equal(init.headers.Authorization, 'Bearer synthetic-test-key')
    requests++
    return Response.json(validBalance)
  }
  try {
    const fiber = ctx.plugin(plugin, {})
    await fiber.await()
    const service = ctx.get('deepseekBalance')
    assert.deepEqual(await service.read(), available)
    assert.equal(registrations(), 1)
    await fiber.dispose()
    assert.equal(ctx.get('deepseekBalance'), undefined)
    assert.deepEqual(await service.read(), { status: 'query_failed' })
    assert.equal(requests, 1)
  } finally { await ctx.fiber.dispose(); globalThis.fetch = prior }
})

test('account provider does not expose API-key balance or resolve its account credential', async () => {
  const { core } = await fixture('account')
  const { ctx, registrations } = context(core)
  let credentials = 0
  try {
    const fiber = ctx.plugin({ apply(child) { core.registerDeepSeekProvider(child, 'deepseek-account', {
      options: () => ({ baseURL: 'https://api.deepseek.com', retryPolicy: {} }),
      resolveAuth: async () => { credentials++; return { headers: { 'x-dsh-auth-token': 'synthetic-account-token' } } },
      discoverModels: async () => [],
    }) } })
    await fiber.await()
    assert.equal(ctx.get('deepseekBalance'), undefined)
    assert.equal(credentials, 0)
    assert.equal(registrations(), 1)
  } finally { await ctx.fiber.dispose() }
})

test('rc.2 keeps missing credentials and nonofficial endpoints separate from a zero balance', async () => {
  const { core, plugin } = await fixture('unavailable')
  for (const [config, expected] of [[{}, 'not_configured'], [{ baseURL: 'https://custom.invalid' }, 'unsupported']]) {
    const { ctx } = context(core, async () => undefined)
    const prior = globalThis.fetch
    let requests = 0
    globalThis.fetch = async () => { requests++; throw Error('Unexpected request') }
    try {
      const fiber = ctx.plugin(plugin, config); await fiber.await()
      assert.deepEqual(await ctx.get('deepseekBalance').read(), { status: expected })
      assert.equal(requests, 0)
    } finally { await ctx.fiber.dispose(); globalThis.fetch = prior }
  }
})

test('valid stale responses are rejected across rc.2 configuration and volatile changes', async (t) => {
  for (const variant of ['normal', 'ignore-config', 'ignore-event']) {
    const mutation = variant === 'ignore-config' ? ' || !deepEqualJson(cached, value)'
      : variant === 'ignore-event' ? "ctx.on('loader/volatile-update', () => { cached = undefined; });" : undefined
    const { core, plugin } = await fixture('guards-' + variant, mutation)
    const stages = variant === 'ignore-event' ? ['unchanged', 'event'] : variant === 'normal' ? ['unchanged', 'credential', 'response', 'event'] : ['unchanged', 'credential', 'response']
    for (const stage of stages) {
      await t.test(variant + '/' + stage, async () => {
        const config = { apiKeyEnv: 'INITIAL_KEY' }
        const { ctx } = context(core, async () => {
          if (stage === 'credential') config.apiKeyEnv = 'CHANGED_KEY'
          return { value: 'synthetic-test-key' }
        })
        const prior = globalThis.fetch
        let requests = 0
        globalThis.fetch = async () => {
          requests++
          if (stage === 'event') ctx.emit('loader/volatile-update')
          if (stage === 'response') config.apiKeyEnv = 'CHANGED_KEY'
          return Response.json(validBalance)
        }
        try {
          // Resolve through the actual upstream plugin, with live scalar configuration accessors.
          const fiber = ctx.plugin({ Config: plugin.Config, inject: plugin.inject, apply: (child, live) => plugin.apply(child, {
            ...live,
            apiKeyEnv: { get: () => config.apiKeyEnv },
          }) })
          await fiber.await()
          const result = await ctx.get('deepseekBalance').read()
          assert.deepEqual(result, stage === 'unchanged' || variant !== 'normal' ? available : { status: 'query_failed' })
          assert.equal(requests, stage === 'credential' && variant === 'normal' ? 0 : 1)
        } finally { await ctx.fiber.dispose(); globalThis.fetch = prior }
      })
    }
  }
})
