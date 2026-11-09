import { createPublicKey, verify } from 'node:crypto'
import { cloudDigest, cloudFields, cloudVerify, parseCloudDesktop, type CloudPayload, type CloudRequest } from './cloud-pairing-contract.js'
import { registrationId, registrationTranscript } from './dsh-registration-contract.js'
import { cloudRelayPacket } from './cloud-pairing-relay.js'

export interface CloudReceipt {
  manifest: CloudPayload
  pairingText: string
  memberSignature: string
  mobileSignature: string
}
export function cloudBindingReceipt(status: CloudPayload): CloudReceipt {
  const prepared = status.prepared as CloudPayload, proof = prepared?.desktopProof as CloudPayload
  if (!['registered','paired'].includes(status.state as string) || !status.binding || !status.manifest ||
    !prepared || typeof prepared.pairingText !== 'string' || !proof || !registrationId(proof.memberSignature,64) ||
    !registrationId(status.mobileSignature,64)) throw Error('cloud_pairing_receipt_unavailable')
  const receipt = {manifest: status.manifest as CloudPayload, pairingText: prepared.pairingText,
    memberSignature: proof.memberSignature, mobileSignature: status.mobileSignature}
  validateCloudReceipt(receipt)
  return receipt
}
export function validateCloudReceipt(receipt: CloudReceipt): CloudPayload {
  if (!cloudFields(receipt,['manifest','pairingText','memberSignature','mobileSignature']) || typeof receipt.pairingText !== 'string' ||
    Buffer.byteLength(receipt.pairingText)>2048 || !cloudFields(receipt.manifest,
      ['contract','product','environment','attemptId','mobilePublicKey','desktop','createdAt','expiresAt'])) throw Error('cloud_pairing_receipt_scope')
  const m=receipt.manifest, d=parseCloudDesktop(m.desktop), b=JSON.parse(receipt.pairingText) as CloudPayload
  if (JSON.stringify(b)!==receipt.pairingText || m.contract!=='dshos-cloud-pairing-v3' || m.product!=='harmony-dsh' ||
    !['PRODUCTION','SANDBOX'].includes(m.environment as string) || !registrationId(m.attemptId) || !registrationId(m.mobilePublicKey,32) ||
    !Number.isSafeInteger(m.createdAt) || (m.createdAt as number)<0 || m.expiresAt!==(m.createdAt as number)+300000 ||
    b.computerId!==d.computerId || b.memberId!==d.memberId || b.newPairingId!==d.pairingId || b.newMobilePublicKey!==m.mobilePublicKey ||
    b.invitationDigest!==cloudDigest(m) || !['accountBindingId','registrationGeneration','memberKeyGeneration','newPairingGeneration'].every(k=>registrationId(b[k])) ||
    !['establishPairing','restoreDshPairing'].includes(b.purpose as string)) throw Error('cloud_pairing_receipt_scope')
  const domain=b.purpose==='restoreDshPairing'?'DSH-PAIR-RECOVERY':'MEMBER-PAIRING'
  for (const [side,pub,sig] of [['MEMBER',d.memberPublicKey,receipt.memberSignature],['MOBILE',m.mobilePublicKey,receipt.mobileSignature]] as const) {
    if (!registrationId(sig,64) || !verify(null,registrationTranscript(domain+'/'+side,b),
      createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:pub as string},format:'jwk'}),Buffer.from(sig,'base64url')))
      throw Error('cloud_pairing_receipt_proof')
  }
  return b
}
/** The outer signature binds the whole original request, not a rewritten payload.
 * Historical receipts alone never pass this current-authority gate. */
export function readCloudCurrent(text: string, request: CloudRequest, receipt: CloudReceipt,
  trust: {keyId:string;publicKey:string}, now: number): CloudPayload {
  if (Buffer.byteLength(text)>16384) throw Error('cloud_pairing_response_capacity')
  const parsed=JSON.parse(text)
  if (JSON.stringify(parsed)!==text || !cloudFields(parsed,['contract','product','environment','keyId','requestId','requestDigest','serverTime','result','signature']))
    throw Error('cloud_pairing_response_format')
  const {signature,...reply}=parsed
  if (reply.contract!==request.contract || reply.product!==request.product || reply.environment!==request.environment ||
    reply.keyId!==trust.keyId || reply.requestId!==request.requestId || reply.requestDigest!==cloudDigest(request) ||
    !Number.isSafeInteger(reply.serverTime) || (reply.serverTime as number)<request.issuedAt-30000 || (reply.serverTime as number)>=request.expiresAt ||
    !cloudVerify('RESPONSE',reply,trust.publicKey,signature)) throw Error('cloud_pairing_response_proof')
  const result=reply.result as CloudPayload, b=validateCloudReceipt(receipt), m=receipt.manifest, d=parseCloudDesktop(m.desktop)
  const connection=request.operation==='connect'||request.operation==='publish'
  const relay=['relay-deliver','relay-read','relay-ack'].includes(request.operation)
  if (!cloudFields(result,['contract','product','environment','attemptId','manifest','pairingText','body','nonce','computer','members','issuedAt','expiresAt',...(connection?['connection']:[]),...(relay?['relay']:[])]) ||
    result.contract!=='dshos-cloud-binding-current-v3' || result.product!==request.product || result.environment!==request.environment ||
    result.attemptId!==request.attemptId || m.attemptId!==request.attemptId || m.environment!==request.environment ||
    request.publicKey!==(request.role==='desktop'?d.registrationPublicKey:m.mobilePublicKey) ||
    cloudDigest(result.manifest)!==cloudDigest(m) || result.pairingText!==receipt.pairingText || JSON.stringify(result.body)!==receipt.pairingText ||
    result.nonce!==cloudDigest(request) || !Number.isSafeInteger(now) || !Number.isSafeInteger(result.issuedAt) ||
    result.issuedAt!==reply.serverTime || result.expiresAt!==(result.issuedAt as number)+30000 || now<(result.issuedAt as number)-30000 ||
    now>=(result.expiresAt as number)) throw Error('cloud_pairing_current_scope')
  const c=result.computer
  if (!cloudFields(c,['computerId','accountBindingId','registrationGeneration','registrationPublicKey','everDual']) ||
    c.computerId!==d.computerId || c.accountBindingId!==b.accountBindingId || c.registrationPublicKey!==d.registrationPublicKey ||
    !registrationId(c.registrationGeneration) || typeof c.everDual!=='boolean' || !Array.isArray(result.members) ||
    result.members.length<1 || result.members.length>2) throw Error('cloud_pairing_current_scope')
  const platforms=new Set(),ids=new Set(),keys=new Set([d.registrationPublicKey,m.mobilePublicKey]); let own=false
  for (const member of result.members) {
    if (!cloudFields(member,['platform','memberId','memberPublicKey','keyGeneration']) || !['dsh','pi'].includes(member.platform as string) ||
      platforms.has(member.platform) || ids.has(member.memberId) || keys.has(member.memberPublicKey) ||
      !registrationId(member.memberId) || !registrationId(member.memberPublicKey,32) || !registrationId(member.keyGeneration)) throw Error('cloud_pairing_current_scope')
    platforms.add(member.platform);ids.add(member.memberId);keys.add(member.memberPublicKey)
    if (member.platform==='dsh') { own=true
      if (member.memberId!==d.memberId || member.memberPublicKey!==d.memberPublicKey || member.keyGeneration!==b.memberKeyGeneration) throw Error('cloud_pairing_current_scope') }
  }
  if (!own) throw Error('cloud_pairing_current_scope')
  if(relay){
    const r=result.relay
    if(!cloudFields(r,['state','packet'])||!['empty','pending','acknowledged'].includes(r.state as string)||
      (r.state==='empty')!==(r.packet===null))throw Error('cloud_pairing_relay_scope')
    if(r.packet!==null){const packet=r.packet as {header:{keyId:string}};cloudRelayPacket(packet,result,packet.header?.keyId,now)}
  }
  return result
}
