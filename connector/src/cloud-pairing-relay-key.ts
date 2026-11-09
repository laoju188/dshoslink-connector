import { constants, createHash, createPrivateKey, createPublicKey, generateKeyPair, privateDecrypt, timingSafeEqual } from 'node:crypto'
import { cloudFields, cloudDigest, type CloudPayload } from './cloud-pairing-contract.js'
import { cloudRelayKey, cloudRelayPacket, type CloudRelayKey, type CloudRelayPacket } from './cloud-pairing-relay.js'

export interface CloudRelayPrivateKey extends CloudRelayKey {
  contract:'dshos-cloud-relay-key-v1';pairingId:string;privateKey:string
}
export function validCloudRelayPrivateKey(value:unknown):value is CloudRelayPrivateKey{
  try{
    if(!cloudFields(value,['contract','pairingId','keyId','publicKey','privateKey'])||value.contract!=='dshos-cloud-relay-key-v1'||
      typeof value.pairingId!=='string'||!/^[A-Za-z0-9_-]{22}$/.test(value.pairingId)||typeof value.privateKey!=='string'||value.privateKey.length>4096)return false
    const key=cloudRelayKey({keyId:value.keyId,publicKey:value.publicKey}),der=Buffer.from(value.privateKey,'base64url')
    if(der.toString('base64url')!==value.privateKey)return false
    const privateKey=createPrivateKey({key:der,format:'der',type:'pkcs8'})
    return privateKey.asymmetricKeyType==='rsa'&&createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64url')===key.publicKey
  }catch{return false}
}
export async function newCloudRelayPrivateKey(pairingId:string):Promise<CloudRelayPrivateKey>{
  const pair=await new Promise<{privateKey:Buffer;publicKey:Buffer}>((resolve,reject)=>generateKeyPair('rsa',{
    modulusLength:3072,publicExponent:65537,privateKeyEncoding:{format:'der',type:'pkcs8'},publicKeyEncoding:{format:'der',type:'spki'}
  },(error,publicKey,privateKey)=>error?reject(error):resolve({publicKey,privateKey})))
  try{
    const result:CloudRelayPrivateKey={contract:'dshos-cloud-relay-key-v1',pairingId,
      keyId:createHash('sha256').update(pair.publicKey).digest('base64url'),publicKey:pair.publicKey.toString('base64url'),privateKey:pair.privateKey.toString('base64url')}
    if(!validCloudRelayPrivateKey(result))throw Error('cloud_pairing_relay_key_invalid');return result
  }finally{pair.privateKey.fill(0)}
}
/** OAEP SHA-256 and MGF1 SHA-256, empty label. The encrypted first 32 bytes bind
 * every public header field; the remaining two fixed fields are the existing
 * relay root and connector credential. Never interpret arbitrary plaintext. */
export function decryptCloudRelayPacket(key:CloudRelayPrivateKey,packet:CloudRelayPacket,current:CloudPayload,now:number):
  {root:Buffer;credential:Buffer}{
  if(!validCloudRelayPrivateKey(key)||key.pairingId!==(current.body as CloudPayload).newPairingId)throw Error('cloud_pairing_relay_key_changed')
  cloudRelayPacket(packet,current,key.keyId,now)
  const der=Buffer.from(key.privateKey,'base64url');let plain:Buffer|undefined
  try{
    plain=privateDecrypt({key:createPrivateKey({key:der,format:'der',type:'pkcs8'}),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},
      Buffer.from(packet.ciphertext,'base64url'))
    if(plain.length!==96||!timingSafeEqual(plain.subarray(0,32),Buffer.from(cloudDigest(packet.header),'base64url')))
      throw Error('cloud_pairing_relay_payload_invalid')
    return {root:Buffer.from(plain.subarray(32,64)),credential:Buffer.from(plain.subarray(64,96))}
  }finally{der.fill(0);plain?.fill(0)}
}
