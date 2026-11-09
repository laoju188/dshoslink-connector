import { contentPage, isContentPageRequest, type ContentBlock, type ContentMessage, type ContentPageRequest } from './session-content-page.js'
import { eventAudio, supportedAudioType } from './session-audio-contract.js'
import { eventSessionMedia } from './session-media-contract.js'
import { imageReference } from './session-image-contract.js'
import { createHash } from 'node:crypto'
const object = (v: unknown): v is Record<string,unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export interface SessionContentRequest {
  readonly sessionId: string
  readonly page: ContentPageRequest
  readonly protocolVersion?: 4 | 5 | 6 | 7 | 8
  readonly processTurn?: number | null
}
const validTurn = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
export function parseSessionContentRequest(bytes: Uint8Array): SessionContentRequest | undefined {
  try {
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes), v: unknown = JSON.parse(text)
    if (!object(v) || JSON.stringify(v) !== text || v.type !== 'session_detail_request' || typeof v.sessionId !== 'string'
      || v.sessionId.length < 1 || v.sessionId.length > 256 || !isContentPageRequest(v.page)) return undefined
    const keys = Object.keys(v).sort().join(',')
    const version = v.protocolVersion
    if (version === 8 && keys === 'page,processTurn,protocolVersion,sessionId,type' &&
      (v.processTurn === null || validTurn(v.processTurn))) {
      return {sessionId:v.sessionId,page:v.page,protocolVersion:8,processTurn:v.processTurn}
    }
    if (keys !== 'page,protocolVersion,sessionId,type' ||
      (version !== 4 && version !== 5 && version !== 6 && version !== 7)) return undefined
    return {sessionId:v.sessionId,page:v.page,protocolVersion:version}
  } catch { return undefined }
}
function blocks(content: unknown, includeReasoning: boolean): ContentBlock[] {
  if (!Array.isArray(content)) throw Error('invalid conversation content')
  const result: ContentBlock[] = []
  for (let index=0;index<content.length;index++) {
    const b: unknown = content[index]
    if (!object(b) || typeof b.type !== 'string') throw Error('invalid conversation block')
    if (b.type === 'text') {
      if (typeof b.text !== 'string') throw Error('invalid conversation text')
      result.push({index,kind:'text',text:b.text})
    } else if (b.type === 'reasoning' && includeReasoning) {
      if (typeof b.text !== 'string') throw Error('invalid public reasoning')
      result.push({index,kind:'reasoning',text:b.text})
    } else if (b.type === 'image') {
      const image = imageReference(b.attachment,index)
      if (image) result.push({index,kind:'image',image})
    } else if (b.type === 'tool-call') {
      if (typeof b.name !== 'string' || typeof b.arguments !== 'string') throw Error('invalid conversation tool call')
      result.push({index,kind:'tool-call',text:b.name+'\n'+b.arguments})
    }
    // Never serialize opaque metadata, system/developer context, or private tool meta.
  }
  return result
}
// Only user-visible terminal facts. AUTH messages are deliberately suppressed by
// the official Chat renderer; arbitrary error fields must never be stringified.
function turnNotice(data: unknown): string | null {
  if (!object(data) || !Number.isSafeInteger(data.turn) || Number(data.turn) < 1 || !object(data.reason)) return null
  const reason = data.reason
  if (reason.kind === 'max-tokens') return '本轮回复已达到模型输出长度限制，内容可能尚未完成。'
  if (reason.kind === 'interrupted') return '本轮意外中断，现有回复可能尚未完成。'
  if (reason.kind === 'aborted') {
    if (object(reason.reason) && reason.reason.kind === 'hook' && reason.reason.reason === 'deepseek-account/signed-out')
      return '已退出 DeepSeek，本轮已停止。'
    return '本轮已停止，现有回复可能尚未完成。'
  }
  if (reason.kind === 'error') {
    const error = reason.error
    if (object(error) && error.code === 'AUTH') return '模型服务认证失败，本轮未完成。'
    return '本轮失败：' + (object(error) && typeof error.message === 'string' && error.message.length > 0 ? error.message : '未知错误')
  }
  return null
}

// The desktop shows a summary only after its correlated replacement checkpoint lands.
// The framing in checkpoint.data.content and the summarizer's rawOutput are internal.
function publicCompaction(event: Record<string,unknown>, previous: Record<string,unknown> | undefined): ContentMessage | null {
  const data = event.data, op = event.surfaceOp
  if (event.type !== 'user/message' || !object(data) || !object(data.source)
    || data.source.kind !== 'compact-checkpoint' || !object(op) || op.op !== 'replace') return null
  const source = data.source, summary = previous?.data
  if (typeof source.compactionId !== 'string' || source.compactionId.length === 0
    || previous?.type !== 'compaction/summary' || !object(summary) || summary.compactionId !== source.compactionId
    || !object(summary.shadowedRange) || summary.shadowedRange.start !== op.startSeq || summary.shadowedRange.end !== op.endSeq
    || !Number.isSafeInteger(op.startSeq) || Number(op.startSeq) < 0 || !Number.isSafeInteger(op.endSeq)
    || Number(op.endSeq) < Number(op.startSeq) || Number(op.endSeq) >= Number(previous.seq)
    || !Array.isArray(summary.summary)) throw Error('invalid public compaction')
  const visible: ContentBlock[] = []
  for (let index=0;index<summary.summary.length;index++) {
    const block: unknown = summary.summary[index]
    if (!object(block) || typeof block.type !== 'string') throw Error('invalid public compaction block')
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string') throw Error('invalid public compaction text')
    visible.push({index:index+1,kind:'text',text:block.text})
  }
  const title = visible.some(block => block.text!.trim().length > 0) ? '会话压缩摘要' : '会话已压缩（未提供摘要正文）'
  return {id:String(event.seq),seq:Number(event.seq),role:'tool',operationId:null,
    blocks:[{index:0,kind:'text',text:title},...visible]}
}

function audioBlocks(event: Record<string,unknown>): ContentBlock[] {
  return eventAudio(event).map(({ref}) => supportedAudioType(ref.mediaType)
    ? {index:ref.blockIndex,kind:'audio',audio:ref}
    : {index:ref.blockIndex,kind:'text',deliveryNotice:true,text:'音频「'+ref.name+'」暂不支持在手机播放，请在电脑上收听。'})
}
// Correlate only explicit public host call identities within the same turn.
// The wire gets an opaque key, never a guess based on adjacency or tool name.
function toolGroups(event: Record<string,unknown>, content: unknown, visible: readonly ContentBlock[], scope: string): readonly ContentBlock[] {
  const data = event.data
  if (!['assistant/message','tool/result'].includes(String(event.type)) || !object(data) || !Number.isSafeInteger(data.turn) || Number(data.turn) < 1 || !Array.isArray(content)) return visible
  return visible.map(block => {
    if (block.kind === 'audio' || block.kind === 'media') return block
    const original: unknown = content[block.index]
    const id = event.type === 'tool/result' && object(data.message) ? data.message.toolCallId
      : block.kind === 'tool-call' && object(original) ? original.id : undefined
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) return block
    return {...block,toolGroup:createHash('sha256').update(JSON.stringify([scope,data.turn,id])).digest('hex')}
  })
}
interface ReadingTurn {
  number: number
  start: number
  end: number | null
  step: number
  stepClosed: boolean
  answer: number | null
  valid: boolean
}

function readingTurns(events: readonly Record<string, unknown>[]): Map<number, ReadingTurn> {
  const turns = new Map<number, ReadingTurn>()
  let active: ReadingTurn | undefined
  for (const event of events) {
    const data = event.data
    if (!object(data) || !validTurn(data.turn)) continue
    const seq = Number(event.seq)
    const turn = turns.get(data.turn)
    if (event.type === 'turn/start') {
      if (active?.end === null) active.valid = false
      if (turn) { turn.valid = false; continue }
      active = {number:data.turn,start:seq,end:null,step:-1,stepClosed:true,answer:null,valid:true}
      turns.set(data.turn, active)
    } else if (turn?.valid && turn.end === null) {
      if (event.type === 'step/start') {
        if (!Number.isSafeInteger(data.step) || Number(data.step) <= turn.step || !turn.stepClosed) {
          turn.valid = false
          continue
        }
        turn.step = Number(data.step)
        turn.stepClosed = false
        turn.answer = null
      } else if (event.type === 'assistant/message') {
        if (turn.stepClosed || data.step !== turn.step || !object(data.message) ||
          data.message.role !== 'assistant' || !Array.isArray(data.message.content)) {
          turn.valid = false
          continue
        }
        const blocks: unknown[] = data.message.content
        turn.answer = blocks.some(block => object(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) &&
          !blocks.some(block => object(block) && block.type === 'tool-call') ? seq : null
      } else if (event.type === 'tool/call' || event.type === 'tool/result') {
        if (data.step === turn.step) turn.answer = null
      } else if (event.type === 'step/end') {
        turn.valid = data.step === turn.step && !turn.stepClosed
        turn.stepClosed = true
      } else if (event.type === 'turn/end') {
        turn.end = seq
        turn.valid = turn.stepClosed && turn.answer !== null && object(data.reason) && data.reason.kind === 'completed'
      }
    } else if (turn?.valid && (event.type === 'turn/end' || event.type === 'assistant/message')) {
      turn.valid = false
    }
  }
  return turns
}

function readingProcessBlock(message: ContentMessage, block: ContentBlock, turn: ReadingTurn): boolean {
  return !block.deliveryNotice && (block.kind === 'reasoning' || block.kind === 'tool-call' ||
    (block.kind === 'text' && message.seq !== turn.answer))
}

function projected(event: Record<string,unknown>, version: number, previous?: Record<string,unknown>): ContentMessage | null {
  const includeReasoning = version >= 5, audio = version >= 6
  if (includeReasoning) { const summary = publicCompaction(event, previous); if (summary) return summary }

  const type = event.type, data = event.data
  const media: ContentBlock[] = version >= 7 ? eventSessionMedia(event).map(({ ref }) => ({
    index: ref.blockIndex, kind: 'media', media: ref,
  })) : []
  if (audio && type === 'deliverables/presented') return {id:String(event.seq),seq:Number(event.seq),role:'assistant',operationId:null,
    blocks:[...audioBlocks(event), ...media].sort((a,b)=>a.index-b.index)}
  if (type === 'turn/end') {
    const text = turnNotice(data)
    return text === null ? null : { id: String(event.seq), seq: Number(event.seq), role: 'assistant', operationId: null,
      blocks: [{index: 0, kind: 'text', text}] }
  }
  if (!['user/message','assistant/message','tool/result'].includes(String(type))) return null
  if (!object(data)) throw Error('invalid conversation event')
  let content: unknown, operationId: string | null = null
  if (type === 'user/message') {
    if (!object(data.source) || data.source.kind !== 'user') return null
    content=data.content
    const rpcId=data.source.rpcId
    if (typeof rpcId === 'string' && /^[A-Za-z0-9_-]{22}$/.test(rpcId) && Buffer.from(rpcId,'base64url').toString('base64url')===rpcId) operationId=rpcId
  } else {
    if (!object(data.message)) throw Error('invalid conversation message')
    content=data.message.content
  }
  return {id:String(event.seq),seq:Number(event.seq),role:type==='user/message'?'user':type==='tool/result'?'tool':'assistant',operationId,blocks:[...blocks(content,includeReasoning && type === 'assistant/message' && object(data.message) && data.message.role === 'assistant'),...(audio?audioBlocks(event):[]),...media].sort((a,b)=>a.index-b.index)}
}
export function sessionContentResponse(raw: unknown, request: SessionContentRequest): string {
  if (!object(raw) || !object(raw.session) || raw.session.id !== request.sessionId || !Array.isArray(raw.events)) throw Error('invalid conversation log')
  const events: Record<string,unknown>[] = []
  let previous=-1
  for (const e of raw.events) {
    if (!object(e) || typeof e.type !== 'string' || !Number.isSafeInteger(e.seq) || Number(e.seq)<=previous
      || !Number.isSafeInteger(e.time) || Number(e.time)<0) throw Error('invalid conversation sequence')
    previous=Number(e.seq); events.push(e)
  }
  const version = request.protocolVersion ?? 4
  const turns = version === 8 ? readingTurns(events) : undefined
  const processTurns = new Set<number>()
  if (turns && request.processTurn === null) {
    for (const event of events) {
      if (event.type !== 'assistant/message' && event.type !== 'tool/result') continue
      const turn = object(event.data) && validTurn(event.data.turn) ? turns.get(event.data.turn) : undefined
      if (!turn?.valid || turn.end === null || Number(event.seq) < turn.start ||
        Number(event.seq) >= turn.end || processTurns.has(turn.number)) continue
      const data = event.data
      if (!object(data) || !object(data.message) || !Array.isArray(data.message.content)) continue
      if (data.message.content.some((block: unknown) => object(block) &&
        (block.type === 'tool-call' ||
          block.type === 'reasoning' && event.type === 'assistant/message' ||
          block.type === 'text' && event.seq !== turn.answer) &&
        (block.type === 'tool-call' || typeof block.text === 'string' && block.text.length > 0))) {
        processTurns.add(turn.number)
      }
    }
  }
  const page=contentPage({length:events.length,get:index=>{
    const event=events[index]
    const turn = turns && object(event.data) && validTurn(event.data.turn) ? turns.get(event.data.turn) : undefined
    if (turn?.valid && event.type === 'turn/end' && request.processTurn === null && processTurns.has(turn.number)) {
      return {id:String(event.seq),seq:Number(event.seq),role:'assistant',operationId:null,
        blocks:[{index:0,kind:'process',processTurn:turn.number}]}
    }
    const isProcessEvent = event.type === 'assistant/message' || event.type === 'tool/result'
    const inTurn = turn?.valid && turn.end !== null && Number(event.seq) >= turn.start && Number(event.seq) < turn.end
    if (version === 8 && request.processTurn !== null &&
      (!inTurn || !isProcessEvent || turn!.number !== request.processTurn)) return null
    let message=projected(event,version,events[index-1])
    if (message && inTurn && isProcessEvent) {
      message = {...message,blocks:message.blocks.filter(block => {
        const process = readingProcessBlock(message!, block, turn!)
        return request.processTurn === null ? !process : process
      })}
    }
    if (!message || version < 6 || !object(event.data) || !object(event.data.message)) return message
    return {...message,blocks:toolGroups(event,event.data.message.content,message.blocks,request.sessionId)}
  }},'dsh:'+request.sessionId,request.page,version === 8 ? 5 : version === 7 ? 4 : version === 6 ? 3 : version === 5 ? 2 : 1)
  return JSON.stringify({type:'session_detail',protocolVersion:version,sessionId:request.sessionId,
    capturedThroughSeq:previous<0?null:previous,page,...(version===8?{processTurn:request.processTurn}:{})})
}
