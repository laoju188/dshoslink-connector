import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { registrationId as isRegistrationId } from './dsh-registration-contract.js';

export const CLOUD_PAIRING_CONTRACT = 'dshos-cloud-pairing-v3';
export const CLOUD_PAIRING_PRODUCT = 'harmony-dsh';
export const CLOUD_PAIRING_CODE_TTL = 300_000;
export const CLOUD_PAIRING_POLL_MS = 5_000;
export type CloudEnvironment = 'PRODUCTION' | 'SANDBOX';
export type CloudOperation = 'create' | 'recover' | 'claim' | 'status' | 'approve' | 'reject' | 'cancel' | 'prepare' | 'proof' | 'finalize' | 'saved' | 'current' | 'publish' | 'connect' | 'resolve' | 'relay-deliver' | 'relay-read' | 'relay-ack';
export type CloudRole = 'phone' | 'desktop';
export type CloudState = 'waiting' | 'claimed' | 'authorized' | 'registered' | 'paired' |
  'cancelled' | 'rejected' | 'expired' | 'revoked';
export type CloudPayload = Record<string, unknown>;
export interface CloudRequest {
  contract: typeof CLOUD_PAIRING_CONTRACT;
  environment: CloudEnvironment;
  product: typeof CLOUD_PAIRING_PRODUCT;
  role: CloudRole;
  operation: CloudOperation;
  requestId: string;
  attemptId: string;
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
  payload: CloudPayload;
  signature: string;
}
export interface CloudDesktop {
  computerId: string;
  registrationPublicKey: string;
  memberId: string;
  memberPublicKey: string;
  pairingId: string;
  name: string;
}
export class CloudPairingError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly retryAfterMs?: number) { super(code); }
}
export function cloudFields(value: unknown, names: readonly string[]): value is CloudPayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
// Sorted JSON is shared with the mobile/desktop implementations and test vectors.
// No floating point numbers, undefined, prototype members or duplicate keys are allowed.
export function cloudCanonical(value: unknown, depth = 0): string {
  if (depth > 8) throw new CloudPairingError('invalid_request', 400);
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (value.length > 8192 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
      throw new CloudPairingError('invalid_request', 400);
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (Array.isArray(value) && value.length <= 32 && Object.keys(value).length === value.length &&
    Array.from({ length: value.length }, (_, index) => index).every(index => Object.hasOwn(value, index)))
    return '[' + value.map(item => cloudCanonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 32 || keys.some(key => !/^[A-Za-z][A-Za-z0-9]{0,47}$/.test(key) ||
      ['constructor', 'prototype', '__proto__'].includes(key))) throw new CloudPairingError('invalid_request', 400);
    return '{' + keys.sort().map(key => JSON.stringify(key) + ':' +
      cloudCanonical((value as CloudPayload)[key], depth + 1)).join(',') + '}';
  }
  throw new CloudPairingError('invalid_request', 400);
}
export function cloudTranscript(domain: string, body: unknown): Buffer {
  if (!/^[A-Z-]{1,32}$/.test(domain)) throw new CloudPairingError('invalid_request', 400);
  const raw = Buffer.from(cloudCanonical(body), 'utf8');
  if (raw.length > 16_384) throw new CloudPairingError('request_too_large', 413);
  const size = Buffer.alloc(4); size.writeUInt32BE(raw.length);
  return Buffer.concat([Buffer.from('DSHOS-LINK/V3/CLOUD-PAIRING/' + domain + '\0'), size, raw]);
}
export function cloudDigest(value: unknown): string {
  return createHash('sha256').update(cloudTranscript('DIGEST', value)).digest('base64url');
}
export function cloudVerify(domain: string, body: unknown, key: unknown, signature: unknown): boolean {
  if (!isRegistrationId(key, 32) || !isRegistrationId(signature, 64)) return false;
  try {
    return verify(null, cloudTranscript(domain, body),
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' }),
      Buffer.from(signature, 'base64url'));
  } catch { return false; }
}
export function cloudSign(domain: string, body: unknown, key: KeyObject): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw Error('invalid cloud signing key');
  return sign(null, cloudTranscript(domain, body), key).toString('base64url');
}
export function cloudRequestBody(request: CloudRequest): Omit<CloudRequest, 'signature'> {
  const { signature: _, ...body } = request;
  return body;
}
export function parseCloudRequest(input: unknown, environment: CloudEnvironment, now: number): CloudRequest {
  if (!cloudFields(input, ['contract', 'environment', 'product', 'role', 'operation', 'requestId',
    'attemptId', 'publicKey', 'issuedAt', 'expiresAt', 'payload', 'signature']) ||
    input.contract !== CLOUD_PAIRING_CONTRACT || input.environment !== environment ||
    input.product !== CLOUD_PAIRING_PRODUCT || !['phone', 'desktop'].includes(input.role as string) ||
    !['create', 'recover', 'claim', 'status', 'approve', 'reject', 'cancel', 'prepare', 'proof', 'finalize', 'saved', 'current', 'publish', 'connect', 'resolve', 'relay-deliver', 'relay-read', 'relay-ack'].includes(input.operation as string) ||
    !isRegistrationId(input.requestId) || !isRegistrationId(input.attemptId) ||
    !isRegistrationId(input.publicKey, 32) || !isRegistrationId(input.signature, 64) ||
    !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(input.issuedAt) ||
    !Number.isSafeInteger(input.expiresAt) || (input.issuedAt as number) < 0 ||
    (input.expiresAt as number) <= (input.issuedAt as number) ||
    (input.expiresAt as number) - (input.issuedAt as number) > 60_000 ||
    (input.issuedAt as number) > now + 30_000 || (input.expiresAt as number) <= now ||
    !input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload))
    throw new CloudPairingError('invalid_request', 400);
  const request = input as unknown as CloudRequest;
  if (!cloudVerify('REQUEST', cloudRequestBody(request), request.publicKey, request.signature))
    throw new CloudPairingError('invalid_proof', 403);
  return request;
}
export function parseCloudDesktop(value: unknown): CloudDesktop {
  if (!cloudFields(value, ['computerId', 'registrationPublicKey', 'memberId', 'memberPublicKey', 'pairingId', 'name']) ||
    !['computerId', 'memberId', 'pairingId'].every(key => isRegistrationId(value[key])) ||
    !['registrationPublicKey', 'memberPublicKey'].every(key => isRegistrationId(value[key], 32)) ||
    value.registrationPublicKey === value.memberPublicKey ||
    typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 64 ||
    value.name.trim() !== value.name || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value.name))
    throw new CloudPairingError('invalid_request', 400);
  return value as unknown as CloudDesktop;
}
export function normalizeCloudCode(value: string): string | null {
  if (typeof value !== 'string' || value.length > 24) return null;
  const code = value.replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10))
    .replace(/[ -]/g, '');
  return /^[0-9]{8}$/.test(code) ? code : null;
}

/** A signed absence fence, never a binding, invitation or business credential. */
export function cloudUnusedResult(value: unknown, role: CloudRole, publicKey: string, id: string,
  desktop: CloudDesktop | null): boolean {
  return cloudFields(value,['contract','product','attemptId','state','revision','createdAt','expiresAt','pollAfterMs',
    'phoneSaved','desktopSaved','desktop','mobilePublicKey','manifestHash','binding','prepared','mobileSignature','ownerPublicKey','originalDigest']) &&
    value.contract===CLOUD_PAIRING_CONTRACT&&value.product===CLOUD_PAIRING_PRODUCT&&value.attemptId===id&&
    value.state==='unused'&&value.revision===1&&value.ownerPublicKey===publicKey&&isRegistrationId(value.originalDigest,32)&&
    Number.isSafeInteger(value.createdAt)&&(value.createdAt as number)>=0&&value.expiresAt===(value.createdAt as number)+CLOUD_PAIRING_CODE_TTL&&
    value.pollAfterMs===CLOUD_PAIRING_POLL_MS&&value.phoneSaved===false&&value.desktopSaved===false&&
    value.mobilePublicKey===(role==='phone'?publicKey:'')&&cloudDigest(value.desktop)===cloudDigest(desktop)&&
    value.manifestHash===null&&value.binding===null&&value.prepared===null&&value.mobileSignature===null;
}
