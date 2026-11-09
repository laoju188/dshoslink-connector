import type { ConnectionEvent, ConnectionSnapshot } from './pairing-support-contract.js'

const stages: Record<ConnectionEvent['stage'], string> = {
  relay_binding: '核对原配对', relay_ticket: '领取跨网连接凭证', relay_key: '读取跨网安全资料',
  relay_socket: '连接中继服务', relay_peer: '等待手机接入', relay_handshake: '验证加密连接', relay_session: '跨网通信',
  relay_notify: '电脑连接待命', relay_notify_delivery: '接收手机连接通知',
  notification: '发送重要通知', access: '手机访问开关', startup: '启动手机连接',
  pairing_state_refresh: '刷新电脑配对页面',
}
const results: Record<ConnectionEvent['result'], string> = {
  ok: '已完成', waiting: '等待手机发起连接', unavailable: '暂不可用', unauthorized: '授权已失效',
  rate_limited: '请求较多，稍后自动重试', failed: '未完成', closed: '连接已结束',
  retry_exhausted: '本次重试已结束', expired: '已超过通知有效期', paused: '已由电脑暂停', timeout: '读取配对安全资料超时',
  not_required: '尚无跨网连接凭据', replaced: '已由另一个电脑进程接替', legacy: '使用已确认的旧服务待命方式',
}
const causes:Record<string,string>={dns:'域名解析失败',connection_refused:'连接被拒绝',connection_reset:'连接被中断',network_unreachable:'网络不可达',timeout:'连接请求超时',tls_certificate:'服务证书校验失败',tls_protocol:'安全连接协商失败',cancelled:'本端已取消',unknown:'具体原因未记录',heartbeat_lost:'待命通道未按时响应',protocol_invalid:'待命消息格式不符',peer_closed:'对端连接已关闭',server_busy:'服务要求稍后重试',credential_missing:'尚未取得待命凭据',identity_changed:'本机身份已变化',host_stopped:'本机连接实例已停止',authorization_rejected:'授权已被拒绝',service_restricted:'服务暂时受限',replaced:'另一个电脑实例已接替'}
const recoveries:Record<string,string>={connecting:'正在连接',ready:'待命已就绪',retry_scheduled:'已安排自动重试',wait_identity:'等待凭据或身份恢复',wait_policy:'等待服务限制解除',stopped:'本实例不再重试'}
export function connectionEventText(event: ConnectionEvent): string {
  if(event.result==='timeout'&&event.stage==='relay_peer')return `${stages[event.stage]}：手机未在等待期限内接入`
  if(event.result==='timeout'&&event.stage==='relay_handshake')return `${stages[event.stage]}：加密握手未在期限内完成`
  if(event.stage==='relay_notify'&&event.detail)return `${stages[event.stage]}：${results[event.result]}；${causes[event.detail.cause]}；${recoveries[event.detail.recovery]}${event.detail.retryInMs===undefined?'':`，约${Math.ceil(event.detail.retryInMs/1000)}秒后`}`
  if(event.stage==='relay_notify')return `${stages[event.stage]}：${event.result==='ok'?'已就绪':event.result==='timeout'?'通知连接失去响应':results[event.result]}`
  if(event.stage==='pairing_state_refresh')return `${stages[event.stage]}：${event.result==='waiting'?'正在核对解除后的配对状态':event.result==='closed'?'页面已离开，本次核对已停止':results[event.result]}`
  return `${stages[event.stage]}：${results[event.result]}`
}
export function connectionSummary(snapshot: ConnectionSnapshot | undefined) {
  if (!snapshot) return null
  const describe = (event: ConnectionEvent | null) => event && ({ ...event, description: connectionEventText(event) })
  return {
    recentSteps: snapshot.events.map(event => describe(event)!),
    firstRecordedFailure: describe(snapshot.firstFailure),
    lastRecordedFailure: describe(snapshot.lastFailure),
    evidence: '本次桌面运行期间的连接与通知记录；不等于本次配对码操作的步骤，也不代表记录的问题目前仍存在。',
  }
}
