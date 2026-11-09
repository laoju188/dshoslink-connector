import { randomBytes, timingSafeEqual } from 'node:crypto'
import { rmSync, statSync } from 'node:fs'
import { link, mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { startupStorageError } from './startup-observation.js'
import type { PairingAuthorizationBinding } from './pairing-auth.js'
import type { PairingV1HttpRequest, PairingV1HttpResponse } from './pairing-backend.js'
import type { PairingIdentityProtector } from './pairing-identity-store.js'
import { createWindowsRelayRootKeyDataProtector } from './windows-dpapi.js'

export const RELAY_ROOT_KEY_PATH = '/connection/v1/relay-root-key'
export const RELAY_ROOT_KEY_FILE_NAME = 'relay-root-key-v1.json'

const ROOT_KEY_BYTES = 32
const IDENTITY_ID_BYTES = 32
const PAIRING_ID_BYTES = 16
const MOBILE_PUBLIC_KEY_BYTES = 32
const MAX_PROTECTED_ROOT_KEY_BYTES = 4_096
const DOMAIN = Buffer.from('DSHOS-LINK/RELAY-ROOT-KEY/V1\0', 'utf8')
const PLAINTEXT_BYTES = DOMAIN.byteLength
  + IDENTITY_ID_BYTES
  + PAIRING_ID_BYTES
  + MOBILE_PUBLIC_KEY_BYTES
  + ROOT_KEY_BYTES
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export type RelayRootKeyProvisionResult =
  | 'stored'
  | 'unchanged'
  | 'conflict'
  | 'unauthorized'

export interface RelayRootKeyStoreOptions {
  readonly rootDirectory: string
  readonly identityId: string
  readonly protector?: PairingIdentityProtector
}

export interface RelayRootKeyAuthorizer {
  authorizePairing(
    authorization?: string,
    connectionGeneration?: string,
  ): PairingAuthorizationBinding | undefined
}

function storageFailure(error?: unknown): never {
  throw startupStorageError('Relay root key storage failed', error)
}

function decodeCanonical(value: unknown, length: number): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return decoded.byteLength === length && decoded.toString('base64url') === value
    ? decoded
    : undefined
}

function validBinding(value: PairingAuthorizationBinding): PairingAuthorizationBinding {
  const pairingId = decodeCanonical(value.pairingId, PAIRING_ID_BYTES)
  const mobilePublicKeyRaw = decodeCanonical(value.mobilePublicKeyRaw, MOBILE_PUBLIC_KEY_BYTES)
  try {
    if (pairingId === undefined || mobilePublicKeyRaw === undefined) storageFailure()
    return Object.freeze({
      pairingId: value.pairingId,
      mobilePublicKeyRaw: value.mobilePublicKeyRaw,
    })
  } finally {
    pairingId?.fill(0)
    mobilePublicKeyRaw?.fill(0)
  }
}

function sameBinding(
  expected: PairingAuthorizationBinding,
  actual: PairingAuthorizationBinding | undefined,
): boolean {
  return actual !== undefined
    && expected.pairingId === actual.pairingId
    && expected.mobilePublicKeyRaw === actual.mobilePublicKeyRaw
}

function equalSecret(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && timingSafeEqual(
      Buffer.from(left.buffer, left.byteOffset, left.byteLength),
      Buffer.from(right.buffer, right.byteOffset, right.byteLength),
    )
}

function emptyResponse(status: number): PairingV1HttpResponse {
  return { status, body: '' }
}

export class RelayRootKeyStore {
  private readonly path: string
  private readonly identityId: Buffer
  private revision = 0

  constructor(private readonly options: RelayRootKeyStoreOptions) {
    if (typeof options.rootDirectory !== 'string' || options.rootDirectory.length === 0) {
      storageFailure()
    }
    const identityId = decodeCanonical(options.identityId, IDENTITY_ID_BYTES)
    if (identityId === undefined) storageFailure()
    this.identityId = Buffer.from(identityId)
    identityId.fill(0)
    this.path = join(options.rootDirectory, RELAY_ROOT_KEY_FILE_NAME)
  }

  async provision(
    rootKey: Uint8Array,
    requestedBinding: PairingAuthorizationBinding,
    reauthorize: () => PairingAuthorizationBinding | undefined,
  ): Promise<RelayRootKeyProvisionResult> {
    if (!(rootKey instanceof Uint8Array) || rootKey.byteLength !== ROOT_KEY_BYTES) storageFailure()
    const binding = validBinding(requestedBinding)
    const ownedRootKey = Buffer.from(rootKey)
    const revision = this.revision
    const authorized = (): boolean => {
      if (this.revision !== revision) return false
      try {
        return sameBinding(binding, reauthorize())
      } catch {
        return false
      }
    }
    try {
      if (!authorized()) return 'unauthorized'
      const existing = await this.load(binding)
      if (existing !== undefined) {
        try {
          if (!authorized()) return 'unauthorized'
          return equalSecret(existing, ownedRootKey) ? 'unchanged' : 'conflict'
        } finally {
          existing.fill(0)
        }
      }

      const plaintext = this.plaintext(binding, ownedRootKey)
      let protectedRootKey: Buffer | undefined
      try {
        protectedRootKey = await this.protector().protect(plaintext)
        if (!(protectedRootKey instanceof Buffer)
          || protectedRootKey.byteLength === 0
          || protectedRootKey.byteLength > MAX_PROTECTED_ROOT_KEY_BYTES) storageFailure()
        if (!authorized()) return 'unauthorized'
        return await this.publish(protectedRootKey, binding, ownedRootKey, authorized)
      } finally {
        plaintext.fill(0)
        protectedRootKey?.fill(0)
      }
    } finally {
      ownedRootKey.fill(0)
    }
  }

  revoke(): void {
    this.revision += 1
    try {
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure(error)
    }
  }

  async withRootKey<T>(
    binding: PairingAuthorizationBinding,
    operation: (rootKey: Uint8Array) => Promise<T>,
  ): Promise<T> {
    const currentBinding = validBinding(binding)
    const revision = this.revision
    const rootKey = await this.load(currentBinding)
    if (rootKey === undefined || revision !== this.revision) {
      rootKey?.fill(0)
      storageFailure()
    }
    try {
      return await operation(rootKey)
    } finally {
      rootKey.fill(0)
    }
  }

  private async load(binding: PairingAuthorizationBinding): Promise<Buffer | undefined> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      storageFailure()
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      storageFailure()
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).join(',') !== 'storageVersion,protectedRootKey'
      || (value as Record<string, unknown>).storageVersion !== 1
      || typeof (value as Record<string, unknown>).protectedRootKey !== 'string'
      || JSON.stringify(value) !== text) storageFailure()
    const encoded = (value as { readonly protectedRootKey: string }).protectedRootKey
    const protectedRootKey = decodeCanonical(encoded, Buffer.from(encoded, 'base64url').byteLength)
    if (protectedRootKey === undefined
      || protectedRootKey.byteLength === 0
      || protectedRootKey.byteLength > MAX_PROTECTED_ROOT_KEY_BYTES) storageFailure()
    let plaintext: Buffer | undefined
    try {
      plaintext = await this.protector().unprotect(protectedRootKey)
      if (!(plaintext instanceof Buffer) || plaintext.byteLength !== PLAINTEXT_BYTES) storageFailure()
      let offset = 0
      if (!plaintext.subarray(offset, offset + DOMAIN.byteLength).equals(DOMAIN)) storageFailure()
      offset += DOMAIN.byteLength
      if (!plaintext.subarray(offset, offset + IDENTITY_ID_BYTES).equals(this.identityId)) storageFailure()
      offset += IDENTITY_ID_BYTES
      const pairingId = Buffer.from(binding.pairingId, 'base64url')
      try {
        if (!plaintext.subarray(offset, offset + PAIRING_ID_BYTES).equals(pairingId)) storageFailure()
      } finally {
        pairingId.fill(0)
      }
      offset += PAIRING_ID_BYTES
      const mobilePublicKeyRaw = Buffer.from(binding.mobilePublicKeyRaw, 'base64url')
      try {
        if (!plaintext.subarray(offset, offset + MOBILE_PUBLIC_KEY_BYTES)
          .equals(mobilePublicKeyRaw)) storageFailure()
      } finally {
        mobilePublicKeyRaw.fill(0)
      }
      offset += MOBILE_PUBLIC_KEY_BYTES
      return Buffer.from(plaintext.subarray(offset, offset + ROOT_KEY_BYTES))
    } finally {
      protectedRootKey.fill(0)
      plaintext?.fill(0)
    }
  }

  private plaintext(binding: PairingAuthorizationBinding, rootKey: Buffer): Buffer {
    const pairingId = Buffer.from(binding.pairingId, 'base64url')
    const mobilePublicKeyRaw = Buffer.from(binding.mobilePublicKeyRaw, 'base64url')
    try {
      return Buffer.concat([
        DOMAIN,
        this.identityId,
        pairingId,
        mobilePublicKeyRaw,
        rootKey,
      ], PLAINTEXT_BYTES)
    } finally {
      pairingId.fill(0)
      mobilePublicKeyRaw.fill(0)
    }
  }

  private async publish(
    protectedRootKey: Buffer,
    binding: PairingAuthorizationBinding,
    rootKey: Buffer,
    authorized: () => boolean,
  ): Promise<RelayRootKeyProvisionResult> {
    const temporary = join(
      this.options.rootDirectory,
      `.${RELAY_ROOT_KEY_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
    )
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let linked = false
    try {
      await mkdir(this.options.rootDirectory, { recursive: true })
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({
        storageVersion: 1,
        protectedRootKey: protectedRootKey.toString('base64url'),
      }), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      if (!authorized()) return 'unauthorized'
      try {
        await link(temporary, this.path)
        linked = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') storageFailure()
        if (!authorized()) return 'unauthorized'
        const existing = await this.load(binding)
        if (existing === undefined) storageFailure()
        try {
          if (!authorized()) return 'unauthorized'
          return equalSecret(existing, rootKey) ? 'unchanged' : 'conflict'
        } finally {
          existing.fill(0)
        }
      }
      if (!authorized()) {
        this.removeLinkedDestination(temporary)
        linked = false
        return 'unauthorized'
      }
      return 'stored'
    } finally {
      await handle?.close().catch(() => undefined)
      if (linked && !authorized()) {
        this.removeLinkedDestination(temporary)
      }
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private removeLinkedDestination(temporary: string): void {
    try {
      const source = statSync(temporary)
      const destination = statSync(this.path)
      if (source.dev !== destination.dev || source.ino !== destination.ino) storageFailure()
      rmSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') storageFailure()
    }
  }

  private protector(): PairingIdentityProtector {
    return this.options.protector ?? createWindowsRelayRootKeyDataProtector()
  }
}

export function createRelayRootKeyRequestHandler(
  authorizer: RelayRootKeyAuthorizer,
  store: RelayRootKeyStore,
) {
  return async (request: PairingV1HttpRequest): Promise<PairingV1HttpResponse> => {
    try {
      const barePath = request.path.split(/[?#]/, 1)[0]!
      if (barePath !== RELAY_ROOT_KEY_PATH) return emptyResponse(404)
      if (request.method !== 'PUT') return emptyResponse(405)
      if (request.path !== barePath
        || request.contentType !== 'application/octet-stream'
        || !(request.body instanceof Uint8Array)
        || request.body.byteLength !== ROOT_KEY_BYTES) return emptyResponse(400)
      const binding = authorizer.authorizePairing(
        request.authorization,
        request.connectionGeneration,
      )
      if (binding === undefined || request.signal?.aborted) return emptyResponse(401)
      const rootKey = Buffer.from(request.body)
      try {
        const result = await store.provision(rootKey, binding, () => {
          if (request.signal?.aborted) return undefined
          return authorizer.authorizePairing(request.authorization, request.connectionGeneration)
        })
        if (result === 'stored' || result === 'unchanged') return emptyResponse(204)
        if (result === 'conflict') return emptyResponse(409)
        return emptyResponse(401)
      } catch {
        return emptyResponse(503)
      } finally {
        rootKey.fill(0)
      }
    } finally {
      if (request.body instanceof Uint8Array) {
        try {
          request.body.fill(0)
        } catch {
          // Best effort: caller-owned views may be non-writable.
        }
      }
    }
  }
}
