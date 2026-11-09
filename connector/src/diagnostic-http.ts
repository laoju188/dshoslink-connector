import { performance } from 'node:perf_hooks'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
import { serializeDiagnosticReport, type DiagnosticReportV1 } from './diagnostic-contract.js'

export const DIAGNOSTIC_READ_PATH = '/dshos/v1/session-state'
export const DIAGNOSTIC_READ_BODY = '{"type":"diagnostic_report_request","protocolVersion":1}'
export function isDiagnosticReadBody(body: unknown): boolean {
  return body instanceof Uint8Array && body.byteLength <= 128 &&
    Buffer.from(body).equals(Buffer.from(DIAGNOSTIC_READ_BODY))
}
export interface DiagnosticReadSource { read(): DiagnosticReportV1 | undefined }

// One source per connector registration, shared by LAN and relay routers.
export function createDiagnosticReadSource(generate: () => DiagnosticReportV1,
  now: () => number = () => performance.now()): DiagnosticReadSource {
  let nextAllowed = -Infinity
  return { read() {
    const current = now()
    if (current < nextAllowed) return undefined
    nextAllowed = current + 60_000
    return generate()
  } }
}

export function createDiagnosticReadHandler(authorizer: SessionListAuthorizer, source?: DiagnosticReadSource) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const empty = (status: number): PairingV1HttpResponse => ({ status, body: '' })
    if (request.signal?.aborted || !authorizer.authorize(request.authorization, request.connectionGeneration)) return empty(401)
    if (request.method !== 'POST') return empty(405)
    if (request.path !== DIAGNOSTIC_READ_PATH || request.contentType !== 'application/json' ||
      !isDiagnosticReadBody(request.body)) return empty(400)
    if (source === undefined) return empty(404)
    try {
      const report = source.read()
      if (report === undefined) return empty(429)
      const body = serializeDiagnosticReport(report)
      if (request.signal?.aborted || !authorizer.authorize(request.authorization, request.connectionGeneration)) return empty(401)
      return { status: 200, contentType: 'application/json', body }
    } catch { return empty(503) }
  }
}
