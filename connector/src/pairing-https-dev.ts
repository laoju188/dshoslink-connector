import { isIPv4 } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import {
  PairingV1Backend,
  createPairingV1RequestHandler,
} from './pairing-backend.js'
import {
  DEFAULT_PAIRING_BOOTSTRAP_PORT,
  PAIRING_BOOTSTRAP_PORT_ENV,
  startPairingBootstrapHttpServer,
  type PairingBootstrapHttpServer,
} from './pairing-bootstrap-http.js'
import { startPairingHttpsServer, type PairingHttpsServer } from './pairing-https-server.js'
import {
  InMemoryPairingTrustStore,
  type PairingTrustStore,
} from './pairing-trust-store.js'
import {
  PAIRING_UI_PROOF_ENV,
  registerPairingOverlayProof,
} from './pairing-overlay.js'
import { createHttpsSpikeCertificatePinning } from './https-spike.js'
import {
  createTemporaryWssSpikePki,
  type TemporaryWssSpikePki,
} from './wss-spike.js'

export const PAIRING_HTTPS_DEV_HOST_ENV = 'DSHOS_LINK_PAIRING_HTTPS_HOST'
export const PAIRING_HTTPS_DEV_PORT_ENV = 'DSHOS_LINK_PAIRING_HTTPS_PORT'
export const DEFAULT_PAIRING_HTTPS_DEV_PORT = 24_690

export interface PairingHttpsDevOptions {
  readonly host: string
  readonly port: number
  readonly bootstrapPort: number
}

export interface PairingHttpsDevRuntime {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  readonly bootstrapPort: number
  readonly bootstrapBaseUrl: string
  readonly caDer: Buffer
  readonly pin: Buffer
  readonly backend: PairingV1Backend
  isRunning(): boolean
  isPaired(): boolean
  stop(): Promise<void>
}

interface PairingHttpsDevDependencies {
  readonly trustStore?: PairingTrustStore
  readonly createPki?: (
    options: { readonly sanIp: string },
  ) => Promise<TemporaryWssSpikePki>
}

function isRfc1918Ipv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer from 1 to 65535`)
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`)
  }
  return port
}

export function readPairingHttpsDevOptions(
  env: NodeJS.ProcessEnv = process.env,
): PairingHttpsDevOptions | undefined {
  if (env[PAIRING_UI_PROOF_ENV] !== '1'
    || env[PAIRING_HTTPS_DEV_HOST_ENV] === undefined) return undefined
  const host = env[PAIRING_HTTPS_DEV_HOST_ENV].trim()
  if (!isRfc1918Ipv4(host)) {
    throw new Error(`${PAIRING_HTTPS_DEV_HOST_ENV} must be an explicit RFC1918 IPv4 address`)
  }
  const port = env[PAIRING_HTTPS_DEV_PORT_ENV] === undefined
    ? DEFAULT_PAIRING_HTTPS_DEV_PORT
    : parsePort(env[PAIRING_HTTPS_DEV_PORT_ENV], PAIRING_HTTPS_DEV_PORT_ENV)
  const bootstrapPort = env[PAIRING_BOOTSTRAP_PORT_ENV] === undefined
    ? DEFAULT_PAIRING_BOOTSTRAP_PORT
    : parsePort(env[PAIRING_BOOTSTRAP_PORT_ENV], PAIRING_BOOTSTRAP_PORT_ENV)
  if (bootstrapPort === port) {
    throw new Error(`${PAIRING_BOOTSTRAP_PORT_ENV} must differ from ${PAIRING_HTTPS_DEV_PORT_ENV}`)
  }
  return {
    host,
    port,
    bootstrapPort,
  }
}

async function startPairingHttpsDevelopment(
  options: PairingHttpsDevOptions,
  dependencies: PairingHttpsDevDependencies,
): Promise<PairingHttpsDevRuntime> {
  if (!isRfc1918Ipv4(options.host)) {
    throw new Error('Pairing development HTTPS host must be an explicit RFC1918 IPv4 address')
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('Pairing development HTTPS port must be an integer from 1 to 65535')
  }
  if (!Number.isInteger(options.bootstrapPort)
    || options.bootstrapPort < 1
    || options.bootstrapPort > 65_535
    || options.bootstrapPort === options.port) {
    throw new Error('Pairing development bootstrap port must be a different integer from 1 to 65535')
  }

  const pki = await (dependencies.createPki ?? createTemporaryWssSpikePki)({ sanIp: options.host })
  const trustStore = dependencies.trustStore ?? new InMemoryPairingTrustStore()
  let backend: PairingV1Backend | undefined
  let server: PairingHttpsServer | undefined
  let bootstrapServer: PairingBootstrapHttpServer | undefined
  let pin: Buffer | undefined
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    let firstError: unknown
    if (bootstrapServer !== undefined) {
      try {
        await bootstrapServer.stop()
      } catch (error) {
        firstError = error
      }
    }
    if (server !== undefined) {
      try {
        await server.stop()
      } catch (error) {
        firstError ??= error
      }
    }
    backend?.dispose()
    try {
      await pki.cleanup()
    } catch (error) {
      firstError ??= error
    }
    if (firstError !== undefined) throw firstError
  }

  try {
    pin = Buffer.from(
      createHttpsSpikeCertificatePinning(pki.leafCertPem).publicKeyHash,
      'base64',
    )
    backend = new PairingV1Backend({
        trustStore,
      },
    )
    const handler = createPairingV1RequestHandler(backend)
    server = await startPairingHttpsServer({
      host: options.host,
      port: options.port,
      key: pki.leafKeyPem,
      cert: pki.leafCertPem,
      handler,
    })
    bootstrapServer = await startPairingBootstrapHttpServer({
      host: options.host,
      port: options.bootstrapPort,
      caDer: pki.caDer,
    })
  } catch (error) {
    await stop().catch(() => undefined)
    throw error
  }

  return Object.freeze({
    host: options.host,
    port: options.port,
    baseUrl: `https://${options.host}:${options.port}`,
    bootstrapPort: options.bootstrapPort,
    bootstrapBaseUrl: `http://${options.host}:${options.bootstrapPort}`,
    caDer: Buffer.from(pki.caDer),
    pin: Buffer.from(pin),
    backend,
    isRunning: () => !stopped,
    isPaired: () => trustStore.read()?.status === 'active',
    stop,
  })
}

export async function registerPairingHttpsDevelopment(
  ctx: Context,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PairingHttpsDevDependencies = {},
): Promise<PairingHttpsDevRuntime | undefined> {
  const options = readPairingHttpsDevOptions(env)
  if (options === undefined) return undefined
  const runtime = await startPairingHttpsDevelopment(options, dependencies)
  try {
    registerPairingOverlayProof(ctx, { env, controller: runtime.backend })
    ctx.effect(() => () => runtime.stop(), 'dshos-link-pairing-development-https')
    return runtime
  } catch (error) {
    await runtime.stop().catch(() => undefined)
    throw error
  }
}
