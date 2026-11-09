import { createHash, createPublicKey } from 'node:crypto';
import { cloudFields, cloudVerify, CloudPairingError, type CloudPayload } from './cloud-pairing-contract.js';

export interface CloudRelayKey { keyId: string; publicKey: string }
export interface CloudRelayHeader {
  contract: 'dshos-cloud-relay-bootstrap-v1'; environment: string; attemptId: string;
  pairingId: string; generation: string; mobilePublicKey: string; keyId: string;
  transferId: string; issuedAt: number; expiresAt: number;
}
export interface CloudRelayPacket { header: CloudRelayHeader; ciphertext: string; signature: string }
const fields=['contract','environment','attemptId','pairingId','generation','mobilePublicKey','keyId','transferId','issuedAt','expiresAt'];
export function cloudRelayBytes(value: unknown, size: number): Buffer {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw new CloudPairingError('relay_bootstrap_invalid',400);
  const bytes=Buffer.from(value,'base64url');
  if(bytes.length!==size||bytes.toString('base64url')!==value)throw new CloudPairingError('relay_bootstrap_invalid',400);
  return bytes;
}
/** Dedicated RSA-OAEP key. Never the TLS key or the registration signing key. */
export function cloudRelayKey(value: unknown): CloudRelayKey {
  try {
    if(!cloudFields(value,['keyId','publicKey'])||typeof value.publicKey!=='string'||value.publicKey.length>800)throw Error();
    cloudRelayBytes(value.keyId,32);
    const der=Buffer.from(value.publicKey,'base64url');
    if(der.toString('base64url')!==value.publicKey)throw Error();
    const key=createPublicKey({key:der,format:'der',type:'spki'}),details=key.asymmetricKeyDetails;
    if(key.asymmetricKeyType!=='rsa'||details?.modulusLength!==3072||details.publicExponent!==65537n||
      !key.export({format:'der',type:'spki'}).equals(der)||createHash('sha256').update(der).digest('base64url')!==value.keyId)throw Error();
    return {keyId:value.keyId as string,publicKey:value.publicKey};
  }catch{throw new CloudPairingError('relay_bootstrap_key_invalid',400);}
}
export function cloudRelayPacket(input: unknown, current: CloudPayload, keyId: string, now: number): CloudRelayPacket {
  try {
    if(!cloudFields(input,['header','ciphertext','signature'])||!cloudFields(input.header,fields))throw Error();
    const h=input.header,b=current.body as CloudPayload;
    if(h.contract!=='dshos-cloud-relay-bootstrap-v1'||h.environment!==current.environment||h.attemptId!==current.attemptId||
      h.pairingId!==b.newPairingId||h.generation!==b.newPairingGeneration||h.mobilePublicKey!==b.newMobilePublicKey||h.keyId!==keyId||
      !Number.isSafeInteger(h.issuedAt)||(h.issuedAt as number)<0||(h.issuedAt as number)>now+30000||
      h.expiresAt!==(h.issuedAt as number)+120000||(h.expiresAt as number)<=now)throw Error();
    cloudRelayBytes(h.keyId,32);cloudRelayBytes(h.transferId,16);cloudRelayBytes(input.ciphertext,384);
    if(!cloudVerify('RELAY-BOOTSTRAP',{header:h,ciphertext:input.ciphertext},h.mobilePublicKey,input.signature))throw Error();
    return structuredClone(input) as unknown as CloudRelayPacket;
  }catch{throw new CloudPairingError('relay_bootstrap_invalid',400);}
}
