/** Shared LAN candidate advertisement used by the connector and the development CLI. */
import { randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { getResponder, Protocol } from '@homebridge/ciao'

export const MDNS_SERVICE_TYPE = '_dshoslink._tcp'
export const MDNS_DISCOVERY_VERSION = '1'
export const MDNS_SERVICE_NAME = 'DSHOS Link Discovery'

const MDNS_SERVICE_TYPE_NAME = 'dshoslink'
const CONNECTOR_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface MdnsAdvertisementDefinition {
  readonly name: string
  readonly type: string
  readonly protocol: 'tcp'
  readonly port: number
  readonly txt: Readonly<Record<'v' | 'id', string>>
  readonly restrictedAddresses: readonly string[]
  readonly disabledIpv6: true
}

export interface MdnsService {
  advertise(): Promise<void>
  destroy(): Promise<void>
}

export interface MdnsResponder {
  createService(options: MdnsAdvertisementDefinition): MdnsService
  shutdown(): Promise<void>
}

export interface StartMdnsAdvertisementOptions {
  host: string
  port: number
  connectorId?: string
  /** Test seam; production callers use @homebridge/ciao. */
  responderFactory?: () => MdnsResponder
}

export interface MdnsAdvertisement {
  readonly host: string
  readonly port: number
  readonly connectorId: string
  readonly definition: MdnsAdvertisementDefinition
  stop(): Promise<void>
}

interface ParsedMdnsSpikeCliOptions {
  readonly host: string
  readonly port: number
}

function isRfc1918IPv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

export function validateMdnsSpikeHost(host: string): string {
  const normalized = host.trim()
  if (!isRfc1918IPv4(normalized)) {
    throw new Error('mDNS spike host must be an explicit RFC1918 IPv4 address')
  }
  return normalized
}

export function validateMdnsSpikePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('mDNS spike port must be an integer from 1 to 65535')
  }
  return port
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('mDNS spike port must be an integer from 1 to 65535')
  return validateMdnsSpikePort(Number(value))
}

function validateConnectorId(connectorId: string): string {
  if (!CONNECTOR_ID_PATTERN.test(connectorId)
    || Buffer.from(connectorId, 'base64url').byteLength !== 32
    || Buffer.from(connectorId, 'base64url').toString('base64url') !== connectorId) {
    throw new Error('mDNS connectorId must be a canonical identity ID')
  }
  return connectorId
}

export function parseMdnsSpikeCliOptions(argv: readonly string[]): ParsedMdnsSpikeCliOptions {
  let host: string | undefined
  let port: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === '--host') {
      if (host !== undefined || value === undefined) throw new Error('--host must be provided exactly once')
      host = validateMdnsSpikeHost(value)
      index += 1
    } else if (option === '--port') {
      if (port !== undefined || value === undefined) throw new Error('--port must be provided exactly once')
      port = parsePort(value)
      index += 1
    } else {
      throw new Error(`Unknown mDNS spike option: ${option}`)
    }
  }
  if (host === undefined) throw new Error('--host is required')
  if (port === undefined) throw new Error('--port is required')
  return { host, port }
}

function createDefinition(host: string, port: number, connectorId: string): MdnsAdvertisementDefinition {
  return {
    name: MDNS_SERVICE_NAME,
    type: MDNS_SERVICE_TYPE_NAME,
    protocol: 'tcp',
    port,
    txt: { v: MDNS_DISCOVERY_VERSION, id: connectorId },
    restrictedAddresses: [host],
    disabledIpv6: true,
  }
}

function createCiaoResponder(host: string): MdnsResponder {
  const responder = getResponder({
    interface: host,
    disableIpv6: true,
    advertiseIpv4: true,
    advertiseIpv6: false,
  })
  return {
    createService(options: MdnsAdvertisementDefinition): MdnsService {
      return responder.createService({
        ...options,
        protocol: Protocol.TCP,
        restrictedAddresses: [...options.restrictedAddresses],
      })
    },
    shutdown(): Promise<void> {
      return responder.shutdown()
    },
  }
}

async function stopResources(service: MdnsService | undefined, responder: MdnsResponder): Promise<void> {
  let serviceFailure: unknown
  if (service !== undefined) {
    try {
      await service.destroy()
    } catch (error) {
      serviceFailure = error
    }
  }
  try {
    await responder.shutdown()
  } catch (error) {
    if (serviceFailure === undefined) throw error
  }
  if (serviceFailure !== undefined) throw serviceFailure
}

export async function startMdnsAdvertisement(
  options: StartMdnsAdvertisementOptions,
): Promise<MdnsAdvertisement> {
  const host = validateMdnsSpikeHost(options.host)
  const port = validateMdnsSpikePort(options.port)
  const connectorId = validateConnectorId(
    options.connectorId ?? randomBytes(32).toString('base64url'),
  )
  const responder = options.responderFactory?.() ?? createCiaoResponder(host)
  let service: MdnsService | undefined
  try {
    const definition = createDefinition(host, port, connectorId)
    service = responder.createService(definition)
    await service.advertise()
    let stopPromise: Promise<void> | undefined
    return {
      host,
      port,
      connectorId,
      definition,
      stop(): Promise<void> {
        stopPromise ??= stopResources(service, responder)
        return stopPromise
      },
    }
  } catch (error) {
    await stopResources(service, responder).catch(() => undefined)
    throw error
  }
}

function usage(): string {
  return 'Usage: corepack pnpm run dev:mdns-spike --host <RFC1918 IPv4> --port <1-65535>'
}

export async function runMdnsSpikeCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseMdnsSpikeCliOptions(argv)
  const advertisement = await startMdnsAdvertisement(options)
  try {
    console.log(`[DSHOS Link mDNS Spike] serviceType=${MDNS_SERVICE_TYPE}`)
    console.log(`[DSHOS Link mDNS Spike] discoveryVersion=${MDNS_DISCOVERY_VERSION}`)
    console.log(`[DSHOS Link mDNS Spike] connectorId=${advertisement.connectorId}`)
    console.log(`[DSHOS Link mDNS Spike] advertisedHost=${advertisement.host}`)
    console.log(`[DSHOS Link mDNS Spike] advertisedPort=${advertisement.port}`)
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await advertisement.stop().catch(() => undefined)
  }
}

export function mdnsSpikeUsage(): string {
  return usage()
}
