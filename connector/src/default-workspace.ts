import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { DEFAULT_WORKSPACE_REMOTE_NAMESPACE } from './remote.js'
import { MAX_SESSION_CREATE_WORKSPACES, type SessionCreateContext, type SessionCreateWorkspaceResolution } from './session-create.js'

export const DEFAULT_WORKSPACE_FILE_NAME = 'default-workspace-v1.json'
const RECORD_FIELDS = ['version', 'workspaceId']
const MAX_WORKSPACE_ID_LENGTH = 256

export interface DefaultWorkspaceRecord {
  readonly version: 1
  readonly workspaceId: string
}

export interface DefaultWorkspaceStore {
  read(): DefaultWorkspaceRecord | null
  replace(record: DefaultWorkspaceRecord): void
}

export interface DefaultWorkspaceView {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
}

export interface DefaultWorkspaceListSource {
  list(): Promise<readonly DefaultWorkspaceView[]>
}

export type WorkspaceDirectoryInspector = (path: string) => Promise<void>

export type DefaultWorkspaceSnapshot =
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'ready'; readonly title: string }

function storageFailure(): never {
  throw new Error('Default workspace storage failed')
}

function validWorkspaceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= MAX_WORKSPACE_ID_LENGTH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function copyRecord(value: unknown): DefaultWorkspaceRecord {
  if (!isRecord(value)
    || Object.keys(value).length !== RECORD_FIELDS.length
    || !Object.keys(value).every((field, index) => field === RECORD_FIELDS[index])
    || value.version !== 1
    || !validWorkspaceId(value.workspaceId)) storageFailure()
  return { version: 1, workspaceId: value.workspaceId }
}

export class FileDefaultWorkspaceStore implements DefaultWorkspaceStore {
  constructor(private readonly path: string) {
    if (typeof path !== 'string' || path.length === 0) storageFailure()
  }

  read(): DefaultWorkspaceRecord | null {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      storageFailure()
    }
    try {
      const record = copyRecord(JSON.parse(text))
      if (JSON.stringify(record) !== text) storageFailure()
      return record
    } catch {
      return storageFailure()
    }
  }

  replace(record: DefaultWorkspaceRecord): void {
    const value = copyRecord(record)
    const parent = dirname(this.path)
    const temporaryPath = join(
      parent,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    )
    let descriptor: number | undefined
    let failed = false
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      descriptor = openSync(temporaryPath, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(value), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporaryPath, this.path)
    } catch {
      failed = true
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
        } catch {
          failed = true
        }
      }
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // The destination is authoritative; stale temp cleanup is best effort.
      }
    }
    if (failed) storageFailure()
  }
}

export async function inspectWorkspaceDirectory(path: string): Promise<void> {
  const metadata = await stat(path)
  if (!metadata.isDirectory()) throw new Error('Configured workspace path is not a directory')
  await access(path, constants.R_OK | constants.W_OK)
}

export class DefaultWorkspaceController {
  constructor(
    private readonly store: DefaultWorkspaceStore,
    private readonly source: DefaultWorkspaceListSource,
    private readonly inspectDirectory: WorkspaceDirectoryInspector = inspectWorkspaceDirectory,
  ) {}

  async snapshot(): Promise<DefaultWorkspaceSnapshot> {
    let record: DefaultWorkspaceRecord | null
    try {
      record = this.store.read()
    } catch {
      return { status: 'unavailable' }
    }
    if (record === null) return { status: 'not_configured' }
    try {
      const workspace = await this.resolve(record.workspaceId)
      return workspace === undefined
        ? { status: 'unavailable' }
        : { status: 'ready', title: workspace.title }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async select(workspaceId: string): Promise<DefaultWorkspaceSnapshot> {
    if (!validWorkspaceId(workspaceId)) throw new Error('Default workspace selection failed')
    try {
      const workspace = await this.resolve(workspaceId)
      if (workspace === undefined) throw new Error()
      this.store.replace({ version: 1, workspaceId })
      return { status: 'ready', title: workspace.title }
    } catch {
      throw new Error('Default workspace selection failed')
    }
  }

  async resolveForSessionCreate(): Promise<SessionCreateWorkspaceResolution> {
    let record: DefaultWorkspaceRecord | null
    try {
      record = this.store.read()
    } catch {
      return { status: 'unavailable' }
    }
    if (record === null) return { status: 'not_configured' }
    try {
      const workspace = await this.resolve(record.workspaceId)
      return workspace === undefined
        ? { status: 'unavailable' }
        : { status: 'ready', workspaceId: workspace.workspaceId }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async listForSessionCreate(): Promise<SessionCreateContext> {
    const registered = await this.source.list()
    if (registered.length > MAX_SESSION_CREATE_WORKSPACES) throw new Error('Too many registered workspaces')
    const workspaces: { workspaceId: string; title: string }[] = []
    for (const workspace of registered) {
      if (!validWorkspaceId(workspace.workspaceId) || typeof workspace.title !== 'string'
        || workspace.title.length === 0 || workspace.title.length > 512) throw new Error('Invalid workspace')
      try { await this.inspectDirectory(workspace.path) } catch { continue }
      workspaces.push({ workspaceId: workspace.workspaceId, title: workspace.title })
    }
    // The v1 default is only an optional suggestion, never a v2 prerequisite.
    let record: DefaultWorkspaceRecord | null = null
    try { record = this.store.read() } catch { /* Preserve the legacy record for its own recovery. */ }
    const defaultWorkspaceId = workspaces.some(item => item.workspaceId === record?.workspaceId)
      ? record!.workspaceId : null
    return { workspaces, defaultWorkspaceId }
  }

  async resolveSelectedForSessionCreate(workspaceId: string): Promise<SessionCreateWorkspaceResolution> {
    if (!validWorkspaceId(workspaceId)) return { status: 'unavailable' }
    try {
      const workspace = await this.resolve(workspaceId)
      return workspace === undefined ? { status: 'unavailable' } : { status: 'ready', workspaceId: workspace.workspaceId }
    } catch { return { status: 'unavailable' } }
  }

  private async resolve(workspaceId: string): Promise<DefaultWorkspaceView | undefined> {
    const workspaces = await this.source.list()
    const workspace = workspaces.find(candidate => candidate.workspaceId === workspaceId)
    if (workspace === undefined) return undefined
    await this.inspectDirectory(workspace.path)
    return workspace
  }
}

export class DefaultWorkspaceRemoteService extends Service {
  readonly typertRemote: {
    readonly service: DefaultWorkspaceRemoteService
    readonly serviceKey: typeof DEFAULT_WORKSPACE_REMOTE_NAMESPACE
    readonly namespace: typeof DEFAULT_WORKSPACE_REMOTE_NAMESPACE
  }

  constructor(ctx: Context, private readonly controller: DefaultWorkspaceController) {
    super(ctx, DEFAULT_WORKSPACE_REMOTE_NAMESPACE)
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: DEFAULT_WORKSPACE_REMOTE_NAMESPACE,
      namespace: DEFAULT_WORKSPACE_REMOTE_NAMESPACE,
    })
  }

  snapshot(): Promise<DefaultWorkspaceSnapshot> {
    return this.controller.snapshot()
  }

  select(workspaceId: string): Promise<DefaultWorkspaceSnapshot> {
    return this.controller.select(workspaceId)
  }
}
