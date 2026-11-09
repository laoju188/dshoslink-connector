// Fixed cloud-service status only; never a desktop task or LAN authorization gate.
export interface ServiceAccessStatus {
  version: number; revision: number; mode: string; reason: string;
  caseId: string; endsAt: number | null; serverTime: number;
}
export interface ServiceAccessView {
  message: string; restricted: boolean; needsCheck: boolean; checking: boolean; retryAfterMs: number;
}
export interface ServiceAccessDiagnostic { mode: string; reason: string; caseId: string; }
export function validServiceAccessDiagnostic(value: ServiceAccessDiagnostic): boolean {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='caseId,mode,reason'&&
    ['relay_paused','pairing_and_relay_paused'].includes(value.mode)&&['verified_abuse','account_security','legal_requirement'].includes(value.reason)&&
    typeof value.caseId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.caseId);
}
export function parseServiceAccess(text: string): ServiceAccessStatus {
  if (text.length > 2048) throw new Error('service_access_invalid');
  const value = JSON.parse(text) as ServiceAccessStatus;
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'caseId,endsAt,mode,reason,revision,serverTime,version' ||
    value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !Number.isSafeInteger(value.serverTime) || value.serverTime < 0 ||
    !['normal','relay_paused','pairing_and_relay_paused'].includes(value.mode) ||
    !['none','verified_abuse','account_security','legal_requirement'].includes(value.reason) ||
    typeof value.caseId !== 'string' ||
    (value.mode === 'normal' ? value.reason !== 'none' || value.caseId !== '' || value.endsAt !== null :
      value.reason === 'none' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.caseId) ||
      !Number.isSafeInteger(value.endsAt) || value.endsAt! <= 0)) throw new Error('service_access_invalid');
  // A bounded cached restriction can outlive its deadline until the server
  // confirms expiry. The authoritative mode, never the deadline, grants access.
  return value;
}
export function serviceAccessMessage(status: ServiceAccessStatus | null): string {
  if (status === null) return '跨网连接已暂停，正在核对服务状态。原配对和电脑任务已保留。';
  if (status.mode === 'normal') return '';
  const scope = status.mode === 'relay_paused' ? '跨网连接' : '新云配对和跨网连接';
  return `此账号的${scope}暂时受限。已有局域网连接仍可使用，电脑任务不会因此取消。可通过帮助与反馈联系我们。处理编号：${status.caseId}。`;
}
export class ServiceAccessFailure extends Error {
  owner: number = 0;
  readonly statusCode: number; readonly serviceCode: string; readonly access: ServiceAccessStatus | null;
  constructor(access: ServiceAccessStatus | null) {
    super(access === null ? '云服务状态暂时无法核对，请稍后重试。原配对和资料已保留。' : serviceAccessMessage(access));
    this.statusCode = access === null ? 503 : 403;
    this.serviceCode = access === null ? 'service_access_unavailable' : 'service_access_restricted';
    this.access = access;
  }
}
export class ServiceAccessHint extends Error { owner: number = 0; constructor() { super('跨网连接已暂停，正在核对服务状态'); } }
interface FailureBody { error: string; access?: ServiceAccessStatus; }
export function parseServiceAccessFailure(status: number, text: string): ServiceAccessFailure | undefined {
  if (status !== 403 && status !== 503 || text.length > 2048) return undefined;
  try {
    const value = JSON.parse(text) as FailureBody;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (status === 503 && Object.keys(value).join(',') === 'error' && value.error === 'service_access_unavailable')
      return new ServiceAccessFailure(null);
    if (status !== 403 || Object.keys(value).sort().join(',') !== 'access,error' || value.error !== 'service_access_restricted') return undefined;
    const access = parseServiceAccess(JSON.stringify(value.access));
    return access.mode === 'normal' ? undefined : new ServiceAccessFailure(access);
  } catch { return undefined; }
}

/** One identity's in-memory latch. Expiry never lifts a restriction without a fresh server response. */
let nextGateId: number = 0;
export class ServiceAccessGate {
  readonly id: number = ++nextGateId;
  private value: ServiceAccessStatus | null = null;
  private suspected: boolean = false;
  private epoch: number = 0;
  private pending: boolean = false;
  private lastCheck: number = -10000;
  private nextCheck: number = 0;
  private failedCheck: boolean = false;
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(now: () => number = Date.now, random: () => number = Math.random) { this.now=now; this.random=random; }
  needsCheck(): boolean { return this.suspected || this.value !== null && this.value.mode !== 'normal'; }
  checkDelay(): number { return Math.max(1000,Math.ceil(Math.max(this.lastCheck+10000,this.nextCheck)-this.now())); }
  blocked(scope: string = 'relay'): boolean {
    return scope === 'pairing' ? this.value?.mode === 'pairing_and_relay_paused' : this.needsCheck();
  }
  observe(error: Object): void {
    if(error instanceof ServiceAccessHint || error instanceof ServiceAccessFailure)error.owner=this.id;
    if (error instanceof ServiceAccessHint) {
      if (!this.needsCheck()) { this.suspected=true; this.epoch++; this.nextCheck=0; }
    } else if (error instanceof ServiceAccessFailure && error.access !== null) {
      const next=error.access;
      if (this.value !== null && (next.revision < this.value.revision || next.serverTime < this.value.serverTime ||
        next.revision === this.value.revision && next.serverTime === this.value.serverTime)) return;
      this.value=next; this.suspected=false; this.epoch++;
      this.nextCheck=this.now()+300000+Math.floor(Math.max(0,Math.min(1,this.random()))*30000);
    }
  }
  assert(scope: string = 'relay'): void {
    if (this.blocked(scope)) {
      if(this.value !== null && this.value.mode !== 'normal'){const error=new ServiceAccessFailure(this.value);error.owner=this.id;throw error;}
      const error=new ServiceAccessHint();error.owner=this.id;throw error;
    }
  }
  diagnostic(): ServiceAccessDiagnostic | undefined {
    if (this.value === null || this.value.mode === 'normal') return undefined;
    return {mode:this.value.mode,reason:this.value.reason,caseId:this.value.caseId};
  }
  view(): ServiceAccessView {
    const restricted=this.value !== null && this.value.mode !== 'normal';
    return {message:this.needsCheck()?serviceAccessMessage(restricted?this.value:null)+(this.failedCheck?' 状态核对暂不可用，请稍后再试。':'' ):'',
      restricted,needsCheck:this.needsCheck(),checking:this.pending,retryAfterMs:Math.max(0,Math.ceil(this.lastCheck+10000-this.now()))};
  }
  async check(read: () => Promise<ServiceAccessStatus>, manual: boolean = false, guard: () => void = (): void => {}): Promise<boolean> {
    const now=this.now();
    if (!this.needsCheck() || this.pending || now < this.lastCheck+10000 || !manual && now < this.nextCheck) return false;
    guard(); const epoch=this.epoch; this.pending=true; this.lastCheck=now;
    this.nextCheck=now+300000+Math.floor(Math.max(0,Math.min(1,this.random()))*30000);
    try {
      const value=await read(); guard();
      if (epoch !== this.epoch || this.value !== null && (value.revision < this.value.revision || value.serverTime < this.value.serverTime)) return false;
      this.value=value; this.suspected=false; this.failedCheck=false; this.epoch++;
      return value.mode === 'normal';
    } catch { this.failedCheck=true; return false; }
    finally { this.pending=false; }
  }
}
