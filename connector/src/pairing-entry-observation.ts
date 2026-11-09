/** Fixed, bounded facts from the desktop page. Never accept input text or codes. */
export const ENTRY_BLOCK_REASONS=['none','preparing','read_failed','no_network','paused','startup_failed','service_unavailable'] as const
export const ENTRY_EVENTS=['visible','input','valid','click',...ENTRY_BLOCK_REASONS.map(reason=>`blocked:${reason}`)] as const
export type EntryBlockReason=typeof ENTRY_BLOCK_REASONS[number]
export type EntryEvent='visible'|'input'|'valid'|'click'|`blocked:${EntryBlockReason}`
export interface PairingEntryObservation {
  visible:boolean;inputStarted:boolean;inputValid:boolean;submitClicked:boolean;blockedReason:EntryBlockReason
}
export const emptyEntry=():PairingEntryObservation=>({visible:false,inputStarted:false,inputValid:false,submitClicked:false,blockedReason:'none'})
export function validEntryEvent(event:unknown):event is EntryEvent{return typeof event==='string'&&ENTRY_EVENTS.includes(event)}
export function validEntry(value:unknown):value is PairingEntryObservation {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='blockedReason,inputStarted,inputValid,submitClicked,visible')return false
  const v=value as PairingEntryObservation
  return [v.visible,v.inputStarted,v.inputValid,v.submitClicked].every(x=>typeof x==='boolean')&&ENTRY_BLOCK_REASONS.includes(v.blockedReason)
    &&(!v.inputStarted||v.visible)&&(!v.inputValid||v.inputStarted)&&(!v.submitClicked||v.inputValid)
}
export function observeEntryEvent(value:PairingEntryObservation,event:EntryEvent):boolean {
  if(!validEntryEvent(event))return false
  const before=JSON.stringify(value)
  if(event==='visible')value.visible=true
  else if(event==='input'&&value.visible)value.inputStarted=true
  else if(event==='valid'&&value.inputStarted)value.inputValid=true
  else if(event==='click'&&value.inputValid)value.submitClicked=true
  else if(event.startsWith('blocked:'))value.blockedReason=event.slice(8) as EntryBlockReason
  return JSON.stringify(value)!==before
}
