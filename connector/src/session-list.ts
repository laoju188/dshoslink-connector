import { createHash } from 'node:crypto'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'

export const SESSION_LIST_PATH = '/dshos/v1/sessions'
export const CONNECTION_GENERATION_HEADER = 'X-DSHOS-Link-Connection-Generation'
export const MAX_SESSION_LIST_ITEMS = 100
export const MAX_SESSION_ID_CHARS = 256
export const MAX_SESSION_TITLE_CHARS = 200

export interface SessionListAuthorizer {
  authorize(authorization: unknown, connectionGeneration: unknown): boolean
}

export interface SessionListSourceRecord {
  readonly header: {
    readonly id: string
    readonly createdAt: number
  }
  readonly live: boolean
  readonly persisted: boolean
}

export type SessionListTitleResult =
  | {
    readonly sessionId: string
    readonly status: 'fulfilled'
    readonly value: { readonly title?: { readonly title: string } }
  }
  | {
    readonly sessionId: string
    readonly status: 'rejected'
  }

export interface SessionListSource {
  listSessions(signal?: AbortSignal): Promise<readonly SessionListSourceRecord[]>
  readTitleSnapshots(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly SessionListTitleResult[]>
}

interface ProjectedSession {
  readonly sessionId: string
  readonly createdAt: number
  readonly live: boolean
  readonly persisted: boolean
  readonly title?: string
}

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

function validRecord(record: SessionListSourceRecord): boolean {
  return typeof record === 'object'
    && record !== null
    && typeof record.header === 'object'
    && record.header !== null
    && typeof record.header.id === 'string'
    && record.header.id.length > 0
    && record.header.id.length <= MAX_SESSION_ID_CHARS
    && Number.isSafeInteger(record.header.createdAt)
    && record.header.createdAt >= 0
    && typeof record.live === 'boolean'
    && typeof record.persisted === 'boolean'
    && (record.live || record.persisted)
}

function boundedTitle(value: string): string | undefined {
  if (value.length === 0) return undefined
  const characters = Array.from(value)
  return characters.slice(0, MAX_SESSION_TITLE_CHARS).join('')
}

function titleMap(
  results: readonly SessionListTitleResult[],
  sessionIds: readonly string[],
): Map<string, string> | undefined {
  const expected = new Set(sessionIds)
  const seen = new Set<string>()
  const titles = new Map<string, string>()
  for (const result of results) {
    if (typeof result !== 'object'
      || result === null
      || typeof result.sessionId !== 'string'
      || !expected.has(result.sessionId)
      || seen.has(result.sessionId)
      || (result.status !== 'fulfilled' && result.status !== 'rejected')) return undefined
    seen.add(result.sessionId)
    if (result.status === 'fulfilled' && result.value.title !== undefined) {
      if (typeof result.value !== 'object'
        || result.value === null
        || typeof result.value.title !== 'object'
        || result.value.title === null
        || typeof result.value.title.title !== 'string') return undefined
      const title = boundedTitle(result.value.title.title)
      if (title !== undefined) titles.set(result.sessionId, title)
    }
  }
  return seen.size === sessionIds.length ? titles : undefined
}

interface PageRequest {
  readonly type: 'session_list_page_request'
  readonly protocolVersion: 2
  readonly offset: number
  readonly limit: number
  readonly revision: string | null
}
const PAGE_RESPONSE_MAX_BYTES = 131072
function parsePageRequest(request: PairingV1HttpRequest): PageRequest | undefined {
  if (request.contentType !== 'application/json' || request.body.byteLength > 512) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body)
    const value = JSON.parse(text) as PageRequest
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).join(',') !== 'type,protocolVersion,offset,limit,revision'
      || JSON.stringify(value) !== text || value.type !== 'session_list_page_request' || value.protocolVersion !== 2
      || !Number.isSafeInteger(value.offset) || value.offset < 0
      || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_SESSION_LIST_ITEMS
      || !(value.revision === null || (typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision)))
      || (value.offset > 0 && value.revision === null)) return undefined
    return value
  } catch { return undefined }
}
// Directory revision binds membership, order and creation facts, not volatile titles/live flags.
// It is a consistency token, never authorization and never persisted or cached across accounts.
function directoryRevision(records: readonly SessionListSourceRecord[]): string {
  const hash = createHash('sha256').update('dshos-session-list-v2\n')
  for (const record of records) hash.update(JSON.stringify([record.header.id, record.header.createdAt]) + '\n')
  return hash.digest('hex')
}
export function createSessionListRequestHandler(
  authorizer: SessionListAuthorizer,
  source?: SessionListSource,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_LIST_PATH) return emptyResponse(404)
    if (request.method !== 'GET' && request.method !== 'POST') return emptyResponse(405)
    if (request.path !== barePath || !(request.body instanceof Uint8Array)) return emptyResponse(400)
    let page: PageRequest | undefined
    if (request.method === 'GET') {
      if (request.contentType !== undefined || request.body.byteLength !== 0) return emptyResponse(400)
    } else {
      if (request.body.byteLength === 0) return emptyResponse(405)
      page = parsePageRequest(request)
      if (page === undefined) return emptyResponse(400)
    }
    const authorized = () => !request.signal?.aborted
      && authorizer.authorize(request.authorization, request.connectionGeneration)
    if (!authorized()) return emptyResponse(401)
    if (source === undefined) return emptyResponse(503)
    try {
      const allRecords = await source.listSessions(request.signal)
      if (!authorized()) return emptyResponse(401)
      if (!Array.isArray(allRecords) || !allRecords.every(validRecord)) return emptyResponse(503)
      const revision = page === undefined ? undefined : directoryRevision(allRecords)
      if (page !== undefined) {
        if (new Set(allRecords.map(record => record.header.id)).size !== allRecords.length) return emptyResponse(503)
        if ((page.revision !== null && page.revision !== revision)
          || (page.offset >= allRecords.length && !(page.offset === 0 && allRecords.length === 0))) return emptyResponse(409)
      }
      const total = allRecords.length
      const offset = page?.offset ?? 0
      // Snapshot public facts before the next await; do not retain mutable host records.
      const records = allRecords.slice(offset, offset + (page?.limit ?? MAX_SESSION_LIST_ITEMS))
        .map(record => ({ header: { id: record.header.id, createdAt: record.header.createdAt }, live: record.live, persisted: record.persisted }))
      const sessionIds = records.map(record => record.header.id)
      if (new Set(sessionIds).size !== sessionIds.length) return emptyResponse(503)
      const titleResults = await source.readTitleSnapshots(sessionIds, request.signal)
      if (!authorized()) return emptyResponse(401)
      const titles = titleMap(titleResults, sessionIds)
      if (titles === undefined) return emptyResponse(503)
      const sessions: ProjectedSession[] = []
      let bytes = 1024 // Upper bound for V2 envelope, safe integer positions and separators.
      for (const record of records) {
        const title = titles.get(record.header.id)
        const item: ProjectedSession = {
          sessionId: record.header.id, createdAt: record.header.createdAt,
          live: record.live, persisted: record.persisted,
          ...(title === undefined ? {} : { title }),
        }
        const size = Buffer.byteLength(JSON.stringify(item)) + 1
        if (page !== undefined && bytes + size > PAGE_RESPONSE_MAX_BYTES) break
        sessions.push(item); bytes += size
      }
      const body = page === undefined ? JSON.stringify({
        type: 'session_list', protocolVersion: 1, truncated: total > MAX_SESSION_LIST_ITEMS, sessions,
      }) : JSON.stringify({
        type: 'session_list_page', protocolVersion: 2, revision, total, offset,
        nextOffset: offset + sessions.length < total ? offset + sessions.length : null, sessions,
      })
      if (page !== undefined && (Buffer.byteLength(body) > PAGE_RESPONSE_MAX_BYTES
        || (records.length > 0 && sessions.length === 0))) return emptyResponse(503)
      if (!authorized()) return emptyResponse(401)
      return { status: 200, contentType: 'application/json', body }
    } catch {
      return emptyResponse(authorized() ? 503 : 401)
    }
  }
}
