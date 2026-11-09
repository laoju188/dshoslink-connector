import type { QueueItem } from './session-message-queue.js'
type Value = Record<string, unknown>
const object = (v: unknown): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v)
// Only an exact original user message inside a genuinely closed native turn is
// positive evidence. Absence, a matching text, or an inherited fork is not proof.
export type DshQueueExpectedPart = { type: 'text'; text: string } | { type: 'image'; attachmentId: string; mediaType: string; bytes: number }
function exactContent(content: unknown,expected: readonly DshQueueExpectedPart[]): boolean {
  return Array.isArray(content)&&content.length===expected.length&&content.every((v,index)=>{
    const part=expected[index]
    if(!object(v)||v.type!==part.type)return false
    if(part.type==='text')return v.text===part.text
    return object(v.attachment)&&v.attachment.attachmentId===part.attachmentId&&v.attachment.mediaType===part.mediaType&&v.attachment.bytes===part.bytes
  })
}
export function dshQueueHistoryReceipt(events: readonly unknown[], inherited: number, item: QueueItem, content?: readonly DshQueueExpectedPart[]): string | null {
  if (item.dispatchId === null || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length) return null
  let expected=content
  if(!expected){
    let text: unknown
    try { text=JSON.parse(item.body).text } catch { return null }
    if(typeof text!=='string')return null
    expected=[{type:'text',text}]
  }
  if(!expected.length||expected.length>21||expected.some(p=>p.type==='text'?typeof p.text!=='string':p.type!=='image'
    ||!/^sha256:[0-9a-f]{64}$/.test(p.attachmentId)||!['image/png','image/jpeg','image/webp','image/gif'].includes(p.mediaType)
    ||!Number.isSafeInteger(p.bytes)||p.bytes<1))return null
  let turn: number | null = null, matchTurn: number | null = null, matched: string | null = null, closed = false, matches = 0
  for (let seq = 0; seq < events.length; seq++) {
    const e = events[seq]
    if (!object(e) || e.seq !== seq || !object(e.data)) return null
    const d = e.data
    if (e.type === 'turn/start') {
      if (turn !== null || !Number.isSafeInteger(d.turn) || (d.turn as number) < 1) return null
      turn = d.turn as number
    } else if (e.type === 'turn/end') {
      if (turn === null || d.turn !== turn) return null
      if (matchTurn === turn) closed = object(d.reason) && typeof d.reason.kind === 'string' && !['interrupted', 'forked'].includes(d.reason.kind)
      turn = null
    } else if (e.type === 'user/message' && seq >= inherited && (object(d.source) && d.source.rpcId === item.dispatchId || item.hostRef !== null && d.id === item.hostRef)) {
      matches++
      if (turn === null || seq < inherited || typeof d.id !== 'string' || !d.id || d.id.length > 256
        || item.hostRef !== null && d.id !== item.hostRef || d.role !== 'user'
        || !object(d.source) || d.source.kind !== 'user' || d.source.rpcId !== item.dispatchId
        || !exactContent(d.content,expected)) return null
      matched = d.id; matchTurn = turn
    }
  }
  return matches === 1 && closed ? matched : null
}
