import 'reflect-metadata'
import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
  cryptoProvider,
} from '@peculiar/x509'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  webcrypto,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import { open, link, mkdir, readFile, rm } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import { PairingStartupError } from './pairing-startup-error.js'
import { startupFailureReason } from './startup-observation.js'
import { WindowsDataProtectionError, createWindowsCurrentUserDataProtector } from './windows-dpapi.js'

export const PAIRING_IDENTITY_FILE_NAME = 'pairing-identity-v1.json'

const RECORD_FIELDS = [
  'version',
  'createdAt',
  'caDer',
  'leafSpkiSha256',
  'protectedCaPrivateKey',
  'protectedLeafPrivateKey',
]
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_CA_DER_BYTES = 1024
const MAX_PROTECTED_KEY_BYTES = 16 * 1024
const RSA_MODULUS_LENGTH = 2048
const FIVE_MINUTES_MS = 5 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000
const IDENTITY_DOMAIN = Buffer.from('DSHOS-LINK/PAIRING-IDENTITY/V1\0', 'utf8')

const RSA_ALGORITHM: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: RSA_MODULUS_LENGTH,
}

cryptoProvider.set(webcrypto as Crypto)

interface StoredPairingIdentity {
  readonly version: 1
  readonly createdAt: number
  readonly caDer: string
  readonly leafSpkiSha256: string
  readonly protectedCaPrivateKey: string
  readonly protectedLeafPrivateKey: string
}

export interface PairingIdentityProtector {
  protect(plaintext: Buffer): Promise<Buffer>
  unprotect(ciphertext: Buffer): Promise<Buffer>
}

export interface LoadOrCreateWindowsPairingIdentityOptions {
  readonly rootDirectory: string
  readonly host: string
  readonly hosts?: readonly string[]
  readonly allowCreate: boolean
  readonly protector?: PairingIdentityProtector
  readonly linkFile?: (source: string, destination: string) => Promise<void>
}

export interface WindowsPairingIdentity {
  readonly caDer: Buffer
  readonly caPem: Buffer
  readonly leafKeyPem: Buffer
  readonly leafCertPem: Buffer
  readonly pin: Buffer
  readonly identityId: string
}

function isRfc1918Ipv4(host: string): boolean {
  if (!isIPv4(host)) return false
  const parts = host.split('.')
  if (parts.some(part => String(Number(part)) !== part)) return false
  const [first, second] = parts.map(Number)
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function validateHost(host: string): string {
  if (host !== host.trim() || !isRfc1918Ipv4(host)) {
    throw new TypeError('Pairing identity host must be an explicit RFC1918 IPv4 address')
  }
  return host
}

function unavailable(): never {
  throw new PairingStartupError('IDENTITY', 'Pairing identity unavailable')
}

function invalidFile(): never {
  throw new PairingStartupError('IDENTITY', 'Pairing identity file is invalid', undefined, 'record_invalid')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeCanonical(value: unknown, minimumBytes: number, maximumBytes: number): Buffer | undefined {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength < minimumBytes
    || decoded.byteLength > maximumBytes
    || decoded.toString('base64url') !== value) return undefined
  return decoded
}

function parseStoredIdentity(text: string): StoredPairingIdentity {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    invalidFile()
  }
  if (!isRecord(value)
    || Object.keys(value).length !== RECORD_FIELDS.length
    || !Object.keys(value).every((field, index) => field === RECORD_FIELDS[index])
    || value.version !== 1
    || !Number.isSafeInteger(value.createdAt)
    || (value.createdAt as number) < 0
    || decodeCanonical(value.caDer, 1, MAX_CA_DER_BYTES) === undefined
    || decodeCanonical(value.leafSpkiSha256, 32, 32) === undefined
    || decodeCanonical(value.protectedCaPrivateKey, 1, MAX_PROTECTED_KEY_BYTES) === undefined
    || decodeCanonical(value.protectedLeafPrivateKey, 1, MAX_PROTECTED_KEY_BYTES) === undefined) {
    invalidFile()
  }
  const record = value as unknown as StoredPairingIdentity
  if (JSON.stringify(record) !== text) invalidFile()
  return record
}

function serialNumber(): string {
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 1
  return serial.toString('hex')
}

function asArrayBuffer(bytes: Buffer): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey(RSA_ALGORITHM, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
}

async function exportPrivateKey(privateKey: CryptoKey): Promise<Buffer> {
  return Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey))
}

function readRsaPrivateKey(pkcs8: Buffer): KeyObject {
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
  if (privateKey.asymmetricKeyType !== 'rsa'
    || privateKey.asymmetricKeyDetails?.modulusLength !== RSA_MODULUS_LENGTH) unavailable()
  return privateKey
}

function publicSpki(privateKey: KeyObject): Buffer {
  return Buffer.from(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }))
}

async function importSigningKey(pkcs8: Buffer): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    'pkcs8',
    asArrayBuffer(pkcs8),
    RSA_ALGORITHM,
    false,
    ['sign'],
  )
}

async function importVerificationKey(spki: Buffer): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    'spki',
    asArrayBuffer(spki),
    RSA_ALGORITHM,
    true,
    ['verify'],
  )
}

async function createCaCertificate(keys: CryptoKeyPair, now: number): Promise<Buffer> {
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: 'CN=DSHOS Link Pairing CA',
    notBefore: new Date(now - FIVE_MINUTES_MS),
    notAfter: new Date(now + TEN_YEARS_MS),
    signingAlgorithm: RSA_ALGORITHM,
    keys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
    ],
  })
  return Buffer.from(certificate.rawData)
}

async function createLeafCertificate(
  hosts: readonly string[],
  caCertificate: X509Certificate,
  caPkcs8: Buffer,
  leafPrivateKey: KeyObject,
  now: number,
): Promise<Buffer> {
  const leafSpki = publicSpki(leafPrivateKey)
  const certificate = await X509CertificateGenerator.create({
    serialNumber: serialNumber(),
    subject: 'CN=DSHOS Link Connector',
    issuer: caCertificate.subject,
    notBefore: new Date(now - FIVE_MINUTES_MS),
    notAfter: new Date(now + THIRTY_DAYS_MS),
    signingAlgorithm: RSA_ALGORITHM,
    publicKey: await importVerificationKey(leafSpki),
    signingKey: await importSigningKey(caPkcs8),
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension(hosts.map(value => ({ type: 'ip' as const, value }))),
    ],
  })
  leafSpki.fill(0)
  return Buffer.from(certificate.rawData)
}

function privateKeyPem(privateKey: KeyObject): Buffer {
  return Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }))
}

function stableIdentityId(caDer: Buffer, pin: Buffer): string {
  return createHash('sha256')
    .update(IDENTITY_DOMAIN)
    .update(caDer)
    .update(pin)
    .digest('base64url')
}

async function materializeIdentity(
  record: StoredPairingIdentity,
  caPkcs8: Buffer,
  leafPkcs8: Buffer,
  hosts: readonly string[],
): Promise<WindowsPairingIdentity> {
  try {
    const caDer = decodeCanonical(record.caDer, 1, MAX_CA_DER_BYTES)!
    const storedPin = decodeCanonical(record.leafSpkiSha256, 32, 32)!
    const caCertificate = new X509Certificate(caDer)
    const caPrivateKey = readRsaPrivateKey(caPkcs8)
    const leafPrivateKey = readRsaPrivateKey(leafPkcs8)
    const now = Date.now()
    if (!caCertificate.ca
      || !caCertificate.verify(caCertificate.publicKey)
      || !caCertificate.checkPrivateKey(caPrivateKey)
      || now < caCertificate.validFromDate.getTime()
      || now >= caCertificate.validToDate.getTime()) unavailable()

    const pin = createHash('sha256').update(publicSpki(leafPrivateKey)).digest()
    if (!pin.equals(storedPin)) unavailable()
    const leafCertDer = await createLeafCertificate(
      hosts,
      caCertificate,
      caPkcs8,
      leafPrivateKey,
      now,
    )
    const leafCertificate = new X509Certificate(leafCertDer)
    if (leafCertificate.ca
      || hosts.some(host => leafCertificate.checkIP(host) === undefined)
      || !leafCertificate.verify(caCertificate.publicKey)
      || !leafCertificate.checkPrivateKey(leafPrivateKey)) unavailable()

    return Object.freeze({
      caDer: Buffer.from(caDer),
      caPem: Buffer.from(caCertificate.toString(), 'utf8'),
      leafKeyPem: privateKeyPem(leafPrivateKey),
      leafCertPem: Buffer.from(leafCertificate.toString(), 'utf8'),
      pin: Buffer.from(pin),
      identityId: stableIdentityId(caDer, pin),
    })
  } catch {
    unavailable()
  }
}

async function writeStoredIdentity(
  rootDirectory: string,
  record: StoredPairingIdentity,
  linkFile: (source: string, destination: string) => Promise<void>,
): Promise<boolean> {
  const destination = join(rootDirectory, PAIRING_IDENTITY_FILE_NAME)
  const temporary = join(
    rootDirectory,
    `.${PAIRING_IDENTITY_FILE_NAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await mkdir(rootDirectory, { recursive: true })
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(record), 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await linkFile(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    return true
  } catch (error) {
    throw new PairingStartupError('STORAGE', 'Pairing identity write failed', undefined, startupFailureReason(error))
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function createIdentity(
  rootDirectory: string,
  hosts: readonly string[],
  protector: PairingIdentityProtector,
  linkFile: (source: string, destination: string) => Promise<void>,
): Promise<WindowsPairingIdentity | undefined> {
  const now = Date.now()
  const caKeys = await generateRsaKeyPair()
  const leafKeys = await generateRsaKeyPair()
  const caPkcs8 = await exportPrivateKey(caKeys.privateKey)
  const leafPkcs8 = await exportPrivateKey(leafKeys.privateKey)
  let protectedCa: Buffer | undefined
  let protectedLeaf: Buffer | undefined
  try {
    const caDer = await createCaCertificate(caKeys, now)
    if (caDer.byteLength > MAX_CA_DER_BYTES) unavailable()
    const leafPrivateKey = readRsaPrivateKey(leafPkcs8)
    const leafSpki = publicSpki(leafPrivateKey)
    const pin = createHash('sha256').update(leafSpki).digest()
    leafSpki.fill(0)
    protectedCa = await protector.protect(caPkcs8)
    protectedLeaf = await protector.protect(leafPkcs8)
    const record: StoredPairingIdentity = {
      version: 1,
      createdAt: now,
      caDer: caDer.toString('base64url'),
      leafSpkiSha256: pin.toString('base64url'),
      protectedCaPrivateKey: protectedCa.toString('base64url'),
      protectedLeafPrivateKey: protectedLeaf.toString('base64url'),
    }
    const identity = await materializeIdentity(record, caPkcs8, leafPkcs8, hosts)
    try {
      if (!await writeStoredIdentity(rootDirectory, record, linkFile)) {
        identity.leafKeyPem.fill(0)
        return undefined
      }
      return identity
    } catch (error) {
      identity.leafKeyPem.fill(0)
      throw error
    }
  } finally {
    caPkcs8.fill(0)
    leafPkcs8.fill(0)
    protectedCa?.fill(0)
    protectedLeaf?.fill(0)
  }
}

async function loadIdentity(
  text: string,
  hosts: readonly string[],
  protector: PairingIdentityProtector,
): Promise<WindowsPairingIdentity> {
  const record = parseStoredIdentity(text)
  let caPkcs8: Buffer | undefined
  let leafPkcs8: Buffer | undefined
  try {
    caPkcs8 = await protector.unprotect(Buffer.from(record.protectedCaPrivateKey, 'base64url'))
    leafPkcs8 = await protector.unprotect(Buffer.from(record.protectedLeafPrivateKey, 'base64url'))
    return await materializeIdentity(record, caPkcs8, leafPkcs8, hosts)
  } catch (error) {
    if (error instanceof WindowsDataProtectionError) throw error
    unavailable()
  } finally {
    caPkcs8?.fill(0)
    leafPkcs8?.fill(0)
  }
  return unavailable()
}

export async function loadOrCreateWindowsPairingIdentity(
  options: LoadOrCreateWindowsPairingIdentityOptions,
): Promise<WindowsPairingIdentity> {
  const host = validateHost(options.host)
  const hosts = options.hosts === undefined ? [host] : [...options.hosts]
  if (hosts.length < 1 || hosts.length > 3 || hosts[0] !== host || new Set(hosts).size !== hosts.length) unavailable()
  hosts.forEach(validateHost)
  if (typeof options.rootDirectory !== 'string' || options.rootDirectory.length === 0) unavailable()
  const path = join(options.rootDirectory, PAIRING_IDENTITY_FILE_NAME)
  const protector = options.protector ?? createWindowsCurrentUserDataProtector()
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PairingStartupError('STORAGE', 'Pairing identity read failed', undefined, startupFailureReason(error))
    if (!options.allowCreate) unavailable()
    const created = await createIdentity(options.rootDirectory, hosts, protector, options.linkFile ?? link)
    if (created !== undefined) return created
    try {
      text = await readFile(path, 'utf8')
    } catch {
      unavailable()
    }
  }
  return loadIdentity(text, hosts, protector)
}
