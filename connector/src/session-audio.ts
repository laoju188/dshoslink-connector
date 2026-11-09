import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { AUDIO_MAX_BYTES,AUDIO_CHUNK_BYTES,audioSignature,findAudio,supportedAudioType,type AudioRequest,type AudioSourceReference } from './session-audio-contract.js'
import { eventSessionMedia, GIF_MAX_BYTES, gifSignature } from './session-media-contract.js'
import type { PairingV1HttpRequest,PairingV1HttpResponse } from './pairing-backend.js'
import type { SessionListAuthorizer } from './session-list.js'
export interface SessionAudioSource {
  readSession?(id:string):Promise<unknown>
  readAudio?(source:AudioSourceReference,signal:AbortSignal):Promise<Uint8Array>
  readGif?(source:AudioSourceReference,signal:AbortSignal):Promise<Uint8Array>
}
/** One bounded immutable buffer; every chunk rechecks identity, session visibility and generation. */
export class SessionAudioService {
  private cache?: {key:string;reference:string;data:Buffer;sha256:string;expires:number}
  private busy=false
  private epoch=0
  private disposed=false
  private timer?:NodeJS.Timeout
  constructor(private readonly auth:SessionListAuthorizer,private readonly source?:SessionAudioSource,
    private readonly format: 'audio' | 'gif' = 'audio'){}
  private clear():void{this.epoch++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.cache?.data.fill(0);this.cache=undefined}
  dispose():void{this.disposed=true;this.clear()}
  async handle(request:PairingV1HttpRequest,parsed:AudioRequest):Promise<PairingV1HttpResponse>{
    const valid=()=>!this.disposed&&!request.signal?.aborted&&this.auth.authorize(request.authorization,request.connectionGeneration)
    if(!valid()){this.clear();return {status:401,body:''}}
    const gif = this.format === 'gif'
    const load = gif ? this.source?.readGif : this.source?.readAudio
    const maxBytes = gif ? GIF_MAX_BYTES : AUDIO_MAX_BYTES
    const references = gif ? eventSessionMedia : undefined
    if(!this.source?.readSession||!load)return {status:503,body:''}
    if(this.busy)return {status:409,body:''}
    this.busy=true
    const key=JSON.stringify([request.authorization,request.connectionGeneration,parsed.sessionId,parsed.seq,parsed.blockIndex,parsed.id])
    try{
      const ref=findAudio(await this.source.readSession(parsed.sessionId),parsed,references)
      if(!valid()){this.clear();return {status:401,body:''}}
      if(!ref){this.clear();return {status:409,body:''}}
      if(gif ? ref.ref.mediaType !== 'image/gif' : !supportedAudioType(ref.ref.mediaType))return {status:415,body:''}
      if(ref.ref.bytes!==null&&ref.ref.bytes>maxBytes)return {status:413,body:''}
      const reference=JSON.stringify(ref)
      if(this.cache&&(this.cache.key!==key||this.cache.reference!==reference||performance.now()>=this.cache.expires))this.clear()
      if(!this.cache){
        const epoch=this.epoch
        const abort=new AbortController(), stop=()=>abort.abort()
        request.signal?.addEventListener('abort',stop,{once:true})
        const timeout=setTimeout(stop,15000);timeout.unref()
        let data:Buffer|undefined
        try{
          const loaded=await load.call(this.source,ref,abort.signal)
          data=Buffer.from(loaded.buffer,loaded.byteOffset,loaded.byteLength)
          abort.signal.throwIfAborted()
          if(data.length<1||data.length>maxBytes) return {status:413,body:''}
          if(!(gif ? gifSignature(data) : audioSignature(data,ref.ref.mediaType)))return {status:415,body:''}
          const sha256=createHash('sha256').update(data).digest('hex')
          if(ref.attachment&&(data.length!==ref.attachment.bytes||sha256!==ref.ref.id))return {status:422,body:''}
          const current=findAudio(await this.source.readSession(parsed.sessionId),parsed,references)
          if(!valid()||epoch!==this.epoch)return {status:401,body:''}
          if(!current||JSON.stringify(current)!==reference)return {status:409,body:''}
          this.cache={key,reference,data,sha256,expires:performance.now()+60000};data=undefined
          this.timer=setTimeout(()=>this.clear(),60000);this.timer.unref()
        }finally{data?.fill(0);clearTimeout(timeout);request.signal?.removeEventListener('abort',stop)}
      }
      const cached=this.cache
      if(!valid()){this.clear();return {status:401,body:''}}
      if(parsed.sha256!==null&&parsed.sha256!==cached.sha256)return {status:409,body:''}
      if(parsed.offset>=cached.data.length)return {status:400,body:''}
      const end=Math.min(parsed.offset+AUDIO_CHUNK_BYTES,cached.data.length)
      return {status:200,contentType:'application/json',body:JSON.stringify({type:gif?'session_gif_chunk':'session_audio_chunk',protocolVersion:1,sessionId:parsed.sessionId,
        seq:parsed.seq,blockIndex:parsed.blockIndex,id:parsed.id,mediaType:ref.ref.mediaType,bytes:cached.data.length,sha256:cached.sha256,
        offset:parsed.offset,data:cached.data.subarray(parsed.offset,end).toString('base64url'),last:end===cached.data.length})}
    }catch{this.clear();return {status:valid()?503:401,body:''}}finally{this.busy=false}
  }
}
