import { X509Certificate } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { isIPv4 } from 'node:net'

export const PAIRING_BOOTSTRAP_PATH = '/pairing/v1/bootstrap'
export const MAX_PAIRING_BOOTSTRAP_CA_DER_BYTES = 1_024
export const PAIRING_BOOTSTRAP_PORT_ENV = 'DSHOS_LINK_PAIRING_BOOTSTRAP_PORT'
export const DEFAULT_PAIRING_BOOTSTRAP_PORT = 24_691

export interface PairingBootstrapHttpOptions {
  readonly host: string
  readonly port: number
  readonly caDer: Uint8Array
  readonly observe?: (result: 'served' | 'rejected') => void
}

export interface PairingBootstrapHttpServer {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  stop(): Promise<void>
}

function isRfc1918Ipv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function send(response: ServerResponse, status: number, body = ''): void {
  const headers: Record<string, string | number> = {
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (body !== '') headers['Content-Type'] = 'application/json'
  response.writeHead(status, headers)
  response.end(body)
}

function hasBody(request: IncomingMessage): boolean {
  const length = request.headers['content-length']
  return request.headers['transfer-encoding'] !== undefined
    || (length !== undefined && length !== '0')
}

function handleRequest(request: IncomingMessage, response: ServerResponse, body: string, enrollmentBody: string): void {
  if (request.url !== PAIRING_BOOTSTRAP_PATH && request.url !== '/dshos/v2/enrollment/bootstrap') {
    request.resume()
    send(response, 404)
    return
  }
  if (request.method !== 'GET') {
    request.resume()
    send(response, 405)
    return
  }
  if (hasBody(request)
    || request.headers.authorization !== undefined
    || request.headers.cookie !== undefined) {
    request.resume()
    send(response, 400)
    return
  }
  send(response, 200, request.url === PAIRING_BOOTSTRAP_PATH ? body : enrollmentBody)
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
    server.closeAllConnections()
  })
}

export async function startPairingBootstrapHttpServer(
  options: PairingBootstrapHttpOptions,
): Promise<PairingBootstrapHttpServer> {
  if (!isRfc1918Ipv4(options.host)) {
    throw new Error('Pairing bootstrap host must be an explicit RFC1918 IPv4 address')
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('Pairing bootstrap port must be an integer from 1 to 65535')
  }
  let caDer: Buffer
  try {
    if (!(options.caDer instanceof Uint8Array)
      || options.caDer.byteLength < 1
      || options.caDer.byteLength > MAX_PAIRING_BOOTSTRAP_CA_DER_BYTES) throw new Error()
    caDer = Buffer.from(options.caDer)
    if (!new X509Certificate(caDer).ca) throw new Error()
  } catch {
    throw new Error('Pairing bootstrap CA must be a valid CA certificate')
  }
  const body = JSON.stringify({
    type: 'pairing_bootstrap',
    pairingVersion: 1,
    ca: caDer.toString('base64url'),
  })
  const enrollmentBody = JSON.stringify({ contract: 'dshos-dsh-enrollment-bootstrap-v2', ca: caDer.toString('base64url') })
  caDer.fill(0)

  const server = createServer((request, response) => {
    if(request.url?.split(/[?#]/,1)[0]==='/dshos/v2/enrollment/bootstrap')response.once('finish',()=>{
      try { options.observe?.(response.statusCode===200?'served':'rejected') } catch { /* Optional diagnostic. */ }
    })
    handleRequest(request,response,body,enrollmentBody)
  })
  server.maxConnections = 16
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  try {
    await listen(server, options.host, options.port)
  } catch (error) {
    server.closeAllConnections()
    throw error
  }

  let stopped = false
  return Object.freeze({
    host: options.host,
    port: options.port,
    baseUrl: `http://${options.host}:${options.port}`,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await closeServer(server)
    },
  })
}
