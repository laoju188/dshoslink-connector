import {execFile} from 'node:child_process'
import {join} from 'node:path'
import {isIPv4} from 'node:net'
import {validWindowsLanDiagnostic,type WindowsLanDiagnostic} from './windows-lan-diagnostic-contract.js'

export interface WindowsLanTarget {host:string;port:number;pid:number;program:string}
export const WINDOWS_LAN_QUERY=String.raw`
$ErrorActionPreference='Stop'
$targetPort=[int]$env:DSHOS_DIAG_PORT
$targetPid=[int]$env:DSHOS_DIAG_PID
$targetHost=$env:DSHOS_DIAG_HOST
$targetProgram=$env:DSHOS_DIAG_PROGRAM
$result=[ordered]@{version=1;checkedAtMs=0;check='unavailable';checkStage='listener';listener='unknown';profile='unknown';firewall='unknown';inboundPolicy='unknown';matchingBlockRules=0;matchingAllowRules=0}
function Snapshot($stage){$result.checkStage=$stage;$result|ConvertTo-Json -Compress}
function PortMatches($ports) {
 foreach($p in @($ports)) {
  if([string]$p -eq 'Any' -or [string]$p -eq [string]$targetPort){return $true}
  if([string]$p -match '^(\d+)-(\d+)$' -and $targetPort -ge [int]$Matches[1] -and $targetPort -le [int]$Matches[2]){return $true}
 }
 return $false
}
Snapshot 'listener'
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
 $_.LocalPort -eq $targetPort -and $_.LocalAddress -in @($targetHost,'0.0.0.0','::')})
$listener=if(@($listeners|Where-Object {$_.OwningProcess -eq $targetPid}).Count -gt 0){'owned'}elseif($listeners.Count -gt 0){'other'}else{'missing'}
$result.listener=$listener;Snapshot 'network'
$interfaces=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {$_.IPAddress -eq $targetHost} | Select-Object -ExpandProperty InterfaceIndex -Unique)
$profiles=@(Get-NetConnectionProfile -ErrorAction Stop | Where-Object {$_.InterfaceIndex -in $interfaces} | ForEach-Object {
 switch([string]$_.NetworkCategory){'Private'{'Private'} 'Public'{'Public'} 'DomainAuthenticated'{'Domain'}}} | Select-Object -Unique)
$profile=if($profiles.Count -eq 1){$profiles[0].ToLowerInvariant()}elseif($profiles.Count -gt 1){'multiple'}else{'unknown'}
$result.profile=$profile;Snapshot 'firewall_policy'
$mask=0;foreach($p in $profiles){switch($p){'Domain'{$mask=$mask -bor 1} 'Private'{$mask=$mask -bor 2} 'Public'{$mask=$mask -bor 4}}}
$policies=@(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {$_.Name -in $profiles})
$firewall='unknown';$policy='unknown'
if($policies.Count -gt 0 -and $policies.Count -eq $profiles.Count){
 if(@($policies|Where-Object {[string]$_.Enabled -ne 'True'}).Count -eq 0){$firewall='enabled'}
 elseif(@($policies|Where-Object {[string]$_.Enabled -ne 'False'}).Count -eq 0){$firewall='disabled'}else{$firewall='mixed'}
 # Ignoring inbound rules uses the default action; only False + Block is shields-up.
 if(@($policies|Where-Object {[string]$_.AllowInboundRules -ne 'False' -or [string]$_.DefaultInboundAction -ne 'Block'}).Count -eq 0){$policy='block_all'}
 elseif(@($policies|Where-Object {[string]$_.DefaultInboundAction -ne 'Block'}).Count -eq 0){$policy='default_block'}
 elseif(@($policies|Where-Object {[string]$_.DefaultInboundAction -ne 'Allow'}).Count -eq 0){$policy='allow'}
}
# Effective store, exact current executable, TCP/Any and current local port.
# Other rule filters are deliberately NOT reduced to a claim of actual blocking.
$result.firewall=$firewall;$result.inboundPolicy=$policy;Snapshot 'firewall_rules'
$blocks=0;$allows=0
$filters=@(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {
 [Environment]::ExpandEnvironmentVariables([string]$_.Program) -ieq $targetProgram})
if($filters.Count -gt 1000){throw 'bounded_query'}
foreach($filter in $filters){
 foreach($rule in @(Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $filter -PolicyStore ActiveStore -ErrorAction Stop)){
  if([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or $mask -eq 0){continue}
  if([string]$rule.Profile -ne 'Any' -and (([int]$rule.Profile -band $mask) -eq 0)){continue}
  foreach($portFilter in @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -PolicyStore ActiveStore -ErrorAction Stop)){
   if([string]$portFilter.Protocol -notin @('TCP','6','Any','256') -or -not (PortMatches $portFilter.LocalPort)){continue}
   if([string]$rule.Action -eq 'Block'){$blocks++}elseif([string]$rule.Action -eq 'Allow'){$allows++}
  }
 }
}
if($blocks -gt 1000 -or $allows -gt 1000){throw 'bounded_query'}
$result.check='complete';$result.matchingBlockRules=$blocks;$result.matchingAllowRules=$allows;Snapshot 'done'
`
export function unknownWindowsLan(check:WindowsLanDiagnostic['check'],now:number):WindowsLanDiagnostic {
  return {version:1,checkedAtMs:now,check,checkStage:'none',listener:'unknown',profile:'unknown',firewall:'unknown',inboundPolicy:'unknown',matchingBlockRules:0,matchingAllowRules:0}
}
function validTarget(t:WindowsLanTarget):boolean {
  return isIPv4(t.host)&&/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(t.host)&&
    Number.isSafeInteger(t.port)&&t.port>0&&t.port<=65535&&Number.isSafeInteger(t.pid)&&t.pid>0&&
    /^[A-Za-z]:[\\/]/.test(t.program)&&t.program.length<=2048&&!/[\x00-\x1f]/.test(t.program)
}
export async function queryWindowsLan(target:WindowsLanTarget):Promise<string> {
  if(!validTarget(target))throw Error('invalid_local_target')
  return new Promise((resolve,reject)=>execFile(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_LAN_QUERY,'utf16le').toString('base64')],
    {windowsHide:true,timeout:8000,maxBuffer:8192,encoding:'utf8',env:{...process.env,DSHOS_DIAG_HOST:target.host,
      DSHOS_DIAG_PORT:String(target.port),DSHOS_DIAG_PID:String(target.pid),DSHOS_DIAG_PROGRAM:target.program}},
    (error,stdout)=>error?reject({killed:error.killed,code:error.code,partial:stdout}):resolve(stdout)))
}
function parseLast(text:unknown):WindowsLanDiagnostic|null {
  if(typeof text!=='string'||text.length>8192)return null
  const line=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/).at(-1)
  try{const v:unknown=JSON.parse(line??'');return validWindowsLanDiagnostic(v)?v:null}catch{return null}
}
/** Coalesced, bounded, read-only check. Call only for an explicit feedback send;
 * it never delays pairing, opens a port, changes a profile or prompts for admin. */
export class WindowsLanInspector {
  private pending:Promise<WindowsLanDiagnostic>|undefined
  private cached:{key:string;value:WindowsLanDiagnostic}|undefined
  constructor(private readonly target:()=>WindowsLanTarget|undefined,private readonly query=queryWindowsLan,
    private readonly now=Date.now,private readonly platform=process.platform){}
  async collect():Promise<WindowsLanDiagnostic> {
    if(this.platform!=='win32')return unknownWindowsLan('unsupported',this.now())
    const t=this.target()
    if(!t||!validTarget(t))return unknownWindowsLan('no_runtime',this.now())
    const key=JSON.stringify(t)
    if(this.pending){await this.pending;return this.collect()}
    if(this.cached?.key===key&&this.now()>=this.cached.value.checkedAtMs&&this.now()-this.cached.value.checkedAtMs<30000)return {...this.cached.value}
    const work=(async()=>{
      let value:WindowsLanDiagnostic
      try {
        const text=await this.query(t)
        const parsed=parseLast(text)
        if(!parsed||parsed.check!=='complete')throw Error('invalid_local_result')
        value={...parsed,checkedAtMs:this.now()}
      }catch(error){const e=error as {killed?:boolean;code?:unknown;partial?:unknown}|null
        const check=e?.killed||e?.code==='ETIMEDOUT'?'timeout':'unavailable'
        const partial=parseLast(e?.partial)
        value=partial&&partial.checkStage!=='done'?{...partial,check,checkedAtMs:this.now()}:unknownWindowsLan(check,this.now())}
      if(JSON.stringify(this.target())!==key)return unknownWindowsLan('no_runtime',this.now())
      this.cached={key,value};return {...value}
    })()
    this.pending=work
    try{return await work}finally{if(this.pending===work)this.pending=undefined}
  }
}
