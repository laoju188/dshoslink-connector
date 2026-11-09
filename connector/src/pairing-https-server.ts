import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from 'node:https'
import { isIPv4 } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  MAX_PAIRING_MESSAGE_BYTES,
  type PairingV1HttpRequest,
  type PairingV1HttpResponse,
} from './pairing-backend.js'
import { CONNECTION_GENERATION_HEADER } from './session-list.js'
import type {AuthenticationObserver} from './authentication-observations.js'

export const MAX_PAIRING_HTTPS_REQUEST_BYTES = 16 * 1_024

export interface PairingHttpsRequestContext {
  readonly remoteAddress: string | undefined
}

export type PairingHttpsResponse = PairingV1HttpResponse |
  { readonly status: 200; readonly contentType: 'application/octet-stream'; readonly body: Buffer }

export type PairingHttpsRequestHandler = (
  request: PairingV1HttpRequest,
  context: PairingHttpsRequestContext,
) => PairingHttpsResponse | Promise<PairingHttpsResponse>

export interface PairingHttpsServerOptions {
  readonly observeAuthentication?: AuthenticationObserver
  readonly authenticationScope?: () => string
  readonly host: string
  readonly port: number
  readonly key: Buffer
  readonly cert: Buffer
  readonly handler: PairingHttpsRequestHandler
  readonly observe?: (result: 'tls_failed' | 'request_rejected' | 'request_aborted') => void
  readonly requestByteLimit?: (
    path: string,
    authorization: string | undefined,
    connectionGeneration: string | undefined,
  ) => number | undefined
}

export interface PairingHttpsServer {
  readonly host: string
  readonly port: number
  readonly baseUrl: string
  updateIdentity(key: Buffer, cert: Buffer): void
  stop(): Promise<void>
}

function isRfc1918Ipv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function send(response: ServerResponse, result: PairingHttpsResponse): void {
  const headers: Record<string, string | number> = {
    'Content-Length': Buffer.byteLength(result.body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (result.contentType !== undefined) headers['Content-Type'] = result.contentType
  response.writeHead(result.status, headers)
  response.end(result.body)
}

function sendEmpty(response: ServerResponse, status: number): void {
  send(response, { status, body: '' })
}

function contentType(request: IncomingMessage): string | undefined {
  const value = request.headers['content-type']
  return typeof value === 'string' ? value : undefined
}

function stringHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: PairingHttpsRequestHandler,
  requestByteLimit?: PairingHttpsServerOptions['requestByteLimit'],
): void {
  const authorization = stringHeader(request, 'authorization')
  const connectionGeneration = stringHeader(request, CONNECTION_GENERATION_HEADER)
  const requestLimit = requestByteLimit?.(
    request.url ?? '', authorization, connectionGeneration,
  ) ?? MAX_PAIRING_HTTPS_REQUEST_BYTES
  let size = 0
  let complete = false
  const chunks: Buffer[] = []
  const wipeChunks = (): void => {
    for (const chunk of chunks) chunk.fill(0)
    chunks.length = 0
  }
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > requestLimit)) {
    complete = true
    request.resume()
    sendEmpty(response, 413)
    return
  }

  request.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (complete) {
      bytes.fill(0)
      return
    }
    size += bytes.byteLength
    if (size > requestLimit) {
      complete = true
      bytes.fill(0)
      wipeChunks()
      request.resume()
      sendEmpty(response, 413)
      return
    }
    chunks.push(bytes)
  })
  request.on('end', async () => {
    if (complete) return
    complete = true
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    request.once('aborted', abort)
    response.once('close', abort)
    let body: Buffer | undefined
    try {
      body = Buffer.concat(chunks, size)
      const result = await handler({
        method: request.method ?? '',
        path: request.url ?? '',
        contentType: contentType(request),
        body,
        authorization,
        connectionGeneration,
        signal: controller.signal,
      }, { remoteAddress: request.socket.remoteAddress })
      if (!response.destroyed) send(response, result)
    } catch {
      if (!response.destroyed) sendEmpty(response, 500)
    } finally {
      request.off('aborted', abort)
      response.off('close', abort)
      body?.fill(0)
      wipeChunks()
    }
  })
  request.on('aborted', () => {
    complete = true
    wipeChunks()
  })
  request.on('error', () => {
    complete = true
    wipeChunks()
    response.destroy()
  })
}

function listen(server: HttpsServer, host: string, port: number): Promise<void> {
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

function closeServer(server: HttpsServer, sockets: ReadonlySet<Duplex>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
    server.closeAllConnections()
    for (const socket of sockets) socket.destroy()
  })
}

export async function startPairingHttpsServer(
  options: PairingHttpsServerOptions,
): Promise<PairingHttpsServer> {
  if (!isRfc1918Ipv4(options.host)) {
    throw new Error('Pairing HTTPS host must be an explicit RFC1918 IPv4 address')
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('Pairing HTTPS port must be an integer from 1 to 65535')
  }
  const server = createHttpsServer({
    key: options.key,
    cert: options.cert,
  },
    (request, response) => {
      const trace=stringHeader(request,'x-dshos-auth-trace')
      const phase=request.url==='/pairing/v1/auth/start'?'start':request.url==='/pairing/v1/auth/response'?'response':undefined
      if(trace&&/^[A-Za-z0-9_-]{21}[AQgw]$/.test(trace)&&phase&&request.method==='POST'){
        let owner:string|undefined
        try{owner=options.authenticationScope?.()}catch{/* Observation cannot block authentication. */}
        const note=(stage:string,result:string):void=>{try{if(options.authenticationScope?.()===owner)options.observeAuthentication?.(trace,stage,result)}catch{}}
        note(phase==='start'?'start_received':'response_received','started')
        response.once('finish',()=>note(phase==='start'?'challenge_written':'result_written',response.statusCode===200?'ok':'rejected'))
        // A finished socket write is not proof of receipt on the phone.
      }
      if(request.url?.startsWith('/dshos/v2/enrollment/')) {
        response.once('finish',()=>{if(response.statusCode>=400)observe('request_rejected')})
        request.once('aborted',()=>observe('request_aborted'))
      }
      handleRequest(request,response,options.handler,options.requestByteLimit)
    })
  const observe=(result: 'tls_failed' | 'request_rejected' | 'request_aborted'):void=>{
    try { options.observe?.(result) } catch { /* Diagnostic failures must not affect listener. */ }
  }
  server.on('tlsClientError',()=>observe('tls_failed'))
  server.maxConnections = 16
  const sockets = new Set<Duplex>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (error, socket) => {
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
    baseUrl: `https://${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`,
    updateIdentity(key: Buffer, cert: Buffer): void {
      if (stopped) throw Error('pairing_https_closed')
      server.setSecureContext({key,cert})
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await closeServer(server, sockets)
    },
  })
}
