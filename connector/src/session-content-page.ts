import type { AudioReference } from './session-audio-contract.js'
import { createHash } from 'node:crypto'

// Pure projection shared by both packages; cursors are positions, never authorization.
export const CONTENT_PAGE_MAX_BYTES = 128 * 1024
export const CONTENT_PAGE_MAX_ITEMS = 64
export const CONTENT_CHUNK_UNITS = 4096
export type ContentRole = 'user' | 'assistant' | 'tool'
export interface ContentImage {
  readonly attachmentId: string; readonly mediaType: string; readonly bytes: number
  readonly width: number; readonly height: number; readonly blockIndex: number
}
export interface ContentBlock {
  readonly index: number; readonly kind: 'text' | 'tool-call' | 'image' | 'reasoning' | 'audio' | 'media' | 'process'
  readonly text?: string; readonly image?: ContentImage; readonly audio?: AudioReference; readonly media?: AudioReference; readonly toolGroup?: string
  readonly processTurn?: number; readonly deliveryNotice?: boolean
}
export interface ContentMessage {
  readonly id: string; readonly role: ContentRole; readonly seq: number | null
  readonly operationId: string | null; readonly blocks: readonly ContentBlock[]
}
export interface ContentSource { readonly length: number; get(index: number): ContentMessage | null }
export interface ContentAnchor {
  readonly messageId: string; readonly blockIndex: number; readonly offset: number; readonly revision: string
}
export interface ContentPageRequest {
  readonly direction: 'before' | 'after'; readonly anchor: ContentAnchor | null; readonly limit: number
}
export interface ContentItem {
  readonly messageId: string; readonly role: ContentRole; readonly seq: number | null; readonly operationId: string | null
  readonly blockIndex: number; readonly kind: ContentBlock['kind']; readonly text: string | null; readonly image: ContentImage | null; readonly audio?: AudioReference | null
  readonly media?: AudioReference | null
  readonly processTurn?: number
  readonly offset: number; readonly end: number; readonly total: number; readonly revision: string; readonly toolGroup?: string
}
export interface ContentPage {
  readonly contract: `dshos-content-page-result-v${1 | 2 | 3 | 4 | 5}`; readonly items: readonly ContentItem[]
  readonly from: ContentAnchor | null; readonly start: ContentAnchor | null; readonly end: ContentAnchor | null; readonly hasBefore: boolean; readonly hasAfter: boolean
}
export class ContentPageStale extends Error { constructor() { super('content_anchor_changed') } }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join(',') === keys.sort().join(',')
export function isContentPageRequest(v: unknown): v is ContentPageRequest {
  if (!object(v) || !exact(v, ['direction','anchor','limit']) || !['before','after'].includes(String(v.direction))
    || !Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > CONTENT_PAGE_MAX_ITEMS) return false
  const a = v.anchor
  return a === null || object(a) && exact(a, ['messageId','blockIndex','offset','revision'])
    && typeof a.messageId === 'string' && a.messageId.length > 0 && a.messageId.length <= 256
    && Number.isSafeInteger(a.blockIndex) && Number(a.blockIndex) >= 0
    && Number.isSafeInteger(a.offset) && Number(a.offset) >= 0
    && typeof a.revision === 'string' && /^[0-9a-f]{64}$/.test(a.revision)
}
const splitSurrogate = (s: string, at: number) => at > 0 && at < s.length
  && s.charCodeAt(at - 1) >= 0xd800 && s.charCodeAt(at - 1) <= 0xdbff
  && s.charCodeAt(at) >= 0xdc00 && s.charCodeAt(at) <= 0xdfff
interface Position { message: number; block: number; offset: number }

/** No aggregate transcript copy/cache or total-history cap. Host owns its read-only surface. */
export function contentPage(source: ContentSource, scope: string, request: ContentPageRequest, version: 1 | 2 | 3 | 4 | 5 = 1): ContentPage {
  if (![1,2,3,4,5].includes(version) || !isContentPageRequest(request) || !Number.isSafeInteger(source.length) || source.length < 0) throw Error('content_request')
  // An already visible block remains a valid anchor for the complete export.
  const pageScope = version > 1 ? scope + '\0content-v' + Math.min(version,4) : scope
  let cachedIndex = -1, cached: ContentMessage | null = null
  const at = (index: number): ContentMessage | null => {
    if (cachedIndex !== index) { cachedIndex = index; cached = source.get(index) }
    if (cached?.blocks.some(block => block.kind === 'reasoning' && (version < 2 || cached!.role !== 'assistant'))) throw Error('content_kind')
    return cached
  }
  const length = (block: ContentBlock) => {
    if (block.kind === 'media') return block.media && version >= 4 ? 1 : 0
    if (block.kind === 'process') return block.processTurn && version === 5 ? 1 : 0
    if (block.kind === 'audio') return block.audio && version >= 3 ? 1 : 0
    if (block.kind === 'image') return block.image ? 1 : 0
    return block.text?.length ?? 0
  }
  let hashed: ContentBlock | null = null, hashedId = '', revision = ''
  const rev = (m: ContentMessage, b: ContentBlock): string => {
    if (b !== hashed || m.id !== hashedId) {
      revision = createHash('sha256').update(JSON.stringify([pageScope,m.id,m.role,m.seq,m.operationId,b.index,b.kind]))
        .update(version >= 3 && b.toolGroup ? '\0tool:' + b.toolGroup : '')
        .update('\0').update(JSON.stringify(b.media ?? b.audio ?? b.image ?? b.processTurn) ?? b.text ?? '', 'utf16le').digest('hex')
      hashed = b; hashedId = m.id
    }
    return revision
  }
  // Move from a gap to the nearest readable block; do not synthesize messages for private entries.
  const normalize = (p: Position, direction: 'before' | 'after'): Position | null => {
    const forward = direction === 'after'
    while (p.message >= 0 && p.message < source.length) {
      const m = at(p.message)
      if (m) {
        if (p.block === -1) p.block = forward ? 0 : m.blocks.length - 1
        while (p.block >= 0 && p.block < m.blocks.length) {
          const n = length(m.blocks[p.block])
          if (p.offset === -1) p.offset = forward ? 0 : n
          if (n > 0 && (forward ? p.offset < n : p.offset > 0)) return p
          p.block += forward ? 1 : -1; p.offset = -1
        }
      }
      p.message += forward ? 1 : -1; p.block = -1; p.offset = -1
    }
    return null
  }
  let position: Position | null = null
  if (request.anchor) {
    const a = request.anchor
    for (let i = 0; i < source.length; i++) {
      const m = at(i)
      if (m?.id !== a.messageId) continue
      const b = m.blocks.findIndex(v => v.index === a.blockIndex)
      if (b < 0 || rev(m,m.blocks[b]) !== a.revision || a.offset > length(m.blocks[b])
        || splitSurrogate(m.blocks[b].text ?? '',a.offset)) throw new ContentPageStale()
      position = {message:i,block:b,offset:a.offset}; break
    }
    if (!position) throw new ContentPageStale()
  } else position = {message:request.direction === 'after' ? 0 : source.length - 1,block:-1,offset:-1}
  const initialGap = {...position}
  position = normalize(position,request.direction)
  const items: ContentItem[] = []
  let first: Position | null = null, last: Position | null = null, bytes = 4096
  while (position && items.length < request.limit) {
    const m = at(position.message)!, b = m.blocks[position.block], total = length(b), forward = request.direction === 'after'
    let start = forward ? position.offset : Math.max(0,position.offset - CONTENT_CHUNK_UNITS)
    let end = forward ? Math.min(total,position.offset + CONTENT_CHUNK_UNITS) : position.offset
    const isText = b.kind === 'text' || b.kind === 'tool-call' || b.kind === 'reasoning'
    if (isText) {
      if (splitSurrogate(b.text!,start)) start--
      if (splitSurrogate(b.text!,end)) end--
    }
    const item: ContentItem = {messageId:m.id,role:m.role,seq:m.seq,operationId:m.operationId,blockIndex:b.index,kind:b.kind,
      text:isText ? b.text!.slice(start,end) : null,image:b.kind === 'image' ? {attachmentId:b.image!.attachmentId,mediaType:b.image!.mediaType,bytes:b.image!.bytes,width:b.image!.width,height:b.image!.height,blockIndex:b.index} : null,
      ...(version>=3?{audio:b.kind==='audio'?b.audio!:null}:{}),...(version>=4?{media:b.kind==='media'?b.media!:null}:{}),offset:start,end,total,revision:rev(m,b),
      ...(version===5 && b.kind==='process'?{processTurn:b.processTurn!}:{}),
      ...(version>=3 && b.toolGroup?{toolGroup:b.toolGroup}:{})}
    const size = Buffer.byteLength(JSON.stringify(item)) + 1
    if (bytes + size > CONTENT_PAGE_MAX_BYTES) break
    bytes += size
    const lo = {message:position.message,block:position.block,offset:start}, hi = {...lo,offset:end}
    if (forward) { items.push(item); first ??= lo; last = hi } else { items.unshift(item); first = lo; last ??= hi }
    position = normalize({...forward ? hi : lo},request.direction)
  }
  const anchor = (i: ContentItem,offset: number): ContentAnchor => ({messageId:i.messageId,blockIndex:i.blockIndex,offset,revision:i.revision})
  const page: ContentPage = {contract:`dshos-content-page-result-v${version}`,items,from:request.anchor,
    start:items.length ? anchor(items[0],items[0].offset) : request.anchor,
    end:items.length ? anchor(items[items.length-1],items[items.length-1].end) : request.anchor,
    hasBefore:normalize({...first ?? initialGap},'before') !== null,
    hasAfter:normalize({...last ?? initialGap},'after') !== null}
  if (Buffer.byteLength(JSON.stringify(page)) > CONTENT_PAGE_MAX_BYTES) throw Error('content_capacity')
  return page
}
