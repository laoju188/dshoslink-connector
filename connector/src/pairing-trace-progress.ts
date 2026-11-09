// Mirrored in the service. Interpretation only; never grants pairing authority.
import type { TraceObservationBody } from './pairing-trace-contract.js'

const stages: Record<string,string> = {
  none:'尚无成功步骤',startup:'连接器启动',preparation:'生成二维码',qr_display:'显示二维码',
  preparation_lock:'取得本机配对操作权限',preparation_recovery:'恢复或核对旧配对',preparation_read:'读取已保存的配对资料',
  preparation_check:'检查本机配对资料一致性',preparation_directory:'准备配对资料目录',preparation_save:'保存配对身份',
  preparation_service:'获取服务器配对配置',preparation_invitation:'生成并保存本次二维码',preparation_release:'结束本机配对准备',
  bootstrap:'读取电脑证书',secure_channel:'建立安全连接',desktop_check:'核对桌面版本',
  request_validation:'检查手机请求',phone_start:'接受手机请求',computer_confirmation:'电脑确认验证码',
  phone_confirmation:'手机确认',registration:'登记配对',activation:'启用连接',authentication:'验证连接身份',
}
const endings: Record<string,string> = {open:'尚在进行',cancelled:'电脑配对窗口已取消',replaced:'已被新一轮配对替换',
  expired:'邀请有效期已结束',interrupted:'配对过程被中断',connected:'已完成连接',failed:'准备配对时失败',not_started:'尚未开始配对'}
const causes:Record<string,string>={none:'无',unknown:'尚未确定',address_changed:'电脑局域网地址已改变',protection_failed:'Windows无法解密或保护本机资料',
  unsafe_path:'配对资料路径检查未通过',record_invalid:'配对资料格式或内容校验未通过',access_denied:'系统拒绝访问配对资料',
  deadline_or_cancel:'本机操作达到时限或已取消',phone_key_changed:'请求的手机身份与原配对不一致',
  unconfirmed_restart:'原请求尚未完成确认，新请求已更换随机值',nonce_replay:'旧握手请求被重复使用',
  record_mismatch:'已保存身份或代次不一致，具体字段仍需核对',recovery_required:'存在未完成的原配对资料',
  instance_in_use:'该电脑已登记其他DSH实例',invalid_signature:'请求身份或签名检查未通过',expired:'邀请已到期',
  clock:'时间检查未通过',busy:'原操作尚在进行',service_unavailable:'连接器或配对服务暂不可用'}
const records:Record<string,string>={material:'电脑配对身份',source:'原二维码凭据',intent:'登记证明',pairing_intent:'配对证明',registry:'电脑登记目录',activation:'连接激活证明',recovery:'解除或恢复记录'}
const storageSteps:Record<string,string>={path:'检查路径',read:'读取文件',decode:'解析保存格式',decrypt:'解密',validate:'校验内容',encrypt:'加密',write:'写入'}
export function desktopTraceProgress(b: TraceObservationBody) {
  const t=b.trace, accepted=!!(b.seen&2), received=!!(b.seen&64)
  let step='尚未开始配对', boundary='not_started'
  if(b.outcome==='connected'){step='无';boundary='complete'}
  else if(t.blockingStage!=='none'){step=stages[t.blockingStage]??'尚未识别的步骤';boundary=t.blockingStage}
  else if(!(b.seen&1)){
    if(b.outcome!=='not_started'){step='二维码尚未生成';boundary='preparation'}
  }else if(!received&&!accepted){
    step=t.display==='shown'?'二维码已显示，尚未观察到本次手机请求'
      :'二维码已生成，图片显示和手机请求尚未确认'
    boundary=t.display==='shown'?'before_phone_request':'display_or_phone_request'
  }else if(!accepted){step='本次手机请求已到达，尚未被接受';boundary='request_validation'}
  else if(!(b.seen&4)){step='手机请求已接受，电脑验证码确认尚未完成';boundary='computer_confirmation'}
  else if(!(b.seen&8)){step='电脑已确认，手机确认尚未完成';boundary='phone_confirmation'}
  else if(!(b.seen&16)){step='两端已确认，登记或启用连接尚未完成';boundary='registration_or_activation'}
  else {step='连接已启用，首次身份验证尚未完成';boundary='authentication'}
  const signals: string[]=[]
  for(const [bit,label] of [[1,'曾提供电脑证书'],[2,'曾拒绝证书请求'],[4,'曾建立安全连接'],[8,'曾发生安全连接失败'],
    [16,'曾完成桌面版本检查'],[32,'曾拒绝桌面版本检查'],[64,'曾拒绝配对请求'],[128,'曾发生请求中断']] as const){
    if(t.listenerSignals&bit)signals.push(label)
  }
  const d=t.detail,s=d?.storage,first=d?.first
  return {lastSuccessfulStep:stages[t.lastSuccess]??'尚未识别的步骤',unfinishedStep:step,boundary,
    firstFailure:first?{stage:first[0],step:stages[first[0]],category:first[1],cause:first[2],reason:causes[first[2]],elapsedMs:first[3]}:null,
    orderedEvents:d?.events.map(e=>({sequence:e[0],stage:e[1],step:stages[e[1]],result:e[2],cause:e[3],reason:causes[e[3]],elapsedMs:e[4]}))??[],
    omittedEvents:d?.omitted??0,
    storageDetail:s?{record:records[s[0]],step:storageSteps[s[1]],stepMilliseconds:s[2],remainingMilliseconds:s[3],result:s[4],reason:causes[s[5]]}:null,
    readCounts:d?{fileReads:d.reads,decryptions:d.decryptions,reusedValidatedReads:d.reused}:null,
    detailedCoverage:d?'有首因、有限顺序及本机资料子步骤；省略的旧事件不推断。':'旧版没有首因或子步骤，不能用最后错误倒推最初原因。',
    confirmedFailure:b.outcome!=='connected'&&t.blockingStage!=='none',
    observationState:b.outcome==='connected'?'connected':t.blockingStage!=='none'?'failed':b.outcome==='open'?'waiting':'incomplete',
    endingReason:endings[b.outcome],requestObserved:received||accepted,acceptedPhone:accepted,listenerObservations:signals,
    evidenceGap:!(b.seen&1)?'二维码尚未生成，先核对电脑报告中的准备步骤；不能归因为手机扫码或手机网络失败。'
      :!accepted?'需要手机同次配对记录区分扫码、获取证书、安全连接或请求校验；无请求记录不能推断未扫码。'
      :b.outcome==='connected'?'':'结合手机同次记录核对尚未完成的步骤，不能仅凭窗口结束认定程序故障。'}
}
