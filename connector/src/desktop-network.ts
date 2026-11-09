import { execFile } from 'node:child_process'
import { isIPv4 } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import type { NetworkDiscoveryDiagnostic } from './pairing-support-contract.js'

let lastDiscovery: NetworkDiscoveryDiagnostic | undefined
export function desktopNetworkDiscoveryDiagnostic(): NetworkDiscoveryDiagnostic | undefined {
  return lastDiscovery ? { ...lastDiscovery, ...(lastDiscovery.detail ? { detail: { ...lastDiscovery.detail,
    ...(lastDiscovery.detail.counts ? { counts: { ...lastDiscovery.detail.counts } } : {}),
    ...(lastDiscovery.detail.addressClasses ? { addressClasses: {...lastDiscovery.detail.addressClasses} } : {}) } } : {}) } : undefined
}

function privateIpv4(value: unknown): value is string {
  if (typeof value !== 'string' || !isIPv4(value)) return false
  const [a, b] = value.split('.').map(Number)
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
}

// PowerShell reports only active hardware adapters. Cross-check its addresses
// against Node's current interfaces; never choose a VPN/virtual adapter by name.
export function selectDesktopLanHost(text: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | undefined {
  const hosts=selectDesktopLanHosts(text,interfaces)
  if(hosts.length<2)return hosts[0]
  const gateways=new Set((networkRows(text) ?? [])
    .filter(row=>row.gateway&&hosts.includes(row.address)).map(row=>row.address))
  return gateways.size===1?[...gateways][0]:undefined
}

export function validateDesktopLanHosts(hosts: readonly string[]): readonly string[] {
  if (!Array.isArray(hosts) || hosts.length > 3 || hosts.some(host => !privateIpv4(host))
    || new Set(hosts).size !== hosts.length) throw Error('desktop_lan_candidates_invalid')
  return Object.freeze([...hosts])
}

interface NetworkQuery {
  rows: { address: string; gateway: boolean }[]
  reportedAdapters?: number
  upAdapters?: number
  hardwareAdapters?: number
}
function networkQuery(text: string): NetworkQuery | undefined {
  if (text.length > 32768) return undefined
  let rows: unknown
  try { rows = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { return undefined }
  let counts: Pick<NetworkQuery, 'reportedAdapters'|'upAdapters'|'hardwareAdapters'> = {}
  if (rows !== null && typeof rows === 'object' && !Array.isArray(rows)) {
    const value = rows as Record<string, unknown>
    if (Object.keys(value).sort().join(',') !== 'hardwareAdapters,reportedAdapters,rows,upAdapters') return undefined
    const { reportedAdapters, upAdapters, hardwareAdapters } = value
    if (![reportedAdapters, upAdapters, hardwareAdapters].every(v => Number.isSafeInteger(v) && (v as number)>=0 && (v as number)<=256)
      || (hardwareAdapters as number)>(upAdapters as number) || (upAdapters as number)>(reportedAdapters as number)) return undefined
    counts = { reportedAdapters: reportedAdapters as number, upAdapters: upAdapters as number, hardwareAdapters: hardwareAdapters as number }
    rows = value.rows
  }
  if (!Array.isArray(rows) || rows.length > 64 || counts.hardwareAdapters===0 && rows.length>0) return undefined
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'address,gateway'
      || typeof row.address !== 'string' || !isIPv4(row.address) || typeof row.gateway !== 'boolean') return undefined
  }
  return { rows, ...counts }
}
function networkRows(text: string): NetworkQuery['rows'] | undefined { return networkQuery(text)?.rows }

/** Only categories and bounded counts leave this process. Do not broaden listeners. */
export function desktopAddressClasses(rows:readonly {address:string}[],interfaces:NodeJS.Dict<NetworkInterfaceInfo[]>) {
  const result={private:0,shared:0,linkLocal:0,otherIpv4:0,nodeIpv6:0}
  for(const {address} of rows){
    if(!isIPv4(address))continue
    const [a,b]=address.split('.').map(Number)
    if(privateIpv4(address))result.private++
    else if(a===100&&b>=64&&b<=127)result.shared++
    else if(a===169&&b===254)result.linkLocal++
    else result.otherIpv4++
  }
  result.nodeIpv6=Math.min(256,Object.values(interfaces).flatMap(items=>items??[]).filter(item=>!item.internal&&item.family==='IPv6').length)
  return result
}


export function selectDesktopLanHosts(text: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): readonly string[] {
  const rows = networkRows(text)
  if (!rows) return []
  const local = new Set(Object.values(interfaces).flatMap(items => items ?? [])
    .filter(item => !item.internal && item.family === 'IPv4' && privateIpv4(item.address)).map(item => item.address))
  const physical = new Set<string>(), gateways = new Set<string>()
  for (const row of rows) {
    if (!privateIpv4(row.address) || !local.has(row.address)) continue
    physical.add(row.address)
    if (row.gateway) gateways.add(row.address)
  }
  // A default gateway orders candidates; it does not prove phone reachability.
  // Keep physical intranet adapters without gateways and use deterministic order.
  return Object.freeze([...physical].sort((a,b) => Number(gateways.has(b))-Number(gateways.has(a))
    || a.localeCompare(b,'en',{numeric:true})).slice(0,3))
}

// Keep the same Get-NetIPConfiguration scope and selection. Counts describe its
// returned configurations, NOT all installed/disconnected/virtual adapters.
const NETWORK_QUERY = "$ErrorActionPreference='Stop'; try { $configs=@(Get-NetIPConfiguration); $up=@($configs | Where-Object { $_.NetAdapter.Status -eq 'Up' }); $hardware=@($up | Where-Object { $_.NetAdapter.HardwareInterface }); $items=@($hardware | ForEach-Object { $gateway=($null -ne $_.IPv4DefaultGateway); foreach($address in $_.IPv4Address) { [pscustomobject]@{address=[string]$address.IPAddress;gateway=$gateway} } }); [pscustomobject]@{rows=$items;reportedAdapters=$configs.Count;upAdapters=$up.Count;hardwareAdapters=$hardware.Count} | ConvertTo-Json -Depth 4 -Compress } catch { $reason='query_failed'; if ($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [System.UnauthorizedAccessException]) { $reason='query_access_denied' } elseif ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { $reason='query_unavailable' }; [pscustomobject]@{failure=$reason} | ConvertTo-Json -Compress }"

export function currentLanAddressState(host: string): 'current' | 'changed' | 'unknown' {
  try {
    return Object.values(networkInterfaces()).flatMap(items=>items??[])
      .some(item=>!item.internal&&item.family==='IPv4'&&item.address===host)?'current':'changed'
  } catch { return 'unknown' }
}

export function desktopLanInterfaceSnapshot(): string {
  return JSON.stringify(Object.values(networkInterfaces()).flatMap(items=>items??[])
    .filter(item=>!item.internal&&item.family==='IPv4'&&privateIpv4(item.address))
    .map(item=>item.address).sort())
}

export async function readDesktopLanHost(): Promise<string | undefined> {
  return (await readDesktopLanHosts())?.[0]
}

export async function readDesktopLanHosts(): Promise<readonly string[] | undefined> {
  if (process.platform !== 'win32') return undefined
  const record = (result: NetworkDiscoveryDiagnostic['result'], candidateCount = 0, detail?: NetworkDiscoveryDiagnostic['detail']): void => {
    lastDiscovery = { result, candidateCount, checkedAtMs: Date.now(), ...(detail ? { detail } : {}) }
  }
  try {
    // The host may inherit PowerShell 7 or custom module paths. NetTCPIP must
    // come from Windows PowerShell, as do the existing identity operations.
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
    env.PSModulePath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    const text = await new Promise<string>((resolve, reject) => {
      execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', NETWORK_QUERY],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 32768, env },
        (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    // Failed/malformed queries do not establish that the old network vanished.
    let failure: unknown
    try { failure = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { }
    if (failure!==null && typeof failure==='object' && !Array.isArray(failure)
      && Object.keys(failure).join(',')==='failure' && ['query_failed','query_access_denied','query_unavailable'].includes((failure as {failure:string}).failure)) {
      record('query_failed',0,{reason:(failure as {failure:'query_failed'|'query_access_denied'|'query_unavailable'}).failure});return undefined
    }
    const query = networkQuery(text)
    if (!query) { record('invalid_result',0,{reason:'invalid_result'}); return undefined }
    let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
    try { interfaces=networkInterfaces() } catch { record('query_failed',0,{reason:'interface_snapshot_failed'});return undefined }
    const hosts = selectDesktopLanHosts(text, interfaces)
    const privateCount = query.rows.filter(row=>privateIpv4(row.address)).length
    const reason: NonNullable<NetworkDiscoveryDiagnostic['detail']>['reason'] = hosts.length ? 'candidates_ready'
      : query.reportedAdapters===0 ? 'no_connected_config' : query.upAdapters===0 ? 'no_active_adapter'
      : query.hardwareAdapters===0 ? 'no_active_hardware' : query.rows.length===0 ? 'no_ipv4'
      : privateCount===0 ? 'no_private_ipv4' : 'address_snapshot_mismatch'
    const counts = query.reportedAdapters!==undefined ? { reportedAdapters:query.reportedAdapters,upAdapters:query.upAdapters!,
      hardwareAdapters:query.hardwareAdapters!,ipv4:query.rows.length,privateIpv4:privateCount } : undefined
    // Legacy row-only fixtures have no adapter evidence, so do not invent a
    // no-IPv4 cause when their filtered result is empty.
    record(hosts.length ? 'ready' : 'no_private_address', hosts.length,
      query.rows.length===0 && !counts ? undefined : {reason,...(counts?{counts}:{}),addressClasses:desktopAddressClasses(query.rows,interfaces)})
    return hosts
  } catch (error) {
    const failure=error as { killed?: boolean; code?: unknown } | null
    const result=failure?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'invalid_result'
      : failure?.killed || failure?.code==='ETIMEDOUT' ? 'timeout' : 'query_failed'
    record(result,0,{reason:result==='invalid_result'?'invalid_result':result==='timeout'?'query_timeout'
      : ['EACCES','EPERM'].includes(String(failure?.code))?'query_access_denied':failure?.code==='ENOENT'?'query_unavailable':'query_failed'})
    return undefined
  }
}
