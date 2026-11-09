import { createHash } from 'node:crypto'
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { resolve, dirname, join, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve(root, '../../connector/package.json'))
const { transform } = require('esbuild')
export const PROVIDER_VERSION = '0.1.1-rc.2-dshoslink.1'

export async function buildProvider(upstreamPackage, output) {
  const manifestBytes = await readFile(join(upstreamPackage, 'package.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const splitProvider = ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1'].includes(manifest.version)
  const baselineName = splitProvider ? `baseline-${manifest.version}.json` : manifest.version === '0.1.7-alpha.2' ? 'baseline-0.1.7.json'
    : manifest.version === '0.1.6-alpha.1' ? 'baseline-0.1.6.json'
    : manifest.version === '0.1.5-rc.2' ? 'baseline-0.1.5.json' : 'baseline.json'
  const baseline = JSON.parse(await readFile(join(root, baselineName), 'utf8'))
  const invariantBytes = baseline.publishedInvariantSha256
    ? await readFile(join(upstreamPackage, 'lib/invariant.js')) : undefined
  const source = (await readFile(join(upstreamPackage, 'lib/index.js'), 'utf8')).replaceAll('\r\n', '\n')
  if (manifest.name !== '@deepseek-ai/dsh-llm-deepseek' || manifest.version !== baseline.upstreamVersion
    || createHash('sha256').update(source).digest('hex') !== baseline.publishedIndexSha256
    || createHash('sha256').update(manifestBytes).digest('hex') !== baseline.publishedManifestSha256
    || (invariantBytes !== undefined && createHash('sha256').update(invariantBytes).digest('hex') !== baseline.publishedInvariantSha256)) {
    throw new Error('DSH provider baseline mismatch; rebuild and review the integration before upgrading')
  }
  const anchor = '\tlet userId;'
  if (source.split(anchor).length !== 2) throw new Error('DSH provider integration anchor mismatch')
  const freshOptions = manifest.version === '0.1.7-alpha.2'
  const addition = splitProvider ? '\tregisterBalanceProvider(ctx, provider, dependencies);\n' + anchor : [
    ...(freshOptions ? [
      "\tlet balanceOptionsCache;",
      "\tconst balanceOptions = () => {",
      "\t\tconst next = options();",
      "\t\tif (balanceOptionsCache === void 0 || !deepEqualJson(balanceOptionsCache, next)) balanceOptionsCache = next;",
      "\t\treturn balanceOptionsCache;",
      "\t};",
      "\tctx.on(\"loader/volatile-update\", () => { balanceOptionsCache = void 0; });",
    ] : []),
    freshOptions
      ? '\tconst balanceReader = createBalanceReader({ options: balanceOptions, resolveApiKey });'
      : '\tconst balanceReader = createBalanceReader({ options, resolveApiKey });',
    '\tctx.provide("deepseekBalance", { read: () => balanceReader.read() });',
    '\tctx.effect(() => () => balanceReader.dispose(), "dshos-link-deepseek-balance");',
    anchor,
  ].join('\n')
  const patched = (splitProvider ? 'import { registerBalanceProvider } from "./balance-provider.js";\n'
    : 'import { createBalanceReader } from "./balance-api.js";\n') + source.replace(anchor, addition)
  const api = await transform(await readFile(join(root, 'balance-api.ts'), 'utf8'), {
    loader: 'ts', format: 'esm', target: 'es2022', legalComments: 'inline',
  })
  const inside = relative(resolve(upstreamPackage), resolve(output))
  if (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside)) throw new Error('Output must be outside the official package')
  // Refuse overwrites, including accidentally targeting a live package.
  await mkdir(output)
  await mkdir(join(output, 'lib'))
  await writeFile(join(output, 'lib/index.js'), patched)
  await writeFile(join(output, 'lib/balance-api.js'), api.code)
  if (splitProvider) await copyFile(join(root, 'balance-provider.mjs'), join(output, 'lib/balance-provider.js'))
  if (invariantBytes !== undefined) await copyFile(join(upstreamPackage, 'lib/invariant.js'), join(output, 'lib/invariant.js'))
  await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'))
  const artifact = {
    ...manifest, version: baseline.providerVersion ?? PROVIDER_VERSION, private: true,
    description: 'DSHOS Link integrated balance extension of the pinned DeepSeek provider',
    files: ['lib/*.js', 'LICENSE', 'dshos-source.json'],
  }
  delete artifact.publishConfig
  delete artifact.devDependencies
  delete artifact.types
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(artifact[field] ?? {})) {
      artifact[field][name] = version.replace(/^[~^]/, '')
    }
  }
  artifact.exports = {
    '.': './lib/index.js',
    ...(invariantBytes !== undefined ? { './invariant': './lib/invariant.js' } : {}),
    './package.json': './package.json',
  }
  await writeFile(join(output, 'package.json'), JSON.stringify(artifact, null, 2) + '\n')
  await writeFile(join(output, 'dshos-source.json'), JSON.stringify({
    ...baseline, version: artifact.version,
    patchedIndexSha256: createHash('sha256').update(patched).digest('hex'),
    ...(splitProvider ? { balanceProviderSha256: createHash('sha256').update(await readFile(join(output, 'lib/balance-provider.js'))).digest('hex') } : {}),
    balanceApiSha256: createHash('sha256').update(api.code).digest('hex'),
  }, null, 2) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: build.mjs <official-package-directory> <isolated-output-directory>')
  await buildProvider(resolve(process.argv[2]), resolve(process.argv[3]))
}
