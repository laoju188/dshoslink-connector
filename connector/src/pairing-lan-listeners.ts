import { X509Certificate } from 'node:crypto'
import { validateDesktopLanHosts } from './desktop-network.js'
import type { WindowsPairingIdentity } from './pairing-identity-store.js'
import type { LanCandidateDiagnostic } from './pairing-support-contract.js'

export interface ConcreteLanListener {
  updateIdentity(identity: WindowsPairingIdentity): void
  stop(): Promise<void>
}
function wipe(identity: WindowsPairingIdentity): void {
  for (const buffer of [identity.caDer,identity.caPem,identity.pin,identity.leafCertPem,identity.leafKeyPem]) buffer.fill(0)
}

/** One business runtime, bounded concrete interfaces. No wildcard listening or
 * routing changes. Address refresh preserves AUTH and already accepted work. */
export class PairingLanListeners {
  private readonly active = new Map<string,ConcreteLanListener>()
  private closed = false
  private work: Promise<void> | undefined
  private desired: readonly string[] = []
  private observation: LanCandidateDiagnostic | undefined
  constructor(private readonly options: {
    identity(): WindowsPairingIdentity
    loadIdentity(hosts: readonly string[]): Promise<WindowsPairingIdentity>
    adopt(identity: WindowsPairingIdentity, hosts: readonly string[]): void
    start(host: string, identity: WindowsPairingIdentity): Promise<ConcreteLanListener>
  }) {}
  hosts(): readonly string[] { return Object.freeze([...this.active.keys()]) }
  diagnostic(): LanCandidateDiagnostic | undefined { return this.observation&&{...this.observation} }
  refresh(hosts: readonly string[]): Promise<void> {
    validateDesktopLanHosts(hosts)
    if (this.closed) return Promise.reject(Error('lan_listener_closed'))
    if (this.work) return Promise.reject(Error('lan_listener_busy'))
    const work = this.reconcile(hosts)
    this.work = work
    const clear = () => { if (this.work === work) this.work = undefined }
    void work.then(clear,clear)
    return work
  }
  private async reconcile(hosts: readonly string[]): Promise<void> {
    this.observation={candidateCount:hosts.length,listeningCount:0,lastFailure:'none',checkedAtMs:Date.now()}
    const check = () => { if (this.closed) throw Error('lan_listener_closed') }
    // Stop removed interfaces even if refreshing the certificate later fails.
    for (const [host,listener] of this.active) if (!hosts.includes(host)) {
      this.active.delete(host)
      this.options.adopt(this.options.identity(),this.hosts())
      await listener.stop(); check()
    }
    this.observation.listeningCount=this.active.size
    if (hosts.length === 0) { this.desired=[]; return }
    if (JSON.stringify(hosts) === JSON.stringify(this.desired) && hosts.every(host=>this.active.has(host))) return
    const previous = this.options.identity()
    let next: WindowsPairingIdentity | undefined
    let adopted = false
    try {
      const cert = new X509Certificate(previous.leafCertPem)
      next = hosts.every(host=>cert.checkIP(host)===host) ? previous : await this.options.loadIdentity(hosts)
      check()
      if (next.identityId !== previous.identityId || !next.pin.equals(previous.pin) || !next.caDer.equals(previous.caDer)
        || hosts.some(host=>new X509Certificate(next!.leafCertPem).checkIP(host)!==host)) throw Error('lan_listener_identity_changed')
      for (const listener of this.active.values()) listener.updateIdentity(next)
      let failure: unknown
      for (const host of hosts) {
        if (this.active.has(host)) continue
        try {
          const listener=await this.options.start(host,next)
          if (this.closed) { await listener.stop(); check() }
          this.active.set(host,listener)
        } catch (error) { check(); failure ??= error
          const reason=(error as {reason?:string}).reason
          this.observation.lastFailure=reason==='port_conflict'||reason==='address_unavailable'?reason:'unknown'
        }
      }
      check()
      this.options.adopt(next,this.hosts()); adopted=true
      this.observation.listeningCount=this.active.size
      this.desired=[...hosts]
      if (this.active.size===0) throw failure ?? Error('lan_listener_unavailable')
    } catch(error) { if(this.observation.lastFailure==='none')this.observation.lastFailure='unknown';throw error
    } finally {
      if (next && next!==previous && !adopted) wipe(next)
    }
  }
  async stop(): Promise<void> {
    if (this.closed) return
    this.closed=true
    const listeners=[...this.active.values()];this.active.clear()
    const results=await Promise.allSettled(listeners.map(listener=>listener.stop()))
    await this.work?.catch(()=>undefined)
    const failed=results.find(result=>result.status==='rejected')
    if (failed?.status==='rejected') throw failed.reason
  }
}
