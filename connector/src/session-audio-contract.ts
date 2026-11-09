import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute } from 'node:path'
export const AUDIO_MAX_BYTES = 16 * 1024 * 1024
export const AUDIO_CHUNK_BYTES = 128 * 1024
export interface AudioReference { readonly id: string; readonly name: string; readonly mediaType: string; readonly bytes: number | null; readonly blockIndex: number }
export interface AudioSourceReference { readonly ref: AudioReference; readonly file?: string; readonly attachment?: { attachmentId: string; name: string; bytes: number } }
export interface AudioRequest { type: 'session_audio_request' | 'session_gif_request'; protocolVersion: 1; sessionId: string; seq: number; blockIndex: number; id: string; offset: number; sha256: string | null }
export const record = (v: unknown): v is Record<string,unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const mime = (name: string): string | undefined => ({'.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.wav':'audio/wav',
  '.ogg':'audio/ogg','.opus':'audio/opus','.flac':'audio/flac','.amr':'audio/amr','.wma':'audio/x-ms-wma'} as Record<string,string>)[extname(name).toLowerCase()]
export const supportedAudioType = (type: string): boolean => ['audio/mpeg','audio/mp4','audio/aac','audio/wav'].includes(type)
/** References come exclusively from public persisted Session events, never a client path. */
export function eventAudio(event: Record<string,unknown>): AudioSourceReference[] {
  const data = event.data
  if (!record(data) || !Number.isSafeInteger(event.seq)) return []
  if (event.type === 'deliverables/presented' && Array.isArray(data.files)) {
    return data.files.flatMap((file: unknown,index): AudioSourceReference[] => {
      if (!record(file) || typeof file.path !== 'string' || !isAbsolute(file.path) || file.path.includes('\0')) return []
      const name = basename(file.path), mediaType = mime(name)
      if (!mediaType || name.length > 256) return []
      return [{file:file.path,ref:{id:createHash('sha256').update(JSON.stringify([event.seq,index,file.path])).digest('hex'),name,mediaType,bytes:null,blockIndex:index}}]
    })
  }
  // Only public response blocks. User uploads are not Bot replies.
  if (!['assistant/message','tool/result'].includes(String(event.type)) || !record(data.message) || !Array.isArray(data.message.content)) return []
  return data.message.content.flatMap((block: unknown,index): AudioSourceReference[] => {
    if (!record(block) || block.type !== 'file' || !record(block.attachment)) return []
    const a = block.attachment
    if (typeof a.name !== 'string' || a.name.length > 256 || a.name !== basename(a.name) || typeof a.attachmentId !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(a.attachmentId) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 1) return []
    const mediaType = mime(a.name)
    if (!mediaType) return []
    const attachment = {attachmentId:a.attachmentId,name:a.name,bytes:Number(a.bytes)}
    return [{attachment,ref:{id:a.attachmentId.slice(7),name:a.name,mediaType,bytes:Number(a.bytes),blockIndex:index}}]
  })
}
export function findAudio(raw: unknown, request: Pick<AudioRequest,'sessionId'|'seq'|'blockIndex'|'id'>,
  references = eventAudio): AudioSourceReference | undefined {
  if (!record(raw) || !record(raw.session) || raw.session.id !== request.sessionId || !Array.isArray(raw.events)) return undefined
  let previous=-1, found: AudioSourceReference | undefined
  for (const e of raw.events) {
    if (!record(e) || !Number.isSafeInteger(e.seq) || Number(e.seq)<=previous) return undefined
    previous=Number(e.seq)
    if(e.seq===request.seq) found=references(e).find(a=>a.ref.blockIndex===request.blockIndex && a.ref.id===request.id)
  }
  return found
}
export function parseAudioRequest(body: Uint8Array, type: AudioRequest['type'] = 'session_audio_request',
  limit: number = AUDIO_MAX_BYTES): AudioRequest | undefined {
  try {
    if(body.byteLength>4096)return undefined
    const text=new TextDecoder('utf-8',{fatal:true}).decode(body), v:unknown=JSON.parse(text)
    if(!record(v)||JSON.stringify(v)!==text||Object.keys(v).join(',')!=='type,protocolVersion,sessionId,seq,blockIndex,id,offset,sha256'
      ||v.type!==type||v.protocolVersion!==1||typeof v.sessionId!=='string'||v.sessionId.length<1||v.sessionId.length>256
      ||!Number.isSafeInteger(v.seq)||Number(v.seq)<0||!Number.isSafeInteger(v.blockIndex)||Number(v.blockIndex)<0
      ||typeof v.id!=='string'||!/^[0-9a-f]{64}$/.test(v.id)||!Number.isSafeInteger(v.offset)||Number(v.offset)<0||Number(v.offset)>=limit
      ||Number(v.offset)%AUDIO_CHUNK_BYTES!==0 || (v.offset===0?v.sha256!==null:typeof v.sha256!=='string'||!/^[0-9a-f]{64}$/.test(v.sha256)))return undefined
    return v as unknown as AudioRequest
  }catch{return undefined}
}
export function audioSignature(data: Uint8Array, type: string): boolean {
  const b=Buffer.from(data.buffer,data.byteOffset,data.byteLength)
  if(type==='audio/wav')return b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'
  if(type==='audio/mp4')return b.length>=16&&b.toString('ascii',4,8)==='ftyp'&&['M4A ','isom','mp42','mp41'].includes(b.toString('ascii',8,12))
  if(type==='audio/aac')return b.length>=7&&b[0]===255&&(b[1]!&0xf6)===0xf0
  return type==='audio/mpeg'&&b.length>=4&&(b.toString('ascii',0,3)==='ID3'||b[0]===255&&(b[1]!&0xe0)===0xe0)
}
