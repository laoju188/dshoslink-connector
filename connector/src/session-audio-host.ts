import type { Context } from '@deepseek-ai/cordis'
import { AUDIO_MAX_BYTES,type AudioSourceReference } from './session-audio-contract.js'
/** Official host services only. Call only after proving this reference is in the selected Session. */
export async function readHostAudio(ctx:Context,source:AudioSourceReference,signal:AbortSignal,maxBytes=AUDIO_MAX_BYTES):Promise<Uint8Array>{
  signal.throwIfAborted()
  if(source.attachment){
    if(source.attachment.bytes>maxBytes)throw Error('media too large')
    const store=ctx.get('attachments') as unknown as {readFileStream?:(ref:unknown,signal:AbortSignal)=>AsyncIterable<Uint8Array>}|undefined
    if(!store?.readFileStream)throw Error('host file attachments unavailable')
    const data=new Uint8Array(source.attachment.bytes);let offset=0
    try{
      for await(const chunk of store.readFileStream(source.attachment,signal)){
        signal.throwIfAborted()
        if(!(chunk instanceof Uint8Array)||offset+chunk.length>data.length)throw Error('invalid audio length')
        data.set(chunk,offset);offset+=chunk.length
      }
      if(offset!==data.length)throw Error('incomplete audio')
      return data
    }catch(e){data.fill(0);throw e}
  }
  if(!source.file)throw Error('missing audio source')
  const fs=ctx.get('fs') as unknown as {resolve:(path:string,opts:{signal:AbortSignal})=>Promise<unknown>;stat:(ref:unknown,signal:AbortSignal)=>Promise<{type:string;size?:number}|undefined>;readBytes:(ref:unknown,signal:AbortSignal,maxBytes:number)=>Promise<Uint8Array>}|undefined
  if(!fs?.resolve||!fs?.readBytes||!fs?.stat)throw Error('host file reader unavailable')
  const target=await fs.resolve(source.file,{signal});signal.throwIfAborted()
  const info=await fs.stat(target,signal);signal.throwIfAborted()
  if(!info||info.type!=='file'||info.size!==undefined&&info.size>maxBytes)throw Error('media unavailable')
  return fs.readBytes(target,signal,maxBytes)
}
