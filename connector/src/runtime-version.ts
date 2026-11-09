import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_DSH_VERSIONS } from './connector-metadata.js'
import { readDesktopLanHosts, validateDesktopLanHosts } from './desktop-network.js'

// Internal process metadata, never an environment variable users must configure.
const automaticLanHosts = new WeakMap<NodeJS.ProcessEnv, readonly string[]>()
export function preparedDesktopLanHosts(env: NodeJS.ProcessEnv): readonly string[] | undefined {
  return automaticLanHosts.get(env)
}

export function normalizeRuntimeDshVersion(value: unknown): string {
  if (SUPPORTED_DSH_VERSIONS.some(version => version === value)) return value as string
  return typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|rc)\.\d{1,4})?$/.test(value)
    ? 'UNSUPPORTED' : 'UNAVAILABLE'
}

function readRuntimeManifest(entry: string | undefined): { name: string; version: unknown } | undefined {
  if (entry === undefined || !isAbsolute(entry) || basename(dirname(entry)) !== 'lib') return undefined
  const expectedPackage = basename(entry) === 'bin.js' ? '@deepseek-ai/dsh'
    : basename(entry) === 'index.js' ? '@deepseek-ai/dsh-desktop-host' : undefined
  if (expectedPackage === undefined) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
    return manifest?.name === expectedPackage ? manifest : undefined
  } catch { return undefined }
}

/** Read the running official host manifest; CLI and Desktop have different entrypoints. */
export function readRuntimeDshVersion(entry = process.argv[1]): string {
  return normalizeRuntimeDshVersion(readRuntimeManifest(entry)?.version)
}

export function readRuntimeDshKind(entry = process.argv[1]): 'desktop' | 'web' | 'unknown' {
  const name = readRuntimeManifest(entry)?.name
  return name === '@deepseek-ai/dsh-desktop-host' ? 'desktop' : name === '@deepseek-ai/dsh' ? 'web' : 'unknown'
}

/** Desktop owns its process and plugin activation, without the Web launcher environment. */
export function defaultDesktopPairingEnvironment(env: NodeJS.ProcessEnv, entry = process.argv[1]): NodeJS.ProcessEnv {
  if (env.DSHOS_LINK_PAIRING_ENABLED !== undefined) return env
  const manifest = readRuntimeManifest(entry)
  if (manifest?.name !== '@deepseek-ai/dsh-desktop-host'
    || !SUPPORTED_DSH_VERSIONS.some(version => version === manifest.version)) return env
  return { ...env, DSHOS_LINK_PAIRING_ENABLED: '1' }
}

/** Discover the missing Desktop LAN address without changing global or saved settings. */
export async function prepareDesktopPairingEnvironment(env: NodeJS.ProcessEnv, entry = process.argv[1],
  discoverHost: () => Promise<string | readonly string[] | undefined> = readDesktopLanHosts): Promise<NodeJS.ProcessEnv> {
  const prepared = defaultDesktopPairingEnvironment(env, entry)
  if (prepared.DSHOS_LINK_PAIRING_ENABLED !== '1' || prepared.DSHOS_LINK_HOST !== undefined
    || readRuntimeDshKind(entry) !== 'desktop'
    || !SUPPORTED_DSH_VERSIONS.some(version => version === readRuntimeDshVersion(entry))) return prepared
  try {
    const found = await discoverHost()
    if (found === undefined) { const result={...prepared};automaticLanHosts.set(result,[]);return result }
    const hosts = validateDesktopLanHosts(typeof found === 'string' ? [found] : found)
    const result = hosts.length ? { ...prepared, DSHOS_LINK_HOST: hosts[0] } : { ...prepared }
    automaticLanHosts.set(result, hosts)
    return result
  } catch { const result={...prepared};automaticLanHosts.set(result,[]);return result }
}

export function assertDesktopDependencyRecovery(baseUrl: string | undefined, entry = process.argv[1]): void {
  if (readRuntimeManifest(entry)?.name !== '@deepseek-ai/dsh-desktop-host') return
  if (baseUrl === undefined) throw new Error('DSH-LD-01: DSH Desktop profile is unavailable；请保留资料并运行连接器 diagnose 收集安装诊断。')
  let url: URL
  try { url = new URL(baseUrl) }
  catch { throw new Error('DSH-LD-01: DSH Desktop profile is unavailable；请保留资料并运行连接器 diagnose 收集安装诊断。') }
  if (url.protocol !== 'file:' || url.search !== '' || url.hash !== '' || !url.pathname.endsWith('/')) {
    throw new Error('DSH-LD-01: DSH Desktop profile is unavailable；请保留资料并运行连接器 diagnose 收集安装诊断。')
  }
  if (existsSync(join(fileURLToPath(url), '.dshos-link', 'desktop-installer', 'balance-recovery-required.json'))) {
    throw new Error('DSH-LD-02: DSHOS Link dependency recovery is incomplete. Quit Desktop and retry connector upgrade. 可运行连接器 diagnose 收集安装诊断；不要删除配对资料。')
  }
}
