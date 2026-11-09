/** Local observations only. A rule candidate is not a captured dropped packet.
 * No executable paths, addresses, rule names, account names or packet data. */
export interface WindowsLanDiagnostic {
  version: 1
  checkedAtMs: number
  check: 'complete'|'unavailable'|'timeout'|'unsupported'|'no_runtime'
  checkStage: 'none'|'listener'|'network'|'firewall_policy'|'firewall_rules'|'done'
  listener: 'owned'|'missing'|'other'|'unknown'
  profile: 'private'|'public'|'domain'|'multiple'|'unknown'
  firewall: 'enabled'|'disabled'|'mixed'|'unknown'
  inboundPolicy: 'block_all'|'default_block'|'allow'|'unknown'
  matchingBlockRules: number
  matchingAllowRules: number
}
const fields=['version','checkedAtMs','check','checkStage','listener','profile','firewall','inboundPolicy','matchingBlockRules','matchingAllowRules']
export function validWindowsLanDiagnostic(v:unknown):v is WindowsLanDiagnostic {
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==[...fields].sort().join(','))return false
  const d=v as WindowsLanDiagnostic
  if(d.version!==1||!Number.isSafeInteger(d.checkedAtMs)||d.checkedAtMs<0||
    !['complete','unavailable','timeout','unsupported','no_runtime'].includes(d.check)||
    !['none','listener','network','firewall_policy','firewall_rules','done'].includes(d.checkStage)||
    !['owned','missing','other','unknown'].includes(d.listener)||
    !['private','public','domain','multiple','unknown'].includes(d.profile)||
    !['enabled','disabled','mixed','unknown'].includes(d.firewall)||
    !['block_all','default_block','allow','unknown'].includes(d.inboundPolicy)||
    !Number.isSafeInteger(d.matchingBlockRules)||d.matchingBlockRules<0||d.matchingBlockRules>1000||
    !Number.isSafeInteger(d.matchingAllowRules)||d.matchingAllowRules<0||d.matchingAllowRules>1000)return false
  if(d.check==='complete')return d.checkStage==='done'
  if(d.checkStage==='done')return false
  return !['unsupported','no_runtime'].includes(d.check)&&d.checkStage!=='none'||
    d.checkStage==='none'&&d.listener==='unknown'&&d.profile==='unknown'&&d.firewall==='unknown'&&
    d.inboundPolicy==='unknown'&&d.matchingBlockRules===0&&d.matchingAllowRules===0
}
export function windowsLanSummary(d:WindowsLanDiagnostic|undefined){
  if(!d)return {observation:'旧报告没有 Windows 局域网环境检查，不能推断防火墙状态。',coverage:'not_collected'}
  if(!validWindowsLanDiagnostic(d))throw Error('invalid_windows_lan_diagnostic')
  const stages={none:'准备检查',listener:'读取实际监听',network:'读取当前网络类型',firewall_policy:'读取有效防火墙策略',firewall_rules:'核对当前程序入站规则',done:'检查完成'}
  const observation=d.check!=='complete'?`本次 Windows 检查停在“${stages[d.checkStage]}”，${d.check==='timeout'?'读取超时':'未能完成读取'}；保留已读取的字段，未读取部分仍未知。`:
    d.listener==='missing'?'检查时未发现当前连接端口在监听。':d.listener==='other'?'检查时连接端口由另一个进程监听。':
    d.firewall==='enabled'&&d.inboundPolicy==='block_all'?'当前网络设置了“阻止全部入站连接”，普通应用允许规则也不会生效。':
    d.matchingBlockRules>0?'发现匹配当前程序、TCP端口和网络类型的入站阻止规则；还需核对规则的地址等限制。':
    d.firewall==='enabled'&&d.inboundPolicy==='default_block'&&d.matchingAllowRules===0?
      '当前网络默认阻止入站，未找到匹配当前 DSH 程序和端口的应用允许规则；这仍需结合手机连接核对。':
    '未发现上述程序规则阻止线索；不等于已排除防火墙、路由器隔离或第三方安全软件。'
  return {...d,observation,evidence:'本次本机只读检查。规则计数不代表实际丢包证据，不改变配对或首次认证结论。',
    nextInvestigation:d.check!=='complete'?'核对检查是否超时或缺少读取权限。':
      d.listener!=='owned'?'先核对实际宿主与监听状态。':
      d.firewall==='enabled'&&d.inboundPolicy==='block_all'?'保留配对。请由本人或管理员核对“阻止全部入站”设置；不要关闭整个防火墙或绕过单位策略。':
      d.matchingBlockRules>0?'保留配对，请核对阻止规则；新加允许规则不能覆盖明确的阻止规则。':
      d.firewall==='enabled'&&d.inboundPolicy==='default_block'&&d.matchingAllowRules===0?
        '保留配对。请核对当前 DSH 程序的应用允许规则及可信网络范围；升级后程序路径可能已变化。':
      '结合手机同次连接错误核对网络可达性，不能仅凭无请求到达认定防火墙拦截。'}
}
