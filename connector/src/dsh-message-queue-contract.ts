import { readQueueContentReference } from './session-message-content.js'
import { registrationBytes as encode, registrationFields as fields, registrationId as id,
  registrationJson, registrationTranscript } from './dsh-registration-contract.js'
export const DSH_QUEUE_REVISION = 'message-queue-r1'
export const DSH_QUEUE_CONTENT_REVISION = 'message-queue-r2'
export const dshQueueRevision = (v: unknown): v is string => v === DSH_QUEUE_REVISION || v === DSH_QUEUE_CONTENT_REVISION
export const DSH_QUEUE_PREFIX = 'dshos-dsh-message-queue-'
export const DSH_QUEUE_PATH = '/dshos/v1/message-queue'
export const DSH_QUEUE_ACTIONS = ['enqueue', 'stop', 'resume', 'edit', 'remove', 'reorder', 'dismiss'] as const
export type DshQueueAction = typeof DSH_QUEUE_ACTIONS[number]
export interface DshQueueTarget {
  contract: 'dshos-target-scope-v2'; platform: 'dsh'; computerId: string; memberId: string; pairingId: string
  instanceId: string; enableEpoch: string; sessionId: string
}
export const dshQueueSessionId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(v) && Buffer.from(v).toString() === v
export function dshQueueTarget(v: unknown): v is DshQueueTarget {
  return fields(v, ['contract', 'platform', 'computerId', 'memberId', 'pairingId', 'instanceId', 'enableEpoch', 'sessionId'])
    && v.contract === 'dshos-target-scope-v2' && v.platform === 'dsh'
    && ['computerId', 'memberId', 'pairingId', 'instanceId', 'enableEpoch'].every(k => id(v[k])) && dshQueueSessionId(v.sessionId)
}
export interface DshQueueTicket {
  contract: string; revision: string; accountBindingId: string; keyGeneration: string; target: DshQueueTarget
  queueScope: string; capabilityDigest: string; operationId: string; nonce: string; action: DshQueueAction
  subjectId: string | null; runId: string | null; expectedRevision: number | null; bodyDigest: string; issuedAt: number; expiresAt: number
}
const moment = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER - 86400000
export function dshQueueTicket(bytes: Uint8Array): DshQueueTicket {
  const v = registrationJson(bytes, 8192)
  if (!fields(v, ['contract','revision','accountBindingId','keyGeneration','target','queueScope','capabilityDigest','operationId','nonce','action','subjectId','runId','expectedRevision','bodyDigest','issuedAt','expiresAt'])
    || v.contract !== DSH_QUEUE_PREFIX + 'ticket-v2' || !dshQueueRevision(v.revision) || !dshQueueTarget(v.target)
    || !['accountBindingId','keyGeneration','operationId','nonce'].every(k => id(v[k]))
    || !['queueScope','capabilityDigest','bodyDigest'].every(k => id(v[k], 32)) || !DSH_QUEUE_ACTIONS.includes(v.action as DshQueueAction)
    || !moment(v.issuedAt) || !moment(v.expiresAt) || v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > 30000
    || (['edit','remove','dismiss'].includes(v.action as string) ? !id(v.subjectId) : v.subjectId !== null)
    || (v.action === 'stop' ? v.runId !== null && !id(v.runId) : v.runId !== null)
    || (['enqueue','stop'].includes(v.action as string) ? v.expectedRevision !== null : !Number.isSafeInteger(v.expectedRevision)
      || (v.expectedRevision as number) < 1 || (v.expectedRevision as number) >= Number.MAX_SAFE_INTEGER)) throw Error('queue_ticket')
  Object.freeze(v.target)
  return Object.freeze(v) as unknown as DshQueueTicket
}
export function dshQueueBody(action: DshQueueAction, body: unknown, revision: string = DSH_QUEUE_REVISION): Record<string, unknown> {
  if(!dshQueueRevision(revision))throw Error('queue_revision_required')
  if (action === 'enqueue' || action === 'edit') {
    if(revision===DSH_QUEUE_CONTENT_REVISION&&fields(body,['content'])){
      const normalized={content:readQueueContentReference(body.content)}
      if(!encode(body).equals(encode(normalized)))throw Error('queue_content_body')
      return normalized
    }
    if (!fields(body, ['text']) || typeof body.text !== 'string' || !body.text.trim() || body.text.includes('\0')
      || [...body.text].length > 4000 || encode(body).length > 16384 || Buffer.from(body.text).toString() !== body.text) throw Error('queue_text')
  } else if (action === 'dismiss') {
    if (!fields(body, ['acknowledgeUnconfirmed']) || body.acknowledgeUnconfirmed !== true) throw Error('queue_disposition')
  } else if (action === 'reorder') {
    if (!fields(body, ['ids']) || !Array.isArray(body.ids) || body.ids.length > 16 || body.ids.some(v => !id(v))
      || new Set(body.ids).size !== body.ids.length) throw Error('queue_order')
  } else if (!fields(body, [])) throw Error('queue_body')
  return body as Record<string, unknown>
}
export function dshQueueTranscript(kind: 'capability' | 'ticket' | 'receipt' | 'snapshot' | 'resolution' | 'content', value: unknown): Buffer {
  if (encode(value).length > 32768) throw Error('queue_capacity')
  return registrationTranscript('DSH-MESSAGE-QUEUE-' + kind.toUpperCase(), value)
}
