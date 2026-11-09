import { createHash, randomBytes as systemRandomBytes, type Hash } from 'node:crypto'
import { fstatSync, lstatSync, realpathSync, linkSync, unlinkSync } from 'node:fs'
import {
  access,
  mkdir,
  open,
  realpath,
  stat,
  type FileHandle,
} from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type {
  PairingV1HttpRequest,
  PairingV1HttpResponse,
} from './pairing-backend.js'
import {
  MAX_SESSION_ID_CHARS,
  type SessionListAuthorizer,
} from './session-list.js'

export const SESSION_FILE_START_PATH = '/dshos/v1/session-file/start'
export const SESSION_FILE_CHUNK_PATH = '/dshos/v1/session-file/chunk'
export const SESSION_FILE_FINISH_PATH = '/dshos/v1/session-file/finish'
export const SESSION_FILE_ABORT_PATH = '/dshos/v1/session-file/abort'
export const SESSION_FILE_DIRECTORY_NAME = '.dshoslink-mobile-files'
export const SESSION_FILE_CHUNK_BYTES = 4 * 1_024 * 1_024
export const MAX_SESSION_FILE_BYTES = 200 * 1_024 * 1_024
export const MAX_SESSION_FILE_CHUNK_REQUEST_BYTES = SESSION_FILE_CHUNK_BYTES + 64

const SESSION_FILE_TEMP_DIRECTORY_NAME = '.tmp'
const SESSION_FILE_IDLE_TIMEOUT_MS = 120_000
const MAX_FILE_NAME_BYTES = 240
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const WINDOWS_INVALID_FILE_NAME = /[<>:"/\\|?*\u0000-\u001f]/
const WINDOWS_RESERVED_FILE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

export interface SessionFileSource {
  readSurface(sessionId: string): Promise<unknown>
}

export interface SessionFileUploadServiceDependencies {
  readonly randomBytes?: (size: number) => Uint8Array
}

interface SessionFileStartRequest {
  readonly sessionId: string
  readonly fileName: string
  readonly size: number
}

interface SessionFileFinishRequest {
  readonly uploadId: string
  readonly sha256: string
}

interface SessionFileAbortRequest {
  readonly uploadId: string
}

interface SessionFileChunkRequest {
  readonly uploadId: string
  readonly offset: number
  readonly bytes: Buffer
}

interface ActiveUpload {
  readonly uploadId: string
  readonly fileName: string
  readonly size: number
  readonly relativePath: string
  readonly temporaryPath: string
  readonly targetPath: string
  readonly handle: FileHandle
  readonly hash: Hash
  readonly authorization: string | undefined
  readonly generation: string | undefined
  readonly directories: readonly DirectoryIdentity[]
  readonly fileIdentity: FileIdentity
  offset: number
  busy: boolean
  closed: boolean
  timer?: NodeJS.Timeout
}

interface FileIdentity { readonly dev: number; readonly ino: number }
interface DirectoryIdentity extends FileIdentity { readonly path: string }
class UploadBoundaryError extends Error {
  constructor(readonly status: 401 | 409) { super('upload boundary changed') }
}
function directoryIdentity(path: string): DirectoryIdentity {
  const value = lstatSync(path)
  if (!value.isDirectory() || value.isSymbolicLink() || realpathSync(path) !== path) throw new UploadBoundaryError(409)
  return { path, dev: value.dev, ino: value.ino }
}
function checkDirectories(active: ActiveUpload): void {
  for (const previous of active.directories) {
    const current = directoryIdentity(previous.path)
    if (previous.dev !== current.dev || previous.ino !== current.ino) throw new UploadBoundaryError(409)
  }
}
function sameFile(path: string, identity: FileIdentity): boolean {
  try {
    const value = lstatSync(path)
    return value.isFile() && !value.isSymbolicLink() && value.dev === identity.dev && value.ino === identity.ino
  } catch { return false }
}

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameFields(actual: string[], expected: readonly string[]): boolean {
  actual.sort()
  const sortedExpected = [...expected].sort()
  return actual.length === expected.length
    && actual.every((value, index) => value === sortedExpected[index])
}

function parseJson(body: Uint8Array): unknown {
  if (!(body instanceof Uint8Array) || body.byteLength === 0 || body.byteLength > 4_096) {
    return undefined
  }
  try {
    const text = UTF8_DECODER.decode(body)
    const value: unknown = JSON.parse(text)
    return JSON.stringify(value) === text ? value : undefined
  } catch {
    return undefined
  }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_CHARS
}

function validFileName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value) <= MAX_FILE_NAME_BYTES
    && value !== '.'
    && value !== '..'
    && value === value.trim()
    && !value.endsWith('.')
    && !WINDOWS_INVALID_FILE_NAME.test(value)
    && !WINDOWS_RESERVED_FILE_NAME.test(value)
}

function parseStart(body: Uint8Array): SessionFileStartRequest | undefined {
  const value = parseJson(body)
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['type', 'protocolVersion', 'sessionId', 'fileName', 'size'])
    || value.type !== 'session_file_upload_start'
    || value.protocolVersion !== 1
    || !validSessionId(value.sessionId)
    || !validFileName(value.fileName)
    || !Number.isSafeInteger(value.size)
    || Number(value.size) < 0) return undefined
  return { sessionId: value.sessionId, fileName: value.fileName, size: Number(value.size) }
}

function parseFinish(body: Uint8Array): SessionFileFinishRequest | undefined {
  const value = parseJson(body)
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['type', 'protocolVersion', 'uploadId', 'sha256'])
    || value.type !== 'session_file_upload_finish'
    || value.protocolVersion !== 1
    || typeof value.uploadId !== 'string'
    || !UPLOAD_ID_PATTERN.test(value.uploadId)
    || typeof value.sha256 !== 'string'
    || !SHA256_PATTERN.test(value.sha256)) return undefined
  return { uploadId: value.uploadId, sha256: value.sha256 }
}

function parseAbort(body: Uint8Array): SessionFileAbortRequest | undefined {
  const value = parseJson(body)
  if (!isObject(value)
    || !sameFields(Object.keys(value), ['type', 'protocolVersion', 'uploadId'])
    || value.type !== 'session_file_upload_abort'
    || value.protocolVersion !== 1
    || typeof value.uploadId !== 'string'
    || !UPLOAD_ID_PATTERN.test(value.uploadId)) return undefined
  return { uploadId: value.uploadId }
}

function parseChunk(body: Uint8Array): SessionFileChunkRequest | undefined {
  if (!(body instanceof Uint8Array)
    || body.byteLength === 0
    || body.byteLength > MAX_SESSION_FILE_CHUNK_REQUEST_BYTES) return undefined
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const newline = view.indexOf(0x0a)
  if (newline < 1 || newline > 48) return undefined
  const prefix = view.subarray(0, newline).toString('ascii')
  const separator = prefix.indexOf(':')
  if (separator !== 22 || prefix.indexOf(':', separator + 1) !== -1) return undefined
  const uploadId = prefix.slice(0, separator)
  const offsetText = prefix.slice(separator + 1)
  if (!UPLOAD_ID_PATTERN.test(uploadId)
    || !/^(?:0|[1-9]\d{0,8})$/.test(offsetText)) return undefined
  const offset = Number(offsetText)
  const bytes = view.subarray(newline + 1)
  if (!Number.isSafeInteger(offset) || bytes.byteLength === 0 || bytes.byteLength > SESSION_FILE_CHUNK_BYTES) {
    return undefined
  }
  return { uploadId, offset, bytes }
}

function surfaceCwd(value: unknown, sessionId: string): string | undefined {
  if (!isObject(value)
    || !isObject(value.session)
    || value.session.id !== sessionId
    || typeof value.session.cwd !== 'string'
    || !isAbsolute(value.session.cwd)) return undefined
  return value.session.cwd
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function checkedDirectory(parent: string, name: string): Promise<string> {
  const expected = join(parent, name)
  await mkdir(expected, { recursive: true })
  const actual = await realpath(expected)
  if (relative(parent, actual) !== name || !(await stat(actual)).isDirectory() || lstatSync(expected).isSymbolicLink()) {
    throw new Error('unsafe session file directory')
  }
  return actual
}

export function sessionFileRequestByteLimit(path: string): number | undefined {
  return path === SESSION_FILE_CHUNK_PATH ? MAX_SESSION_FILE_CHUNK_REQUEST_BYTES : undefined
}

export class SessionFileUploadService {
  private active: ActiveUpload | undefined = undefined
  private disposed: boolean = false
  private starting = false
  private readonly randomBytes: (size: number) => Uint8Array

  constructor(
    private readonly authorizer: SessionListAuthorizer,
    private readonly source?: SessionFileSource,
    dependencies: SessionFileUploadServiceDependencies = {},
  ) {
    this.randomBytes = dependencies.randomBytes ?? systemRandomBytes
  }

  async handle(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    const barePath = request.path.split(/[?#]/, 1)[0]!
    if (barePath !== SESSION_FILE_START_PATH
      && barePath !== SESSION_FILE_CHUNK_PATH
      && barePath !== SESSION_FILE_FINISH_PATH
      && barePath !== SESSION_FILE_ABORT_PATH) return emptyResponse(404)
    if (request.method !== 'POST') return emptyResponse(405)
    if (request.path !== barePath || this.disposed) return emptyResponse(400)
    if (barePath === SESSION_FILE_CHUNK_PATH) return this.handleChunk(request)
    if (request.contentType !== 'application/json') return emptyResponse(400)
    if (barePath === SESSION_FILE_START_PATH) return this.handleStart(request)
    if (barePath === SESSION_FILE_FINISH_PATH) return this.handleFinish(request)
    return this.handleAbort(request)
  }

  private authorized(request: PairingV1HttpRequest): boolean {
    try {
      return !this.disposed && !request.signal?.aborted
        && this.authorizer.authorize(request.authorization, request.connectionGeneration)
    } catch { return false }
  }

  private current(request: PairingV1HttpRequest, active?: ActiveUpload): void {
    if (!this.authorized(request) || active && (this.active !== active
      || request.authorization !== active.authorization || request.connectionGeneration !== active.generation)) {
      throw new UploadBoundaryError(401)
    }
    if (active) checkDirectories(active)
  }

  private async handleStart(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    const parsed = parseStart(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (parsed.size > MAX_SESSION_FILE_BYTES) return emptyResponse(413)
    if (!this.authorized(request)) return emptyResponse(401)
    if (this.source === undefined) return emptyResponse(503)
    if (this.active !== undefined || this.starting) return emptyResponse(409)
    this.starting = true

    let active: ActiveUpload | undefined
    let opened: FileHandle | undefined
    try {
      const cwd = surfaceCwd(await this.source.readSurface(parsed.sessionId), parsed.sessionId)
      this.current(request)
      if (cwd === undefined) return emptyResponse(409)
      const canonicalCwd = await realpath(cwd)
      this.current(request)
      if (!(await stat(canonicalCwd)).isDirectory()) return emptyResponse(409)
      this.current(request)
      const uploadDirectory = await checkedDirectory(canonicalCwd, SESSION_FILE_DIRECTORY_NAME)
      this.current(request)
      const temporaryDirectory = await checkedDirectory(uploadDirectory, SESSION_FILE_TEMP_DIRECTORY_NAME)
      this.current(request)
      const directories = [canonicalCwd, uploadDirectory, temporaryDirectory].map(directoryIdentity)
      const targetPath = join(uploadDirectory, parsed.fileName)
      if (await exists(targetPath)) return emptyResponse(409)
      this.current(request)

      const uploadId = Buffer.from(this.randomBytes(16)).toString('base64url')
      if (!UPLOAD_ID_PATTERN.test(uploadId)) return emptyResponse(503)
      const temporaryPath = join(temporaryDirectory, `${uploadId}.part`)
      const handle = opened = await open(temporaryPath, 'wx')
      active = {
        uploadId,
        fileName: parsed.fileName,
        size: parsed.size,
        relativePath: `${SESSION_FILE_DIRECTORY_NAME}/${parsed.fileName}`,
        temporaryPath,
        targetPath,
        handle,
        hash: createHash('sha256'),
        authorization: request.authorization,
        generation: request.connectionGeneration,
        directories,
        fileIdentity: fstatSync(handle.fd),
        offset: 0,
        busy: false,
        closed: false,
      }
      this.active = active
      this.current(request, active)
      this.refreshTimer(active)
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'session_file_upload_started',
          protocolVersion: 1,
          uploadId,
          chunkSize: SESSION_FILE_CHUNK_BYTES,
        }),
      }
    } catch (error) {
      if (active !== undefined) await this.cleanup(active)
      else await opened?.close().catch(() => undefined)
      return emptyResponse(error instanceof UploadBoundaryError ? error.status : 503)
    } finally {
      this.starting = false
    }
  }

  private async handleChunk(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    if (request.contentType !== 'application/octet-stream') return emptyResponse(400)
    const parsed = parseChunk(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!this.authorized(request)) return emptyResponse(401)
    const active = this.active
    if (active === undefined || active.uploadId !== parsed.uploadId || active.busy) {
      return emptyResponse(409)
    }
    if (request.authorization !== active.authorization || request.connectionGeneration !== active.generation) return emptyResponse(401)
    active.busy = true
    this.refreshTimer(active)
    try {
      this.current(request, active)
      if (parsed.offset !== active.offset || parsed.offset + parsed.bytes.byteLength > active.size) {
        await this.cleanup(active)
        return emptyResponse(409)
      }
      const result = await active.handle.write(parsed.bytes, 0, parsed.bytes.byteLength, active.offset)
      this.current(request, active)
      if (result.bytesWritten !== parsed.bytes.byteLength) {
        await this.cleanup(active)
        return emptyResponse(503)
      }
      active.hash.update(parsed.bytes)
      active.offset += parsed.bytes.byteLength
      this.refreshTimer(active)
      return emptyResponse(204)
    } catch (error) {
      await this.cleanup(active)
      return emptyResponse(error instanceof UploadBoundaryError ? error.status : 503)
    } finally {
      if (this.active === active) active.busy = false
    }
  }

  private async handleFinish(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    const parsed = parseFinish(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!this.authorized(request)) return emptyResponse(401)
    const active = this.active
    if (active === undefined || active.uploadId !== parsed.uploadId || active.busy) {
      return emptyResponse(409)
    }
    if (request.authorization !== active.authorization || request.connectionGeneration !== active.generation) return emptyResponse(401)
    active.busy = true
    this.clearTimer(active)
    try {
      this.current(request, active)
      if (active.offset !== active.size) {
        await this.cleanup(active)
        return emptyResponse(422)
      }
      const actualHash = active.hash.digest('hex')
      if (actualHash !== parsed.sha256) {
        await this.cleanup(active)
        return emptyResponse(422)
      }
      await active.handle.sync()
      this.current(request, active)
      await active.handle.close()
      active.closed = true
      this.current(request, active)
      if (!sameFile(active.temporaryPath, active.fileIdentity) || lstatSync(active.temporaryPath).nlink !== 1) {
        throw new UploadBoundaryError(409)
      }
      try {
        // No asynchronous suspension between the last authorization/path check
        // and publication. This is not isolation from a hostile same-user OS process.
        linkSync(active.temporaryPath, active.targetPath)
      } catch (error) {
        await this.cleanup(active)
        return emptyResponse(isObject(error) && error.code === 'EEXIST' ? 409 : 503)
      }
      try {
        checkDirectories(active)
        if (!sameFile(active.targetPath, active.fileIdentity)) throw new UploadBoundaryError(409)
        unlinkSync(active.temporaryPath)
      } catch {
        try { checkDirectories(active); if (sameFile(active.targetPath, active.fileIdentity)) unlinkSync(active.targetPath) } catch { /* Never delete a replacement. */ }
        await this.cleanup(active)
        return emptyResponse(503)
      }
      this.active = undefined
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'session_file_uploaded',
          protocolVersion: 1,
          fileName: active.fileName,
          relativePath: active.relativePath,
          size: active.size,
          sha256: actualHash,
        }),
      }
    } catch (error) {
      await this.cleanup(active)
      return emptyResponse(error instanceof UploadBoundaryError ? error.status : !this.authorized(request) ? 401 : 503)
    } finally {
      if (this.active === active) active.busy = false
    }
  }

  private async handleAbort(request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> {
    const parsed = parseAbort(request.body)
    if (parsed === undefined) return emptyResponse(400)
    if (!this.authorized(request)) return emptyResponse(401)
    const active = this.active
    if (active === undefined) return emptyResponse(204)
    if (active.uploadId !== parsed.uploadId || active.busy) return emptyResponse(409)
    if (request.authorization !== active.authorization || request.connectionGeneration !== active.generation) return emptyResponse(401)
    active.busy = true
    await this.cleanup(active)
    return emptyResponse(204)
  }

  private refreshTimer(active: ActiveUpload): void {
    this.clearTimer(active)
    active.timer = setTimeout(() => {
      if (this.active === active && !active.busy) void this.cleanup(active)
    }, SESSION_FILE_IDLE_TIMEOUT_MS)
    active.timer.unref()
  }

  private clearTimer(active: ActiveUpload): void {
    if (active.timer !== undefined) {
      clearTimeout(active.timer)
      active.timer = undefined
    }
  }

  private async cleanup(active: ActiveUpload): Promise<void> {
    this.clearTimer(active)
    if (this.active === active) this.active = undefined
    if (!active.closed) {
      active.closed = true
      await active.handle.close().catch(() => undefined)
    }
    try {
      checkDirectories(active)
      if (sameFile(active.temporaryPath, active.fileIdentity)) unlinkSync(active.temporaryPath)
    } catch { /* Leave moved/replaced paths untouched rather than deleting foreign data. */ }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const active = this.active
    if (active !== undefined) await this.cleanup(active)
  }
}
