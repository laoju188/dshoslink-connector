/**
 * Development-only HTTPS support for API 24 certificate pinning and streaming tests.
 * It is intentionally not imported by the Cordis bundle, V1 server, or WSS spike CLI.
 */
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIPv4 } from 'node:net'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createTemporaryWssSpikePki,
  type TemporaryWssSpikePki,
} from './wss-spike.js'

export const DEFAULT_HTTPS_SPIKE_PORT = 24684
export const DEFAULT_HTTPS_MATRIX_OLD_PORT = 24687
export const DEFAULT_HTTPS_MATRIX_ROTATED_PORT = 24688
export const DEFAULT_HTTPS_MATRIX_CHAIN_PORT = 24689
export const HTTPS_SPIKE_OK_PATH = '/spike/https/ok'
export const HTTPS_SPIKE_EVENTS_PATH = '/spike/https/events'
export const HTTPS_SPIKE_COMMAND_PATH = '/spike/https/command'
export const HTTPS_SPIKE_REDIRECT_PATH = '/spike/https/redirect'
export const HTTPS_SPIKE_REDIRECT_TARGET_PATH = '/spike/https/redirect-target'
export const HTTPS_SPIKE_REDIRECT_STATUS_PATH = '/spike/https/redirect-status'
export const HTTPS_SPIKE_LIFECYCLE_EVENTS_PATH = '/spike/https/lifecycle/events'
export const HTTPS_SPIKE_LIFECYCLE_STATUS_PATH = '/spike/https/lifecycle/status'
export const HTTPS_SPIKE_LIFECYCLE_CANCEL_PATH = '/spike/https/lifecycle/cancel'
export const HTTPS_SPIKE_LIFECYCLE_RUN_ID_HEADER = 'x-dshos-spike-run-id'
export const HTTPS_SPIKE_COMMAND_TYPE = 'https_spike_command'
export const HTTPS_SPIKE_COMMAND_ACK_TYPE = 'https_spike_command_ack'
export const HTTPS_SPIKE_EVENT_TYPE = 'https_spike_event'
export const HTTPS_SPIKE_LIFECYCLE_EVENT_TYPE = 'https_spike_lifecycle_event'
export const HTTPS_SPIKE_EVENT_COUNT = 3
export const MAX_HTTPS_SPIKE_REQUEST_BYTES = 4096
export const MAX_HTTPS_SPIKE_LIFECYCLE_IDLE_MS = 120_000

const HTTPS_SPIKE_OK_TYPE = 'https_spike_ok'
const HTTPS_SPIKE_REDIRECT_TARGET_TYPE = 'https_spike_redirect_target'
const HTTPS_SPIKE_REDIRECT_STATUS_TYPE = 'https_spike_redirect_status'
const COMMAND_KEYS = ['command', 'commandId', 'type']
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const STREAM_EVENT_INTERVAL_MS = 120
const STREAM_CLOSE_DELAY_MS = 400
const LIFECYCLE_EVENT_INTERVAL_MS = 40

export interface HttpsSpikeCertificatePinning {
  readonly publicKeyHash: string
  readonly hashAlgorithm: 'SHA-256'
}

export type HttpsSpikeLeafState = 'valid' | 'wrong-san' | 'expired'
export type HttpsSpikeLifecycleScenario = 'idle' | 'cancel' | 'reconnect-dedup' | 'wifi-recovery'

export interface HttpsSpikeLifecycleOptions {
  readonly scenario: HttpsSpikeLifecycleScenario
  readonly idleMs?: number
}

export interface HttpsSpikeLifecyclePublicInfo extends HttpsSpikeLifecycleOptions {
  readonly runId: string
}

export interface HttpsSpikeServer {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  readonly certificatePinning: HttpsSpikeCertificatePinning
  readonly lifecycle?: HttpsSpikeLifecyclePublicInfo
  stop(): Promise<void>
}

export interface StartHttpsSpikeServerOptions {
  readonly host: string
  readonly port: number
  readonly pki: Pick<TemporaryWssSpikePki, 'leafCertPem' | 'leafKeyPem'> & {
    readonly pinCertificatePem?: Buffer
  }
  readonly redirectTargetUrl?: string
  readonly redirectTargetHits?: HttpsSpikeRedirectHits
  readonly lifecycle?: HttpsSpikeLifecycleOptions
}

export interface HttpsSpikeCliOptions {
  readonly host: string
  readonly port: number
  readonly controlPort?: number
  readonly leafState: HttpsSpikeLeafState
  readonly lifecycleScenario?: HttpsSpikeLifecycleScenario
  readonly lifecycleIdleMs?: number
  readonly opensslPath?: string
}

export interface HttpsSpikeServices {
  readonly server: HttpsSpikeServer
  readonly controlServer?: HttpsSpikeServer
  stop(): Promise<void>
}

export interface StartHttpsSpikeServicesOptions {
  readonly host: string
  readonly port: number
  readonly controlPort?: number
  readonly leafState: HttpsSpikeLeafState
  readonly lifecycleScenario?: HttpsSpikeLifecycleScenario
  readonly lifecycleIdleMs?: number
  readonly pki: TemporaryWssSpikePki
}

export interface HttpsSecurityMatrixCliOptions {
  readonly host: string
  readonly oldPort: number
  readonly rotatedPort: number
  readonly chainPort: number
  readonly opensslPath?: string
}

export interface StartHttpsSecurityMatrixServicesOptions {
  readonly host: string
  readonly oldPort: number
  readonly rotatedPort: number
  readonly chainPort: number
  readonly pki: TemporaryWssSpikePki
}

export interface HttpsSecurityMatrixServices {
  readonly oldServer: HttpsSpikeServer
  readonly rotatedServer: HttpsSpikeServer
  readonly chainServer: HttpsSpikeServer
  readonly intermediateCertificatePinning: HttpsSpikeCertificatePinning
  readonly rootCertificatePinning: HttpsSpikeCertificatePinning
  stop(): Promise<void>
}

interface HttpsSpikeRedirectHits {
  count: number
}

interface ParsedCommand {
  readonly commandId: string
}

type HttpsSpikeLifecyclePhase =
  | 'READY'
  | 'STREAMING'
  | 'IDLE'
  | 'WAITING_CLIENT_CANCEL'
  | 'FORCED_DISCONNECTED'
  | 'WAITING_RECONNECT'
  | 'REPLAYING'
  | 'COMPLETE'

interface HttpsSpikeLifecycleStatus {
  readonly type: 'https_spike_lifecycle_status'
  readonly runId: string
  readonly scenario: HttpsSpikeLifecycleScenario
  readonly phase: HttpsSpikeLifecyclePhase
  readonly connectionsOpened: number
  readonly activeConnections: number
  readonly receivedCursors: readonly (number | null)[]
  readonly attemptedEventIds: readonly (readonly number[])[]
  readonly forcedDisconnects: number
  readonly explicitCancels: number
  readonly clientAborts: number
  readonly cleanEnds: number
  readonly supersededConnections: number
}

interface HttpsSpikeLifecycleController {
  readonly publicInfo: HttpsSpikeLifecyclePublicInfo
  status(): HttpsSpikeLifecycleStatus
  cancel(): boolean
  handleEvents(request: IncomingMessage, response: ServerResponse): Promise<void>
  stop(): void
}

function isRfc1918IPv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

export function validateHttpsSpikeHost(host: string): string {
  const normalized = host.trim()
  if (!isRfc1918IPv4(normalized)) {
    throw new Error('HTTPS spike host must be an explicit RFC1918 IPv4 address')
  }
  return normalized
}

function validatePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('HTTPS spike port must be an integer from 1 to 65535')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HTTPS spike port must be an integer from 1 to 65535')
  }
  return port
}

function validateLifecycleIdleMs(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--lifecycle-idle-ms must be an integer from 1 to ${MAX_HTTPS_SPIKE_LIFECYCLE_IDLE_MS}`)
  }
  const idleMs = Number(value)
  if (!Number.isInteger(idleMs) || idleMs < 1 || idleMs > MAX_HTTPS_SPIKE_LIFECYCLE_IDLE_MS) {
    throw new Error(`--lifecycle-idle-ms must be an integer from 1 to ${MAX_HTTPS_SPIKE_LIFECYCLE_IDLE_MS}`)
  }
  return idleMs
}

export function parseHttpsSpikeCliOptions(argv: readonly string[]): HttpsSpikeCliOptions {
  let host: string | undefined
  let port = DEFAULT_HTTPS_SPIKE_PORT
  let controlPort: number | undefined
  let leafState: HttpsSpikeLeafState = 'valid'
  let leafStateProvided = false
  let lifecycleScenario: HttpsSpikeLifecycleScenario | undefined
  let lifecycleIdleMs: number | undefined
  let opensslPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === '--host') {
      if (host !== undefined || value === undefined) throw new Error('--host must be provided exactly once')
      host = validateHttpsSpikeHost(value)
      index += 1
    } else if (option === '--port') {
      if (value === undefined) throw new Error('--port requires a value')
      port = validatePort(value)
      index += 1
    } else if (option === '--control-port') {
      if (controlPort !== undefined) throw new Error('--control-port may be provided at most once')
      if (value === undefined) throw new Error('--control-port requires a value')
      controlPort = validatePort(value)
      index += 1
    } else if (option === '--leaf-state') {
      if (leafStateProvided || (value !== 'valid' && value !== 'wrong-san' && value !== 'expired')) {
        throw new Error('--leaf-state must be valid, wrong-san, or expired and provided at most once')
      }
      leafState = value
      leafStateProvided = true
      index += 1
    } else if (option === '--lifecycle-scenario') {
      if (lifecycleScenario !== undefined
        || (value !== 'idle' && value !== 'cancel' && value !== 'reconnect-dedup'
          && value !== 'wifi-recovery')) {
        throw new Error('--lifecycle-scenario must be idle, cancel, reconnect-dedup, or wifi-recovery and provided at most once')
      }
      lifecycleScenario = value
      index += 1
    } else if (option === '--lifecycle-idle-ms') {
      if (lifecycleIdleMs !== undefined) {
        throw new Error('--lifecycle-idle-ms may be provided at most once')
      }
      if (value === undefined) throw new Error('--lifecycle-idle-ms requires a value')
      lifecycleIdleMs = validateLifecycleIdleMs(value)
      index += 1
    } else if (option === '--openssl') {
      if (opensslPath !== undefined || value === undefined) throw new Error('--openssl may be provided at most once')
      opensslPath = value
      index += 1
    } else {
      throw new Error(`Unknown HTTPS spike option: ${option}`)
    }
  }
  if (host === undefined) throw new Error('--host is required')
  if (leafState === 'valid' && controlPort !== undefined) {
    throw new Error('--control-port is only valid for wrong-san or expired leaf states')
  }
  if (leafState !== 'valid' && controlPort === undefined) {
    throw new Error('--control-port is required for wrong-san or expired leaf states')
  }
  if (controlPort === port) throw new Error('--control-port must differ from --port')
  if (lifecycleScenario === undefined && lifecycleIdleMs !== undefined) {
    throw new Error('--lifecycle-idle-ms requires --lifecycle-scenario idle or cancel')
  }
  if (lifecycleScenario !== undefined && leafState !== 'valid') {
    throw new Error('--lifecycle-scenario is only valid with leaf-state valid')
  }
  if (lifecycleScenario === 'idle' || lifecycleScenario === 'cancel') {
    if (lifecycleIdleMs === undefined) {
      throw new Error('--lifecycle-idle-ms is required for idle or cancel lifecycle scenarios')
    }
  } else if (lifecycleIdleMs !== undefined) {
    throw new Error('--lifecycle-idle-ms is only valid for idle or cancel lifecycle scenarios')
  }
  return {
    host,
    port,
    controlPort,
    leafState,
    ...(lifecycleScenario === undefined ? {} : { lifecycleScenario }),
    ...(lifecycleIdleMs === undefined ? {} : { lifecycleIdleMs }),
    opensslPath,
  }
}

function assertDistinctHttpsMatrixPorts(oldPort: number, rotatedPort: number, chainPort: number): void {
  const nonEphemeralPorts = [oldPort, rotatedPort, chainPort].filter((port) => port !== 0)
  if (new Set(nonEphemeralPorts).size !== nonEphemeralPorts.length) {
    throw new Error('HTTPS security matrix ports must be distinct')
  }
}

export function parseHttpsSecurityMatrixCliOptions(
  argv: readonly string[],
): HttpsSecurityMatrixCliOptions {
  let host: string | undefined
  let oldPort = DEFAULT_HTTPS_MATRIX_OLD_PORT
  let rotatedPort = DEFAULT_HTTPS_MATRIX_ROTATED_PORT
  let chainPort = DEFAULT_HTTPS_MATRIX_CHAIN_PORT
  let oldPortProvided = false
  let rotatedPortProvided = false
  let chainPortProvided = false
  let opensslPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === '--host') {
      if (host !== undefined || value === undefined) throw new Error('--host must be provided exactly once')
      host = validateHttpsSpikeHost(value)
      index += 1
    } else if (option === '--old-port') {
      if (oldPortProvided || value === undefined) throw new Error('--old-port must be provided at most once')
      oldPort = validatePort(value)
      oldPortProvided = true
      index += 1
    } else if (option === '--rotated-port') {
      if (rotatedPortProvided || value === undefined) throw new Error('--rotated-port must be provided at most once')
      rotatedPort = validatePort(value)
      rotatedPortProvided = true
      index += 1
    } else if (option === '--chain-port') {
      if (chainPortProvided || value === undefined) throw new Error('--chain-port must be provided at most once')
      chainPort = validatePort(value)
      chainPortProvided = true
      index += 1
    } else if (option === '--openssl') {
      if (opensslPath !== undefined || value === undefined) throw new Error('--openssl may be provided at most once')
      opensslPath = value
      index += 1
    } else {
      throw new Error(`Unknown HTTPS security matrix option: ${option}`)
    }
  }
  if (host === undefined) throw new Error('--host is required')
  assertDistinctHttpsMatrixPorts(oldPort, rotatedPort, chainPort)
  return { host, oldPort, rotatedPort, chainPort, opensslPath }
}

export function selectHttpsSpikeLeafPki(
  pki: TemporaryWssSpikePki,
  leafState: HttpsSpikeLeafState,
): StartHttpsSpikeServerOptions['pki'] {
  if (leafState === 'wrong-san') {
    return { leafCertPem: pki.wrongSanCertPem, leafKeyPem: pki.wrongSanKeyPem }
  }
  if (leafState === 'expired') {
    return { leafCertPem: pki.expiredLeafCertPem, leafKeyPem: pki.expiredLeafKeyPem }
  }
  return { leafCertPem: pki.leafCertPem, leafKeyPem: pki.leafKeyPem }
}

export function createHttpsSpikeCertificatePinning(
  leafCertificatePem: Buffer,
): HttpsSpikeCertificatePinning {
  const certificate = new X509Certificate(leafCertificatePem)
  const subjectPublicKeyInfo = certificate.publicKey.export({ format: 'der', type: 'spki' })
  return {
    publicKeyHash: createHash('sha256').update(subjectPublicKeyInfo).digest('base64'),
    hashAlgorithm: 'SHA-256',
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function validateLifecycleOptions(options: HttpsSpikeLifecycleOptions): void {
  if (options.scenario === 'idle' || options.scenario === 'cancel') {
    if (options.idleMs === undefined
      || !Number.isInteger(options.idleMs)
      || options.idleMs < 1
      || options.idleMs > MAX_HTTPS_SPIKE_LIFECYCLE_IDLE_MS) {
      throw new Error(`HTTPS lifecycle idleMs must be an integer from 1 to ${MAX_HTTPS_SPIKE_LIFECYCLE_IDLE_MS}`)
    }
    return
  }
  if (options.idleMs !== undefined) {
    throw new Error('HTTPS reconnect-dedup and wifi-recovery lifecycles must not provide idleMs')
  }
}

function lifecycleCursor(request: IncomingMessage): number | null | undefined {
  const value = request.headers['last-event-id']
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return undefined
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) ? cursor : undefined
}

function writeLifecycleEvent(
  response: ServerResponse,
  runId: string,
  eventId: number,
  attemptedEventIds: number[],
): boolean {
  if (response.destroyed || response.writableEnded) return false
  attemptedEventIds.push(eventId)
  response.write([
    `id: ${eventId}`,
    `event: ${HTTPS_SPIKE_LIFECYCLE_EVENT_TYPE}`,
    `data: ${JSON.stringify({ runId, eventId })}`,
    '',
    '',
  ].join('\n'))
  response.socket?.uncork()
  return true
}

function createHttpsSpikeLifecycleController(
  options: HttpsSpikeLifecycleOptions,
): HttpsSpikeLifecycleController {
  validateLifecycleOptions(options)
  const publicInfo: HttpsSpikeLifecyclePublicInfo = {
    scenario: options.scenario,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    runId: randomUUID(),
  }
  let phase: HttpsSpikeLifecyclePhase = 'READY'
  let connectionsOpened = 0
  let activeConnections = 0
  const receivedCursors: (number | null)[] = []
  const attemptedEventIds: number[][] = []
  let forcedDisconnects = 0
  let explicitCancels = 0
  let clientAborts = 0
  let cleanEnds = 0
  let supersededConnections = 0
  let stopping = false
  const activeWaits = new Set<AbortController>()
  let cancelActiveStream: (() => boolean) | undefined
  let supersedeActiveStream: (() => boolean) | undefined

  const status = (): HttpsSpikeLifecycleStatus => ({
    type: 'https_spike_lifecycle_status',
    runId: publicInfo.runId,
    scenario: publicInfo.scenario,
    phase,
    connectionsOpened,
    activeConnections,
    receivedCursors: [...receivedCursors],
    attemptedEventIds: attemptedEventIds.map((ids) => [...ids]),
    forcedDisconnects,
    explicitCancels,
    clientAborts,
    cleanEnds,
    supersededConnections,
  })

  return {
    publicInfo,
    status,
    cancel(): boolean {
      return cancelActiveStream?.() ?? false
    },
    async handleEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const cursor = lifecycleCursor(request)
      const supportsReconnect = options.scenario === 'reconnect-dedup'
        || options.scenario === 'wifi-recovery'
      let expectedCursor: number | null = null
      if (connectionsOpened === 1 && options.scenario === 'reconnect-dedup') expectedCursor = 2
      else if (connectionsOpened === 1 && options.scenario === 'wifi-recovery') expectedCursor = 1
      if (cursor === undefined || cursor !== expectedCursor
        || connectionsOpened >= (supportsReconnect ? 2 : 1)) {
        sendJson(response, 409, { error: 'lifecycle_cursor_mismatch' })
        return
      }
      if (activeConnections !== 0) {
        const superseded = options.scenario === 'wifi-recovery'
          && connectionsOpened === 1
          && supersedeActiveStream?.() === true
        if (!superseded) {
          sendJson(response, 409, { error: 'lifecycle_stream_active' })
          return
        }
      }

      const connectionIndex = connectionsOpened
      const connectionAttempts: number[] = []
      connectionsOpened += 1
      activeConnections += 1
      receivedCursors.push(cursor)
      attemptedEventIds.push(connectionAttempts)
      const waitController = new AbortController()
      activeWaits.add(waitController)
      let finished = false
      let explicitCancel: (() => boolean) | undefined
      let supersedeStream: (() => boolean) | undefined

      const finish = (
        outcome: 'clean' | 'client-abort' | 'explicit' | 'forced' | 'stopped' | 'superseded',
      ): void => {
        if (finished) return
        finished = true
        if (cancelActiveStream === explicitCancel) cancelActiveStream = undefined
        if (supersedeActiveStream === supersedeStream) supersedeActiveStream = undefined
        activeConnections -= 1
        activeWaits.delete(waitController)
        waitController.abort()
        if (outcome === 'clean') cleanEnds += 1
        else if (outcome === 'client-abort') clientAborts += 1
        else if (outcome === 'explicit') {
          explicitCancels += 1
          phase = 'COMPLETE'
        }
        else if (outcome === 'forced') forcedDisconnects += 1
        else if (outcome === 'superseded') supersededConnections += 1
      }
      const clientClosed = (): void => {
        if (finished || stopping || response.writableEnded) return
        finish('client-abort')
        phase = options.scenario === 'wifi-recovery' && connectionIndex === 0
          ? 'WAITING_RECONNECT'
          : 'COMPLETE'
      }
      request.once('aborted', clientClosed)
      response.once('close', clientClosed)
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
      })
      response.socket?.setNoDelay(true)
      response.flushHeaders()

      const wait = async (milliseconds: number): Promise<boolean> => {
        try {
          await delay(milliseconds, undefined, { signal: waitController.signal })
          return true
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return false
          throw error
        }
      }
      const waitForFinish = async (): Promise<void> => {
        if (waitController.signal.aborted) return
        await new Promise<void>((resolve) => {
          waitController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      const cleanEnd = (): void => {
        if (finished) return
        response.end()
        finish('clean')
        phase = 'COMPLETE'
      }

      if (options.scenario === 'idle') {
        phase = 'STREAMING'
        if (!writeLifecycleEvent(response, publicInfo.runId, 1, connectionAttempts)) return
        phase = 'IDLE'
        if (!await wait(options.idleMs as number)) return
        phase = 'STREAMING'
        if (!writeLifecycleEvent(response, publicInfo.runId, 2, connectionAttempts)) return
        cleanEnd()
        return
      }

      if (options.scenario === 'cancel') {
        phase = 'STREAMING'
        if (!writeLifecycleEvent(response, publicInfo.runId, 1, connectionAttempts)) return
        phase = 'WAITING_CLIENT_CANCEL'
        explicitCancel = (): boolean => {
          if (finished || request.aborted || response.destroyed || response.writableEnded) return false
          finish('explicit')
          response.end()
          return true
        }
        cancelActiveStream = explicitCancel
        if (!await wait(options.idleMs as number)) return
        cleanEnd()
        return
      }

      if (options.scenario === 'wifi-recovery') {
        if (connectionIndex === 0) {
          phase = 'STREAMING'
          if (!writeLifecycleEvent(response, publicInfo.runId, 1, connectionAttempts)) return
          supersedeStream = (): boolean => {
            if (finished) return false
            finish('superseded')
            response.destroy()
            return true
          }
          supersedeActiveStream = supersedeStream
          phase = 'WAITING_RECONNECT'
          await waitForFinish()
          return
        }

        phase = 'REPLAYING'
        for (const eventId of [1, 2, 2, 3]) {
          if (!writeLifecycleEvent(response, publicInfo.runId, eventId, connectionAttempts)) return
          if (eventId !== 3 && !await wait(LIFECYCLE_EVENT_INTERVAL_MS)) return
        }
        cleanEnd()
        return
      }

      if (connectionIndex === 0) {
        phase = 'STREAMING'
        if (!writeLifecycleEvent(response, publicInfo.runId, 1, connectionAttempts)) return
        if (!await wait(LIFECYCLE_EVENT_INTERVAL_MS)) return
        if (!writeLifecycleEvent(response, publicInfo.runId, 2, connectionAttempts)) return
        if (!await wait(LIFECYCLE_EVENT_INTERVAL_MS)) return
        phase = 'FORCED_DISCONNECTED'
        finish('forced')
        response.destroy()
        phase = 'WAITING_RECONNECT'
        return
      }

      phase = 'REPLAYING'
      for (const eventId of [2, 3, 3, 4]) {
        if (!writeLifecycleEvent(response, publicInfo.runId, eventId, connectionAttempts)) return
        if (eventId !== 4 && !await wait(LIFECYCLE_EVENT_INTERVAL_MS)) return
      }
      cleanEnd()
    },
    stop(): void {
      stopping = true
      cancelActiveStream = undefined
      supersedeActiveStream = undefined
      for (const controller of activeWaits) controller.abort()
      activeWaits.clear()
      activeConnections = 0
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCommand(value: unknown): ParsedCommand | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.length !== COMMAND_KEYS.length
    || !keys.every((key, index) => key === COMMAND_KEYS[index])
    || value.type !== HTTPS_SPIKE_COMMAND_TYPE
    || value.command !== 'probe'
    || typeof value.commandId !== 'string'
    || !COMMAND_ID_PATTERN.test(value.commandId)) return undefined
  return { commandId: value.commandId }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let length = 0
  let exceeded = false
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += data.byteLength
    if (length > MAX_HTTPS_SPIKE_REQUEST_BYTES) {
      exceeded = true
      chunks.length = 0
    } else if (!exceeded) {
      chunks.push(data)
    }
  }
  return exceeded ? undefined : Buffer.concat(chunks)
}

function flushEvent(response: ServerResponse, sequence: number): boolean {
  if (response.destroyed || response.writableEnded) return false
  const event = [
    `id: ${sequence}`,
    `event: ${HTTPS_SPIKE_EVENT_TYPE}`,
    `data: ${JSON.stringify({ sequence })}`,
    '',
    '',
  ].join('\n')
  response.write(event)
  response.socket?.uncork()
  return true
}

async function streamEvents(response: ServerResponse): Promise<void> {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  response.socket?.setNoDelay(true)
  response.flushHeaders()
  for (let sequence = 1; sequence <= HTTPS_SPIKE_EVENT_COUNT; sequence += 1) {
    if (!flushEvent(response, sequence)) return
    if (sequence < HTTPS_SPIKE_EVENT_COUNT) await delay(STREAM_EVENT_INTERVAL_MS)
  }
  await delay(STREAM_CLOSE_DELAY_MS)
  if (!response.destroyed && !response.writableEnded) response.end()
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader('Allow', allow)
  sendJson(response, 405, { error: 'method_not_allowed' })
}

async function handleCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    request.resume()
    sendJson(response, 415, { error: 'unsupported_media_type' })
    return
  }
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_HTTPS_SPIKE_REQUEST_BYTES) {
    request.resume()
    sendJson(response, 413, { error: 'request_too_large' })
    return
  }
  const body = await readRequestBody(request)
  if (body === undefined) {
    sendJson(response, 413, { error: 'request_too_large' })
    return
  }
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    sendJson(response, 400, { error: 'invalid_command' })
    return
  }
  const command = parseCommand(value)
  if (command === undefined) {
    sendJson(response, 400, { error: 'invalid_command' })
    return
  }
  sendJson(response, 200, {
    type: HTTPS_SPIKE_COMMAND_ACK_TYPE,
    commandId: command.commandId,
    ack: true,
  })
}

function hasLifecycleRunId(request: IncomingMessage, lifecycle: HttpsSpikeLifecycleController): boolean {
  return request.headers[HTTPS_SPIKE_LIFECYCLE_RUN_ID_HEADER] === lifecycle.publicInfo.runId
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: Pick<StartHttpsSpikeServerOptions, 'redirectTargetUrl' | 'redirectTargetHits'>,
  lifecycle: HttpsSpikeLifecycleController | undefined,
): Promise<void> {
  if (request.url === HTTPS_SPIKE_LIFECYCLE_EVENTS_PATH
    || request.url === HTTPS_SPIKE_LIFECYCLE_STATUS_PATH
    || request.url === HTTPS_SPIKE_LIFECYCLE_CANCEL_PATH) {
    if (lifecycle === undefined) {
      sendJson(response, 404, { error: 'not_found' })
      return
    }
    const expectedMethod = request.url === HTTPS_SPIKE_LIFECYCLE_CANCEL_PATH ? 'POST' : 'GET'
    if (request.method !== expectedMethod) {
      sendMethodNotAllowed(response, expectedMethod)
      return
    }
    if (!hasLifecycleRunId(request, lifecycle)) {
      sendJson(response, 403, { error: 'invalid_lifecycle_run_id' })
      return
    }
    if (request.url === HTTPS_SPIKE_LIFECYCLE_STATUS_PATH) {
      sendJson(response, 200, lifecycle.status())
      return
    }
    if (request.url === HTTPS_SPIKE_LIFECYCLE_CANCEL_PATH) {
      const body = await readRequestBody(request)
      if (body === undefined || body.byteLength !== 0) {
        sendJson(response, 409, { error: 'lifecycle_cancel_unavailable' })
        return
      }
      if (!lifecycle.cancel()) {
        sendJson(response, 409, { error: 'lifecycle_cancel_unavailable' })
        return
      }
      response.writeHead(204, {
        'Cache-Control': 'no-store',
      })
      response.end()
      return
    }
    await lifecycle.handleEvents(request, response)
    return
  }
  if (request.url === HTTPS_SPIKE_REDIRECT_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    if (options.redirectTargetUrl === undefined) {
      sendJson(response, 404, { error: 'redirect_not_configured' })
      return
    }
    response.writeHead(302, {
      'Location': options.redirectTargetUrl,
      'Content-Length': '0',
      'Cache-Control': 'no-store',
    })
    response.end()
    return
  }
  if (request.url === HTTPS_SPIKE_REDIRECT_TARGET_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    if (options.redirectTargetHits === undefined) {
      sendJson(response, 404, { error: 'redirect_target_not_configured' })
      return
    }
    options.redirectTargetHits.count += 1
    sendJson(response, 200, {
      type: HTTPS_SPIKE_REDIRECT_TARGET_TYPE,
      hits: options.redirectTargetHits.count,
    })
    return
  }
  if (request.url === HTTPS_SPIKE_REDIRECT_STATUS_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    if (options.redirectTargetHits === undefined) {
      sendJson(response, 404, { error: 'redirect_status_not_configured' })
      return
    }
    sendJson(response, 200, {
      type: HTTPS_SPIKE_REDIRECT_STATUS_TYPE,
      hits: options.redirectTargetHits.count,
    })
    return
  }
  if (request.url === HTTPS_SPIKE_OK_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    sendJson(response, 200, { type: HTTPS_SPIKE_OK_TYPE, ok: true })
    return
  }
  if (request.url === HTTPS_SPIKE_EVENTS_PATH) {
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    await streamEvents(response)
    return
  }
  if (request.url === HTTPS_SPIKE_COMMAND_PATH) {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'POST')
      return
    }
    await handleCommand(request, response)
    return
  }
  sendJson(response, 404, { error: 'not_found' })
}

function closeHttpsServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
    server.closeAllConnections()
  })
}

export async function startHttpsSpikeServer(
  options: StartHttpsSpikeServerOptions,
): Promise<HttpsSpikeServer> {
  const host = options.host.trim()
  if (host !== '127.0.0.1' && !isRfc1918IPv4(host)) {
    throw new Error('HTTPS spike server host must be loopback or an RFC1918 IPv4 address')
  }
  const certificatePinning = createHttpsSpikeCertificatePinning(
    options.pki.pinCertificatePem ?? options.pki.leafCertPem,
  )
  const lifecycle = options.lifecycle === undefined
    ? undefined
    : createHttpsSpikeLifecycleController(options.lifecycle)
  const server = createHttpsServer({
    key: options.pki.leafKeyPem,
    cert: options.pki.leafCertPem,
  }, (request, response) => {
    void handleRequest(request, response, options, lifecycle).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' })
      else response.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
    server.listen(options.port, host)
  }).catch(async (error: unknown) => {
    await closeHttpsServer(server).catch(() => undefined)
    throw error
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeHttpsServer(server).catch(() => undefined)
    throw new Error('HTTPS spike server did not expose an IPv4 address')
  }
  const port = (address as AddressInfo).port
  let stopped = false
  return {
    host,
    port,
    baseUrl: `https://${host}:${port}`,
    certificatePinning,
    ...(lifecycle === undefined ? {} : { lifecycle: lifecycle.publicInfo }),
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      lifecycle?.stop()
      await closeHttpsServer(server)
    },
  }
}

export async function startHttpsSpikeServices(
  options: StartHttpsSpikeServicesOptions,
): Promise<HttpsSpikeServices> {
  if (options.leafState === 'valid' && options.controlPort !== undefined) {
    throw new Error('HTTPS spike valid mode cannot start a control server')
  }
  if (options.leafState !== 'valid' && options.controlPort === undefined) {
    throw new Error('HTTPS spike invalid mode requires a control server')
  }
  if (options.port !== 0 && options.controlPort === options.port) {
    throw new Error('HTTPS spike control port must differ from the primary port')
  }
  if (options.lifecycleScenario !== undefined && options.leafState !== 'valid') {
    throw new Error('HTTPS lifecycle spike is only valid with a valid leaf')
  }
  const lifecycle = options.lifecycleScenario === undefined
    ? undefined
    : { scenario: options.lifecycleScenario, idleMs: options.lifecycleIdleMs }
  let server: HttpsSpikeServer | undefined
  try {
    server = await startHttpsSpikeServer({
      host: options.host,
      port: options.port,
      pki: selectHttpsSpikeLeafPki(options.pki, options.leafState),
      lifecycle,
    })
    const controlServer = options.controlPort === undefined
      ? undefined
      : await startHttpsSpikeServer({
        host: options.host,
        port: options.controlPort,
        pki: options.pki,
      })
    const primaryServer = server
    let stopped = false
    return {
      server: primaryServer,
      controlServer,
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        const results = await Promise.allSettled([
          primaryServer.stop(),
          ...(controlServer === undefined ? [] : [controlServer.stop()]),
        ])
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure !== undefined) throw failure.reason
      },
    }
  } catch (error) {
    await server?.stop().catch(() => undefined)
    throw error
  }
}

async function stopHttpsSpikeServers(servers: readonly HttpsSpikeServer[]): Promise<void> {
  const results = await Promise.allSettled(servers.map((server) => server.stop()))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure !== undefined) throw failure.reason
}

export async function startHttpsSecurityMatrixServices(
  options: StartHttpsSecurityMatrixServicesOptions,
): Promise<HttpsSecurityMatrixServices> {
  assertDistinctHttpsMatrixPorts(options.oldPort, options.rotatedPort, options.chainPort)
  const redirectTargetHits: HttpsSpikeRedirectHits = { count: 0 }
  let rotatedServer: HttpsSpikeServer | undefined
  let oldServer: HttpsSpikeServer | undefined
  let chainServer: HttpsSpikeServer | undefined
  try {
    rotatedServer = await startHttpsSpikeServer({
      host: options.host,
      port: options.rotatedPort,
      pki: {
        leafCertPem: options.pki.rotatedLeafCertPem,
        leafKeyPem: options.pki.rotatedLeafKeyPem,
      },
      redirectTargetHits,
    })
    oldServer = await startHttpsSpikeServer({
      host: options.host,
      port: options.oldPort,
      pki: options.pki,
      redirectTargetUrl: `${rotatedServer.baseUrl}${HTTPS_SPIKE_REDIRECT_TARGET_PATH}`,
      redirectTargetHits,
    })
    chainServer = await startHttpsSpikeServer({
      host: options.host,
      port: options.chainPort,
      pki: {
        leafCertPem: options.pki.chainLeafCertChainPem,
        leafKeyPem: options.pki.chainLeafKeyPem,
        pinCertificatePem: options.pki.chainLeafCertPem,
      },
    })
    const startedServers = [oldServer, rotatedServer, chainServer]
    let stopped = false
    return {
      oldServer,
      rotatedServer,
      chainServer,
      intermediateCertificatePinning: createHttpsSpikeCertificatePinning(options.pki.intermediateCaCertPem),
      rootCertificatePinning: createHttpsSpikeCertificatePinning(options.pki.caPem),
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        await stopHttpsSpikeServers(startedServers)
      },
    }
  } catch (error) {
    const startedServers = [chainServer, oldServer, rotatedServer]
      .filter((server): server is HttpsSpikeServer => server !== undefined)
    await stopHttpsSpikeServers(startedServers).catch(() => undefined)
    throw error
  }
}

function printUsage(): string {
  return 'Usage: corepack pnpm run dev:https-spike --host <RFC1918 IPv4> [--port <1-65535>] [--control-port <1-65535>] [--leaf-state <valid|wrong-san|expired>] [--lifecycle-scenario <idle|cancel|reconnect-dedup|wifi-recovery>] [--lifecycle-idle-ms <1-120000>] [--openssl <path>]'
}

export async function runHttpsSpikeCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseHttpsSpikeCliOptions(argv)
  const pki = await createTemporaryWssSpikePki({
    sanIp: options.host,
    opensslPath: options.opensslPath,
  })
  const cleanupOnExit = (): void => pki.cleanupSync()
  process.once('exit', cleanupOnExit)
  let services: HttpsSpikeServices | undefined
  try {
    services = await startHttpsSpikeServices({
      host: options.host,
      port: options.port,
      controlPort: options.controlPort,
      leafState: options.leafState,
      lifecycleScenario: options.lifecycleScenario,
      lifecycleIdleMs: options.lifecycleIdleMs,
      pki,
    })
    const { server, controlServer } = services
    console.log(`[DSHOS Link HTTPS Spike] httpsBaseUrl=${server.baseUrl}`)
    console.log(`[DSHOS Link HTTPS Spike] leafState=${options.leafState}`)
    console.log(`[DSHOS Link HTTPS Spike] caPemBase64Url=${pki.caPemBase64Url}`)
    console.log(`[DSHOS Link HTTPS Spike] okPath=${HTTPS_SPIKE_OK_PATH}`)
    console.log(`[DSHOS Link HTTPS Spike] eventsPath=${HTTPS_SPIKE_EVENTS_PATH}`)
    console.log(`[DSHOS Link HTTPS Spike] commandPath=${HTTPS_SPIKE_COMMAND_PATH}`)
    console.log(`[DSHOS Link HTTPS Spike] certificatePinning=${JSON.stringify(server.certificatePinning)}`)
    if (server.lifecycle !== undefined) {
      console.log(`[DSHOS Link HTTPS Spike] lifecycleRunId=${server.lifecycle.runId}`)
      console.log(`[DSHOS Link HTTPS Spike] lifecycleScenario=${server.lifecycle.scenario}`)
      if (server.lifecycle.idleMs !== undefined) {
        console.log(`[DSHOS Link HTTPS Spike] lifecycleIdleMs=${server.lifecycle.idleMs}`)
      }
      console.log(`[DSHOS Link HTTPS Spike] lifecycleEventsPath=${HTTPS_SPIKE_LIFECYCLE_EVENTS_PATH}`)
      console.log(`[DSHOS Link HTTPS Spike] lifecycleStatusPath=${HTTPS_SPIKE_LIFECYCLE_STATUS_PATH}`)
    }
    if (controlServer !== undefined) {
      console.log(`[DSHOS Link HTTPS Spike] controlHttpsBaseUrl=${controlServer.baseUrl}`)
      console.log(`[DSHOS Link HTTPS Spike] controlCertificatePinning=${JSON.stringify(controlServer.certificatePinning)}`)
    }
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await services?.stop().catch(() => undefined)
    await pki.cleanup().catch(() => undefined)
    process.removeListener('exit', cleanupOnExit)
  }
}

export function httpsSpikeUsage(): string {
  return printUsage()
}

function printSecurityMatrixUsage(): string {
  return 'Usage: corepack pnpm run dev:https-security-matrix --host <RFC1918 IPv4> [--old-port <1-65535>] [--rotated-port <1-65535>] [--chain-port <1-65535>] [--openssl <path>]'
}

export async function runHttpsSecurityMatrixCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseHttpsSecurityMatrixCliOptions(argv)
  const pki = await createTemporaryWssSpikePki({
    sanIp: options.host,
    opensslPath: options.opensslPath,
  })
  const cleanupOnExit = (): void => pki.cleanupSync()
  process.once('exit', cleanupOnExit)
  let services: HttpsSecurityMatrixServices | undefined
  try {
    services = await startHttpsSecurityMatrixServices({
      host: options.host,
      oldPort: options.oldPort,
      rotatedPort: options.rotatedPort,
      chainPort: options.chainPort,
      pki,
    })
    console.log(`[DSHOS Link HTTPS Matrix] oldBaseUrl=${services.oldServer.baseUrl}`)
    console.log(`[DSHOS Link HTTPS Matrix] rotatedBaseUrl=${services.rotatedServer.baseUrl}`)
    console.log(`[DSHOS Link HTTPS Matrix] chainBaseUrl=${services.chainServer.baseUrl}`)
    console.log(`[DSHOS Link HTTPS Matrix] caPemBase64Url=${pki.caPemBase64Url}`)
    console.log(`[DSHOS Link HTTPS Matrix] oldCertificatePinning=${JSON.stringify(services.oldServer.certificatePinning)}`)
    console.log(`[DSHOS Link HTTPS Matrix] rotatedCertificatePinning=${JSON.stringify(services.rotatedServer.certificatePinning)}`)
    console.log(`[DSHOS Link HTTPS Matrix] chainLeafCertificatePinning=${JSON.stringify(services.chainServer.certificatePinning)}`)
    console.log(`[DSHOS Link HTTPS Matrix] intermediateCertificatePinning=${JSON.stringify(services.intermediateCertificatePinning)}`)
    console.log(`[DSHOS Link HTTPS Matrix] rootCertificatePinning=${JSON.stringify(services.rootCertificatePinning)}`)
    console.log(`[DSHOS Link HTTPS Matrix] redirectPath=${HTTPS_SPIKE_REDIRECT_PATH}`)
    console.log(`[DSHOS Link HTTPS Matrix] redirectStatusPath=${HTTPS_SPIKE_REDIRECT_STATUS_PATH}`)
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await services?.stop().catch(() => undefined)
    await pki.cleanup().catch(() => undefined)
    process.removeListener('exit', cleanupOnExit)
  }
}

export function httpsSecurityMatrixUsage(): string {
  return printSecurityMatrixUsage()
}
