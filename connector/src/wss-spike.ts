/**
 * Development-only WSS support for API 24 pairing feasibility tests.
 * It is intentionally not imported by the Cordis bundle or the V1 server.
 */
import { spawnSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import type { Server as HttpsServer } from 'node:https'
import { isIPv4 } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import type { RawData } from 'ws'

export const DEFAULT_WSS_SPIKE_PORT = 24681
export const WSS_SPIKE_PATH = '/spike/ed25519-verify'
export const WSS_SPIKE_REQUEST_TYPE = 'spike_ed25519_verify'
export const WSS_SPIKE_RESPONSE_TYPE = 'spike_ed25519_verify_result'
export const MAX_SPIKE_MESSAGE_BYTES = 12 * 1024
export const ED25519_PUBLIC_KEY_RAW_BYTES = 32
export const MAX_TRANSCRIPT_BYTES = 4096
export const ED25519_SIGNATURE_BYTES = 64

const SPIKE_REQUEST_KEYS = ['publicKeyRaw', 'signature', 'transcript', 'type']
const TEMP_PREFIX = 'dshos-link-wss-spike-'

export interface TemporaryWssSpikePki {
  readonly caPemPath: string
  readonly caDerPath: string
  readonly caPem: Buffer
  readonly caDer: Buffer
  readonly caPemBase64Url: string
  readonly leafCertPem: Buffer
  readonly leafKeyPem: Buffer
  readonly rotatedLeafCertPem: Buffer
  readonly rotatedLeafKeyPem: Buffer
  readonly intermediateCaCertPem: Buffer
  readonly chainLeafCertPem: Buffer
  readonly chainLeafCertChainPem: Buffer
  readonly chainLeafKeyPem: Buffer
  readonly expiredLeafCertPem: Buffer
  readonly expiredLeafKeyPem: Buffer
  readonly wrongSanCertPem: Buffer
  readonly wrongSanKeyPem: Buffer
  readonly untrustedCaPem: Buffer
  cleanup(): Promise<void>
  cleanupSync(): void
}

export interface WssSpikeServer {
  readonly host: string
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

interface StartWssSpikeServerOptions {
  host: string
  port: number
  pki: Pick<TemporaryWssSpikePki, 'leafCertPem' | 'leafKeyPem'>
}

interface CreateTemporaryWssSpikePkiOptions {
  sanIp: string
  wrongSanIp?: string
  opensslPath?: string
}

interface ParsedSpikeRequest {
  readonly publicKeyRaw: Buffer
  readonly transcript: Buffer
  readonly signature: Buffer
}

interface ParsedCliOptions {
  readonly host: string
  readonly port: number
  readonly sanIp: string
  readonly leafState: 'valid' | 'expired'
  readonly opensslPath?: string
}

function isRfc1918IPv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

export function validateWssSpikeHost(host: string): string {
  const normalized = host.trim()
  if (!isRfc1918IPv4(normalized)) {
    throw new Error('WSS spike host must be an explicit RFC1918 IPv4 address')
  }
  return normalized
}

function validatePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('WSS spike port must be an integer from 1 to 65535')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WSS spike port must be an integer from 1 to 65535')
  }
  return port
}

function parseCliOptions(argv: readonly string[]): ParsedCliOptions {
  let host: string | undefined
  let port = DEFAULT_WSS_SPIKE_PORT
  let sanIp: string | undefined
  let leafState: ParsedCliOptions['leafState'] = 'valid'
  let leafStateProvided = false
  let opensslPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = argv[index + 1]
    if (option === '--host') {
      if (host !== undefined || value === undefined) throw new Error('--host must be provided exactly once')
      host = validateWssSpikeHost(value)
      index += 1
    } else if (option === '--port') {
      if (value === undefined) throw new Error('--port requires a value')
      port = validatePort(value)
      index += 1
    } else if (option === '--san-ip') {
      if (sanIp !== undefined || value === undefined) throw new Error('--san-ip may be provided at most once')
      sanIp = validateWssSpikeHost(value)
      index += 1
    } else if (option === '--leaf-state') {
      if (leafStateProvided || (value !== 'valid' && value !== 'expired')) {
        throw new Error('--leaf-state must be valid or expired and provided at most once')
      }
      leafState = value
      leafStateProvided = true
      index += 1
    } else if (option === '--openssl') {
      if (opensslPath !== undefined || value === undefined) throw new Error('--openssl may be provided at most once')
      opensslPath = value
      index += 1
    } else {
      throw new Error(`Unknown WSS spike option: ${option}`)
    }
  }
  if (host === undefined) throw new Error('--host is required')
  return { host, port, sanIp: sanIp ?? host, leafState, opensslPath }
}

function tryOpenSsl(command: string): boolean {
  const result = spawnSync(command, ['version'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.error === undefined && result.status === 0
}

export function findOpenSsl(configuredPath?: string): string {
  const programFiles = process.env.ProgramFiles
  const windowsCandidates = process.platform === 'win32' && programFiles !== undefined
    ? [
      join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
      join(programFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'),
      join(programFiles, 'OpenSSL-Win64', 'bin', 'openssl.exe'),
    ]
    : []
  const candidates = [
    configuredPath,
    'openssl',
    ...windowsCandidates,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== '')
  for (const candidate of [...new Set(candidates)]) {
    if (tryOpenSsl(candidate)) return candidate
  }
  throw new Error('OpenSSL CLI was not found; install it or pass --openssl <path>')
}

function runOpenSsl(opensslPath: string, args: readonly string[]): void {
  const result = spawnSync(opensslPath, args, {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('OpenSSL certificate generation failed')
  }
}

function assertManagedTempDirectory(directory: string): void {
  const temporaryRoot = resolve(tmpdir())
  const resolved = resolve(directory)
  const pathToDirectory = relative(temporaryRoot, resolved)
  if (pathToDirectory === ''
    || pathToDirectory.startsWith('..')
    || pathToDirectory.includes('..\\')
    || pathToDirectory.includes('../')
    || !basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error('Refusing to clean a directory outside the WSS spike temporary root')
  }
}

function createLeafRequest(
  opensslPath: string,
  directory: string,
  prefix: string,
): void {
  const keyPath = join(directory, `${prefix}-key.pem`)
  const csrPath = join(directory, `${prefix}.csr`)
  runOpenSsl(opensslPath, ['genrsa', '-out', keyPath, '2048'])
  runOpenSsl(opensslPath, ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', '/CN=DSHOS Link WSS Spike Leaf'])
}

function createLeafCertificate(
  opensslPath: string,
  directory: string,
  prefix: string,
  caCertPath: string,
  caKeyPath: string,
): void {
  createLeafRequest(opensslPath, directory, prefix)
  const csrPath = join(directory, `${prefix}.csr`)
  const certPath = join(directory, `${prefix}.pem`)
  const extPath = join(directory, `${prefix}.ext`)
  runOpenSsl(opensslPath, [
    'x509', '-req', '-in', csrPath,
    '-CA', caCertPath,
    '-CAkey', caKeyPath,
    '-CAcreateserial',
    '-out', certPath,
    '-days', '2',
    '-sha256',
    '-extfile', extPath,
  ])
}

function formatOpenSslUtcDate(timestamp: number): string {
  const date = new Date(timestamp)
  const part = (value: number): string => value.toString().padStart(2, '0')
  return `${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}Z`
}

function opensslConfigPath(path: string): string {
  return resolve(path).replaceAll('\\', '/')
}

async function createExpiredLeafCertificate(
  opensslPath: string,
  directory: string,
  sanIp: string,
  caCertPath: string,
  caKeyPath: string,
): Promise<void> {
  const prefix = 'expired-leaf'
  createLeafRequest(opensslPath, directory, prefix)
  const databaseDirectory = join(directory, 'ca-database')
  const newCertificatesDirectory = join(databaseDirectory, 'newcerts')
  const databasePath = join(databaseDirectory, 'index.txt')
  const serialPath = join(databaseDirectory, 'serial')
  const configPath = join(directory, 'expired-leaf-ca.cnf')
  await mkdir(newCertificatesDirectory, { recursive: true })
  await writeFile(databasePath, '', 'utf8')
  await writeFile(serialPath, '1000\n', 'utf8')
  await writeFile(configPath, [
    '[ca]',
    'default_ca=spike_ca',
    '[spike_ca]',
    `database="${opensslConfigPath(databasePath)}"`,
    `new_certs_dir="${opensslConfigPath(newCertificatesDirectory)}"`,
    `certificate="${opensslConfigPath(caCertPath)}"`,
    `private_key="${opensslConfigPath(caKeyPath)}"`,
    `serial="${opensslConfigPath(serialPath)}"`,
    'default_md=sha256',
    'policy=policy_any',
    'unique_subject=no',
    'copy_extensions=none',
    '[policy_any]',
    'commonName=supplied',
    '[server_leaf]',
    `subjectAltName=IP:${sanIp}`,
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n'), 'utf8')
  const now = Date.now()
  runOpenSsl(opensslPath, [
    'ca', '-batch', '-config', configPath,
    '-in', join(directory, `${prefix}.csr`),
    '-out', join(directory, `${prefix}.pem`),
    '-startdate', formatOpenSslUtcDate(now - 2 * 24 * 60 * 60 * 1000),
    '-enddate', formatOpenSslUtcDate(now - 24 * 60 * 60 * 1000),
    '-extensions', 'server_leaf',
    '-notext',
  ])
}

async function writeLeafExtensions(directory: string, prefix: string, sanIp: string): Promise<void> {
  await writeFile(join(directory, `${prefix}.ext`), [
    `subjectAltName=IP:${sanIp}`,
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n'), 'utf8')
}

async function writeCaExtensions(directory: string): Promise<string> {
  const path = join(directory, 'ca.ext')
  await writeFile(path, [
    '[req]',
    'distinguished_name=req_distinguished_name',
    'x509_extensions=v3_ca',
    '[req_distinguished_name]',
    '[v3_ca]',
    'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,keyCertSign,cRLSign',
  ].join('\n'), 'utf8')
  return path
}

async function createIntermediateCaCertificate(
  opensslPath: string,
  directory: string,
  rootCaCertPath: string,
  rootCaKeyPath: string,
): Promise<void> {
  const keyPath = join(directory, 'intermediate-ca-key.pem')
  const csrPath = join(directory, 'intermediate-ca.csr')
  const certPath = join(directory, 'intermediate-ca.pem')
  const extensionsPath = join(directory, 'intermediate-ca.ext')
  await writeFile(extensionsPath, [
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    'keyUsage=critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid,issuer',
  ].join('\n'), 'utf8')
  runOpenSsl(opensslPath, ['genrsa', '-out', keyPath, '2048'])
  runOpenSsl(opensslPath, [
    'req', '-new', '-key', keyPath, '-out', csrPath,
    '-subj', '/CN=DSHOS Link HTTPS Spike Intermediate CA',
  ])
  runOpenSsl(opensslPath, [
    'x509', '-req', '-in', csrPath,
    '-CA', rootCaCertPath,
    '-CAkey', rootCaKeyPath,
    '-CAcreateserial',
    '-out', certPath,
    '-days', '2',
    '-sha256',
    '-extfile', extensionsPath,
  ])
}

function defaultWrongSanIp(sanIp: string): string {
  return sanIp === '127.0.0.1' ? '127.0.0.2' : '192.0.2.1'
}

export async function createTemporaryWssSpikePki(
  options: CreateTemporaryWssSpikePkiOptions,
): Promise<TemporaryWssSpikePki> {
  if (!isIPv4(options.sanIp)) throw new Error('WSS spike certificate SAN must be an IPv4 address')
  const wrongSanIp = options.wrongSanIp ?? defaultWrongSanIp(options.sanIp)
  if (!isIPv4(wrongSanIp)) throw new Error('WSS spike wrong-SAN certificate must use an IPv4 address')
  const opensslPath = findOpenSsl(options.opensslPath)
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
  assertManagedTempDirectory(directory)
  let cleaned = false
  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    await rm(directory, { recursive: true, force: true })
    cleaned = true
  }
  const cleanupSync = (): void => {
    if (cleaned) return
    rmSync(directory, { recursive: true, force: true })
    cleaned = true
  }

  try {
    const caKeyPath = join(directory, 'ca-key.pem')
    const caPemPath = join(directory, 'ca.pem')
    const caDerPath = join(directory, 'ca.der')
    const untrustedCaKeyPath = join(directory, 'untrusted-ca-key.pem')
    const untrustedCaPemPath = join(directory, 'untrusted-ca.pem')
    const caExtensionsPath = await writeCaExtensions(directory)
    await writeLeafExtensions(directory, 'leaf', options.sanIp)
    await writeLeafExtensions(directory, 'rotated-leaf', options.sanIp)
    await writeLeafExtensions(directory, 'chain-leaf', options.sanIp)
    await writeLeafExtensions(directory, 'wrong-san-leaf', wrongSanIp)
    runOpenSsl(opensslPath, ['genrsa', '-out', caKeyPath, '2048'])
    runOpenSsl(opensslPath, [
      'req', '-x509', '-new', '-sha256', '-key', caKeyPath,
      '-out', caPemPath, '-days', '2', '-subj', '/CN=DSHOS Link WSS Spike Test CA',
      '-config', caExtensionsPath, '-extensions', 'v3_ca',
    ])
    runOpenSsl(opensslPath, ['x509', '-in', caPemPath, '-outform', 'DER', '-out', caDerPath])
    runOpenSsl(opensslPath, ['genrsa', '-out', untrustedCaKeyPath, '2048'])
    runOpenSsl(opensslPath, [
      'req', '-x509', '-new', '-sha256', '-key', untrustedCaKeyPath,
      '-out', untrustedCaPemPath, '-days', '2', '-subj', '/CN=DSHOS Link WSS Spike Untrusted CA',
      '-config', caExtensionsPath, '-extensions', 'v3_ca',
    ])
    await createIntermediateCaCertificate(opensslPath, directory, caPemPath, caKeyPath)
    createLeafCertificate(opensslPath, directory, 'leaf', caPemPath, caKeyPath)
    createLeafCertificate(opensslPath, directory, 'rotated-leaf', caPemPath, caKeyPath)
    createLeafCertificate(
      opensslPath,
      directory,
      'chain-leaf',
      join(directory, 'intermediate-ca.pem'),
      join(directory, 'intermediate-ca-key.pem'),
    )
    createLeafCertificate(opensslPath, directory, 'wrong-san-leaf', caPemPath, caKeyPath)
    await createExpiredLeafCertificate(opensslPath, directory, options.sanIp, caPemPath, caKeyPath)

    const caPem = await readFile(caPemPath)
    const intermediateCaCertPem = await readFile(join(directory, 'intermediate-ca.pem'))
    const chainLeafCertPem = await readFile(join(directory, 'chain-leaf.pem'))
    return {
      caPemPath,
      caDerPath,
      caPem,
      caDer: await readFile(caDerPath),
      caPemBase64Url: caPem.toString('base64url'),
      leafCertPem: await readFile(join(directory, 'leaf.pem')),
      leafKeyPem: await readFile(join(directory, 'leaf-key.pem')),
      rotatedLeafCertPem: await readFile(join(directory, 'rotated-leaf.pem')),
      rotatedLeafKeyPem: await readFile(join(directory, 'rotated-leaf-key.pem')),
      intermediateCaCertPem,
      chainLeafCertPem,
      chainLeafCertChainPem: Buffer.concat([chainLeafCertPem, Buffer.from('\n'), intermediateCaCertPem]),
      chainLeafKeyPem: await readFile(join(directory, 'chain-leaf-key.pem')),
      expiredLeafCertPem: await readFile(join(directory, 'expired-leaf.pem')),
      expiredLeafKeyPem: await readFile(join(directory, 'expired-leaf-key.pem')),
      wrongSanCertPem: await readFile(join(directory, 'wrong-san-leaf.pem')),
      wrongSanKeyPem: await readFile(join(directory, 'wrong-san-leaf-key.pem')),
      untrustedCaPem: await readFile(untrustedCaPemPath),
      cleanup,
      cleanupSync,
    }
  } catch (error) {
    cleanupSync()
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeBase64Url(value: unknown, minimumBytes: number, maximumBytes: number): Buffer | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength < minimumBytes || decoded.byteLength > maximumBytes) return undefined
  if (decoded.toString('base64url') !== value) return undefined
  return decoded
}

function parseSpikeRequest(value: unknown): ParsedSpikeRequest | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.length !== SPIKE_REQUEST_KEYS.length
    || !keys.every((key, index) => key === SPIKE_REQUEST_KEYS[index])
    || value.type !== WSS_SPIKE_REQUEST_TYPE) return undefined
  const publicKeyRaw = decodeBase64Url(
    value.publicKeyRaw,
    ED25519_PUBLIC_KEY_RAW_BYTES,
    ED25519_PUBLIC_KEY_RAW_BYTES,
  )
  const transcript = decodeBase64Url(value.transcript, 1, MAX_TRANSCRIPT_BYTES)
  const signature = decodeBase64Url(value.signature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES)
  if (publicKeyRaw === undefined || transcript === undefined || signature === undefined) return undefined
  return { publicKeyRaw, transcript, signature }
}

export function verifyEd25519SpikeRequest(value: unknown): boolean {
  const request = parseSpikeRequest(value)
  if (request === undefined) return false
  try {
    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: request.publicKeyRaw.toString('base64url'),
      },
      format: 'jwk',
    })
    if (publicKey.asymmetricKeyType !== 'ed25519') return false
    return verify(null, request.transcript, publicKey, request.signature)
  } catch {
    return false
  }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  return Buffer.from(data)
}

function rejectSpikeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'invalid_spike_request')
  else socket.terminate()
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

function closeHttpsServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

export async function startWssSpikeServer(options: StartWssSpikeServerOptions): Promise<WssSpikeServer> {
  const host = options.host.trim()
  if (!isIPv4(host)) throw new Error('WSS spike server host must be an IPv4 address')
  const httpsServer = createHttpsServer({
    key: options.pki.leafKeyPem,
    cert: options.pki.leafCertPem,
  }, (_request, response) => {
    response.writeHead(404)
    response.end()
  })
  const webSocketServer = new WebSocketServer({
    server: httpsServer,
    path: WSS_SPIKE_PATH,
    maxPayload: MAX_SPIKE_MESSAGE_BYTES,
  })
  webSocketServer.on('connection', (socket) => {
    socket.on('error', () => {})
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        rejectSpikeSocket(socket)
        return
      }
      const raw = rawDataToBuffer(data)
      if (raw.byteLength > MAX_SPIKE_MESSAGE_BYTES) {
        rejectSpikeSocket(socket)
        return
      }
      let message: unknown
      try {
        message = JSON.parse(raw.toString('utf8'))
      } catch {
        rejectSpikeSocket(socket)
        return
      }
      if (parseSpikeRequest(message) === undefined) {
        rejectSpikeSocket(socket)
        return
      }
      socket.send(JSON.stringify({
        type: WSS_SPIKE_RESPONSE_TYPE,
        valid: verifyEd25519SpikeRequest(message),
      }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    httpsServer.once('listening', resolve)
    httpsServer.once('error', reject)
    httpsServer.listen(options.port, host)
  }).catch(async (error: unknown) => {
    await closeWebSocketServer(webSocketServer).catch(() => undefined)
    await closeHttpsServer(httpsServer).catch(() => undefined)
    throw error
  })

  const address = httpsServer.address()
  if (address === null || typeof address === 'string') {
    await closeWebSocketServer(webSocketServer).catch(() => undefined)
    await closeHttpsServer(httpsServer).catch(() => undefined)
    throw new Error('WSS spike server did not expose an IPv4 address')
  }
  const port = (address as AddressInfo).port
  let stopped = false
  return {
    host,
    port,
    url: `wss://${host}:${port}${WSS_SPIKE_PATH}`,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      for (const client of webSocketServer.clients) client.terminate()
      await closeWebSocketServer(webSocketServer)
      await closeHttpsServer(httpsServer)
    },
  }
}

function printUsage(): string {
  return 'Usage: corepack pnpm run dev:wss-spike --host <RFC1918 IPv4> [--port <1-65535>] [--san-ip <RFC1918 IPv4>] [--leaf-state <valid|expired>] [--openssl <path>]'
}

export async function runWssSpikeCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv)
  const pki = await createTemporaryWssSpikePki({
    sanIp: options.sanIp,
    opensslPath: options.opensslPath,
  })
  const cleanupOnExit = (): void => pki.cleanupSync()
  process.once('exit', cleanupOnExit)
  let server: WssSpikeServer | undefined
  try {
    const serverPki = options.leafState === 'expired'
      ? { leafCertPem: pki.expiredLeafCertPem, leafKeyPem: pki.expiredLeafKeyPem }
      : pki
    server = await startWssSpikeServer({ host: options.host, port: options.port, pki: serverPki })
    console.log(`[DSHOS Link WSS Spike] listening=${server.url}`)
    console.log(`[DSHOS Link WSS Spike] leafState=${options.leafState}`)
    console.log(`[DSHOS Link WSS Spike] caPemBase64Url=${pki.caPemBase64Url}`)
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  } finally {
    await server?.stop().catch(() => undefined)
    await pki.cleanup().catch(() => undefined)
    process.removeListener('exit', cleanupOnExit)
  }
}

export function wssSpikeUsage(): string {
  return printUsage()
}
