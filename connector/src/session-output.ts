import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { closedOutputLease, type OutputLease } from './session-output-lease.js'

export const OUTPUT_CHUNK_BYTES=16384
const MAX_HASH_BYTES=8*1024*1024, MAX_OUTPUTS=8, CACHE_MS=60_000
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).sort().join(',')===keys.sort().join(',')
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const pathKey=(p:string)=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p)
const samePath=(a:string,b:string)=>pathKey(a)===pathKey(b)
const fact=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.birthtimeNs].map(v=>String(v))
const sameFact=(a:BigIntStats,b:BigIntStats)=>JSON.stringify(fact(a))===JSON.stringify(fact(b))
const regular=(s:BigIntStats)=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.ino>0n
export interface OutputRequest { readonly type:'session_output_info_request'|'session_output_chunk_request';readonly protocolVersion:1;readonly sessionId:string;readonly seq:number;readonly outputId?:string;readonly revision?:string;readonly offset?:number }
interface Ref { readonly path:string;readonly kind:'formatted'|'stdout'|'stderr';readonly outputId:string;readonly sourceRevision:string;readonly root:string;readonly toolName:string;readonly parentId?:string }
interface Snapshot {readonly ref:Ref;readonly stat:BigIntStats;readonly bytes:number;readonly revision:string;readonly sha256:string;readonly hashes:Buffer;readonly expiresAt:number;readonly nested:Ref[]}
export interface OutputSource {readSession?(sessionId:string):Promise<unknown>;outputRoot?():string|undefined}
export function parseSessionOutputRequest(bytes:Uint8Array):OutputRequest|undefined{
  if(bytes.length<1||bytes.length>4096)return
  try{
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),v:unknown=JSON.parse(text)
    if(!object(v)||v.protocolVersion!==1||typeof v.sessionId!=='string'||v.sessionId.length<1||v.sessionId.length>256
      ||!Number.isSafeInteger(v.seq)||Number(v.seq)<0)return
    const info=v.type==='session_output_info_request'
    if(!info&&v.type!=='session_output_chunk_request'||!exact(v,info?['type','protocolVersion','sessionId','seq']:['type','protocolVersion','sessionId','seq','outputId','revision','offset']))return
    if(!info&&(typeof v.outputId!=='string'||!/^[0-9a-f]{64}$/.test(v.outputId)||typeof v.revision!=='string'||!/^[0-9a-f]{64}$/.test(v.revision)||!Number.isSafeInteger(v.offset)||Number(v.offset)<0||Number(v.offset)%OUTPUT_CHUNK_BYTES!==0))return
    const request:OutputRequest={type:info?'session_output_info_request':'session_output_chunk_request',protocolVersion:1,sessionId:v.sessionId,seq:Number(v.seq),
      ...info?{}:{outputId:String(v.outputId),revision:String(v.revision),offset:Number(v.offset)}}
    return JSON.stringify(request)===text?request:undefined
  }catch{return}
}

/** The namespace is an output-asset allowlist, never a general filesystem reader.
 * Only references in an official tool result linked to its call are considered.
 * Public assistant/user text, paths supplied by a phone, and private metadata grant no access.
 */
export function sessionOutputReferences(raw:unknown,request:Pick<OutputRequest,'sessionId'|'seq'>,tempRoot=tmpdir(),configuredRoot?:string,owners:readonly string[]=[request.sessionId]):Ref[]{
  if(!object(raw)||!object(raw.session)||raw.session.id!==request.sessionId||!Array.isArray(raw.events))throw Error('output_unavailable')
  const event=raw.events.find((v:unknown)=>object(v)&&v.seq===request.seq)
  if(!object(event)||event.type!=='tool/result'||!object(event.data)||!object(event.data.message))return[]
  const eventData=event.data
  const message=eventData.message as Record<string,unknown>,source=message.source
  if(message.role!=='tool'||!object(source)||source.kind!=='tool'||typeof message.toolCallId!=='string'||source.callId!==message.toolCallId||!Array.isArray(message.content))return[]
  const call=raw.events.find((v:unknown)=>object(v)&&v.type==='tool/call'&&Number(v.seq)<request.seq&&object(v.data)
    &&v.data.callId===message.toolCallId&&v.data.turn===eventData.turn&&v.data.step===eventData.step)
  if(!object(call)||!object(call.data)||typeof call.data.name!=='string'
    ||!Array.isArray(event.sourceEventSeqs)||!event.sourceEventSeqs.includes(call.seq))return[]
  const toolName=String(call.data.name)
  const text=(message.content as unknown[]).filter((v:unknown)=>object(v)&&v.type==='text'&&typeof v.text==='string').map(v=>String((v as Record<string,unknown>).text)).join('\n')
  const sourceRevision=sha(JSON.stringify([request.sessionId,request.seq,call,message,owners]))
  const references:Ref[]=[]
  const add=(path:string,kind:Ref['kind']):void=>{
    const ref=outputReference(path,kind,request,toolName,sourceRevision,tempRoot,configuredRoot,owners)
    if(!ref||references.some(v=>v.outputId===ref.outputId))return
    if(references.length===MAX_OUTPUTS)throw Error('output_capacity')
    references.push(ref)
  }
  // Official terminal result notices carry fixed artifact namespaces and stream suffixes.
  for(const match of text.matchAll(/^\[output truncated; full output: ([^\r\n]+)\]$/gm)){
    const path=match[1]!,suffix=/-((?:stdout|stderr))\.log$/.exec(path)
    if(suffix)add(path,suffix[1] as 'stdout'|'stderr')
  }
  // The final policy notice may contain arbitrary retrieval words, but never an arbitrary root.
  const notice=/(?:^|\n\n)\((?:Omitted (?:[0-9]+|an unknown number of) bytes\.|No bytes omitted\.)(?: Omitted [1-9][0-9]* images\.)? Full formatted result stored at: ([^\r\n]+?)\. [^\r\n]+\)$/.exec(text)
  if(notice)add(notice[1]!,'formatted')
  return references
}


function outputReference(path:string,kind:Ref['kind'],request:Pick<OutputRequest,'sessionId'|'seq'>,
  toolName:string,sourceRevision:string,tempRoot:string,configuredRoot?:string,owners:readonly string[]=[request.sessionId]):Ref|undefined{
  if(!isAbsolute(path)||path.length>1024||/[\u0000\r\n]/.test(path))return
  const parent=dirname(path),root=kind==='formatted'?dirname(parent):parent,name=basename(path)
  if(kind==='formatted'){
    if(!owners.some(id=>basename(parent)==='session-'+sha(id).slice(0,12))||!/^[0-9a-f]{12}-[A-Za-z0-9._~-]+$/.test(name))return
    if(!(samePath(dirname(root),tempRoot)&&/^dsh-spill-[A-Za-z0-9]{6}$/.test(basename(root)))
      &&!(configuredRoot&&samePath(root,configuredRoot)))return
  }else{
    if(!['bash','pwsh'].includes(toolName)||!samePath(dirname(root),tempRoot)||!/^dsh-subprocess-[A-Za-z0-9]{6}$/.test(basename(root))
      ||!new RegExp('^dsh-subprocess-[1-9][0-9]*-[1-9][0-9]*-[0-9a-f]{12}-'+kind+'\\.log$').test(name))return
  }
  return{path,kind,root,toolName,sourceRevision,outputId:sha(JSON.stringify(['DSH-OUTPUT/V1',request.sessionId,request.seq,kind,pathKey(path)]))}
}
// Stream the formatted file one bounded line at a time. Only one official subprocess
// layer is recognized; no arbitrary file recursion, instructions or retrieval commands.
function nestedScanner(parent:Ref,request:OutputRequest,tempRoot:string):{push:(bytes:Buffer)=>void;finish:()=>Ref[]}{
  const decoder=new TextDecoder('utf-8',{fatal:true}),refs:Ref[]=[]
  let pending='',discard=false
  const line=(text:string):void=>{
    const match=/^\[output truncated; full output: ([^\r\n]+)\]\r?$/.exec(text)
    if(!match)return
    const suffix=/-(stdout|stderr)\.log$/.exec(match[1]!)
    if(!suffix)return
    const ref=outputReference(match[1]!,suffix[1] as 'stdout'|'stderr',request,parent.toolName,parent.sourceRevision,tempRoot)
    if(!ref||refs.some(v=>v.outputId===ref.outputId))return
    if(refs.length>=MAX_OUTPUTS)throw Error('output_capacity')
    refs.push(ref)
  }
  const consume=(text:string):void=>{
    let at=0
    while(at<text.length){
      const end=text.indexOf('\n',at),part=text.slice(at,end<0?text.length:end)
      if(!discard){if(pending.length+part.length>1100){discard=true;pending=''}else pending+=part}
      if(end<0)break
      if(!discard)line(pending)
      pending='';discard=false;at=end+1
    }
  }
  return{push:bytes=>consume(decoder.decode(bytes,{stream:true})),finish:()=>{consume(decoder.decode());if(!discard)line(pending);return refs}}
}

export class SessionOutputReader {
  private readonly cache=new Map<string,Snapshot>()
  private hashBytes=0
  private busy=false
  constructor(private readonly source:OutputSource,private readonly tempRoot=tmpdir()){}
  private key(scope:string,request:OutputRequest,id:string):string{return sha(JSON.stringify([scope,request.sessionId,request.seq,id]))}
  private prune():void{for(const [key,value]of this.cache)if(value.expiresAt<=Date.now()){this.cache.delete(key);this.hashBytes-=value.hashes.length}}
  private remember(key:string,value:Snapshot):void{
    const old=this.cache.get(key);if(old){this.hashBytes-=old.hashes.length;this.cache.delete(key)}
    while(this.cache.size&&(this.cache.size>=MAX_OUTPUTS||this.hashBytes+value.hashes.length>MAX_HASH_BYTES)){
      const first=this.cache.keys().next().value!,removed=this.cache.get(first)!;this.cache.delete(first);this.hashBytes-=removed.hashes.length
    }
    this.cache.set(key,value);this.hashBytes+=value.hashes.length
  }
  private async namespaceOwners(raw:unknown,request:OutputRequest,check:()=>void):Promise<string[]>{
    const owners=[request.sessionId]
    let current=raw
    while(object(current)&&object(current.session)&&Array.isArray(current.events)&&current.session.isSeeded===true){
      const inherited=current.inheritedEventCount
      if(!Number.isSafeInteger(inherited)||Number(inherited)<0||Number(inherited)>current.events.length)throw Error('output_unavailable')
      if(request.seq>=Number(inherited))break
      const parentId=current.session.parentSession
      if(typeof parentId!=='string'||!parentId.length||parentId.length>256||owners.includes(parentId))throw Error('output_unavailable')
      if(owners.length>=32)throw Error('output_capacity')
      const event=current.events.find((e:unknown)=>object(e)&&e.seq===request.seq)
      if(!object(event)||event.type!=='tool/result'||!object(event.data)||!object(event.data.message))break
      const callId=event.data.message.toolCallId
      const call=current.events.find((e:unknown)=>object(e)&&e.type==='tool/call'&&object(e.data)&&e.data.callId===callId
        &&Array.isArray(event.sourceEventSeqs)&&event.sourceEventSeqs.includes(e.seq))
      if(!object(call))throw Error('output_unavailable')
      check();const parent=await this.source.readSession!(parentId);check()
      if(!object(parent)||!object(parent.session)||parent.session.id!==parentId||!Array.isArray(parent.events))throw Error('output_unavailable')
      const inheritedEvent=parent.events.find((e:unknown)=>object(e)&&e.seq===request.seq)
      const inheritedCall=parent.events.find((e:unknown)=>object(e)&&e.seq===call.seq)
      if(JSON.stringify(inheritedEvent)!==JSON.stringify(event)||JSON.stringify(inheritedCall)!==JSON.stringify(call))throw Error('output_changed')
      owners.push(parentId);current=parent
    }
    return owners
  }
  private async references(request:OutputRequest,check:()=>void,scope:string,includeNested=true):Promise<Ref[]>{
    check();if(!this.source.readSession)throw Error('output_unsupported')
    const raw=await this.source.readSession(request.sessionId);check()
    const owners=await this.namespaceOwners(raw,request,check)
    const refs=sessionOutputReferences(raw,request,this.tempRoot,this.source.outputRoot?.(),owners)
    if(includeNested)for(const parent of refs.slice()){
      if(parent.kind!=='formatted')continue
      const key=this.key(scope,request,parent.outputId),cached=this.cache.get(key)
      if(!cached||cached.ref.sourceRevision!==parent.sourceRevision||cached.nested.length===0)continue
      if(request.type==='session_output_chunk_request'&&!cached.nested.some(v=>v.outputId===request.outputId))continue
      await this.verifyPath(parent,check)
      const stat=await lstat(parent.path,{bigint:true});check()
      if(!regular(stat)||!sameFact(cached.stat,stat))throw Error('output_changed')
      for(const ref of cached.nested)if(!refs.some(v=>v.outputId===ref.outputId)){
        if(refs.length>=MAX_OUTPUTS)throw Error('output_capacity')
        refs.push(ref)
      }
      this.cache.set(key,{...cached,expiresAt:Date.now()+CACHE_MS})
    }
    return refs
  }
  private async verifyPath(ref:Ref,check:()=>void):Promise<void>{
    const parent=dirname(ref.path)
    for(const directory of [...new Set([ref.root,parent])]){
      const entry=await lstat(directory);check()
      if(!entry.isDirectory()||entry.isSymbolicLink()||!samePath(await realpath(directory),directory))throw Error('output_unavailable');check()
    }
    if(!samePath(await realpath(ref.path),ref.path))throw Error('output_unavailable');check()
  }
  private async read(ref:Ref,request:OutputRequest,check:()=>void,scope:string):Promise<Record<string,unknown>>{
    let handle:FileHandle|undefined,lease:OutputLease|undefined,data:Buffer|undefined
    const info=request.type==='session_output_info_request',key=this.key(scope,request,ref.outputId)
    try{
      await this.verifyPath(ref,check)
      const named=await lstat(ref.path,{bigint:true});check()
      if(!regular(named))throw Error('output_unavailable')
      const cached=this.cache.get(key)
      if(!info&&(!cached||cached.revision!==request.revision||cached.ref.sourceRevision!==ref.sourceRevision))throw Error('output_changed')
      if(info){lease=await closedOutputLease(ref.path);check();lease.assertHeld()}
      handle=await open(ref.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));check()
      const initial=await handle.stat({bigint:true});check()
      if(!regular(initial)||!sameFact(named,initial))throw Error('output_changed')
      const bytes=Number(initial.size),hashLength=Math.ceil(bytes/OUTPUT_CHUNK_BYTES)*32
      if(!Number.isSafeInteger(bytes)||bytes<=0||hashLength>MAX_HASH_BYTES)throw Error('output_capacity')
      if(cached&&!info&&(!sameFact(cached.stat,initial)||request.offset!>=bytes))throw Error('output_changed')
      let result:Record<string,unknown>,snapshot:Snapshot|undefined
      if(info){
        const scanner=ref.kind==='formatted'&&['pwsh','bash'].includes(ref.toolName)?nestedScanner(ref,request,this.tempRoot):undefined
        const hashes=Buffer.alloc(hashLength),full=createHash('sha256');data=Buffer.alloc(Math.min(bytes,OUTPUT_CHUNK_BYTES))
        for(let offset=0;offset<bytes;offset+=OUTPUT_CHUNK_BYTES){
          const count=Math.min(data.length,bytes-offset);let read=0
          while(read<count){const part=await handle.read(data,read,count-read,offset+read);check();lease!.assertHeld();if(!part.bytesRead)throw Error('output_changed');read+=part.bytesRead}
          const chunk=data.subarray(0,count);scanner?.push(chunk);full.update(chunk);createHash('sha256').update(chunk).digest().copy(hashes,offset/OUTPUT_CHUNK_BYTES*32)
        }
        const sha256=full.digest('hex'),revision=sha(JSON.stringify([ref.outputId,ref.sourceRevision,fact(initial),sha256]))
        const nested=(scanner?.finish()??[]).map(child=>({...child,parentId:ref.outputId,sourceRevision:sha(JSON.stringify([child.sourceRevision,revision,child.outputId]))}))
        snapshot={ref,stat:initial,bytes,revision,sha256,hashes,nested,expiresAt:Date.now()+CACHE_MS}
        result={outputId:ref.outputId,kind:ref.kind,revision,bytes,sha256,encoding:'utf-8',chunkBytes:OUTPUT_CHUNK_BYTES}
      }else{
        data=Buffer.alloc(Math.min(OUTPUT_CHUNK_BYTES,bytes-request.offset!));let read=0
        while(read<data.length){const part=await handle.read(data,read,data.length-read,request.offset!+read);check();if(!part.bytesRead)throw Error('output_changed');read+=part.bytesRead}
        const index=request.offset!/OUTPUT_CHUNK_BYTES*32
        if(!createHash('sha256').update(data).digest().equals(cached!.hashes.subarray(index,index+32)))throw Error('output_changed')
        result={type:'session_output_chunk',protocolVersion:1,sessionId:request.sessionId,seq:request.seq,outputId:ref.outputId,revision:cached!.revision,bytes,offset:request.offset,data:data.toString('base64url'),last:request.offset!+data.length===bytes}
      }
      const final=await handle.stat({bigint:true});check();const current=await lstat(ref.path,{bigint:true});check()
      if(!regular(final)||!regular(current)||!sameFact(initial,final)||!sameFact(initial,current))throw Error('output_changed')
      await this.verifyPath(ref,check);lease?.assertHeld()
      const refs=await this.references(request,check,scope,ref.parentId!==undefined)
      if(!refs.some(v=>v.outputId===ref.outputId&&v.sourceRevision===ref.sourceRevision&&v.path===ref.path))throw Error('output_changed')
      check();lease?.assertHeld();if(snapshot)this.remember(key,snapshot)
      else if(cached)this.cache.set(key,{...cached,expiresAt:Date.now()+CACHE_MS})
      return result
    }finally{data?.fill(0);try{await handle?.close()}finally{await lease?.release()}}
  }
  async handle(request:OutputRequest,check:()=>void,scope:string):Promise<string>{
    check();if(this.busy)throw Error('output_busy');this.busy=true;this.prune()
    try{
      const refs=await this.references(request,check,scope,request.type!=='session_output_info_request')
      if(request.type==='session_output_info_request'){
        const outputs:Record<string,unknown>[]=[]
        for(const ref of refs){
          outputs.push(await this.read(ref,request,check,scope))
          const snapshot=this.cache.get(this.key(scope,request,ref.outputId))
          for(const nested of snapshot?.nested??[])if(!refs.some(v=>v.outputId===nested.outputId)){
            if(refs.length>=MAX_OUTPUTS)throw Error('output_capacity')
            refs.push(nested)
          }
        }
        if(refs.some(ref=>!this.cache.has(this.key(scope,request,ref.outputId))))throw Error('output_capacity')
        check();return JSON.stringify({type:'session_output_info',protocolVersion:1,sessionId:request.sessionId,seq:request.seq,outputs})
      }
      const ref=refs.find(v=>v.outputId===request.outputId);if(!ref)throw Error('output_changed')
      return JSON.stringify(await this.read(ref,request,check,scope))
    }finally{this.busy=false}
  }
}
