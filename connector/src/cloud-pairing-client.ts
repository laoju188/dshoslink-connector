import { randomBytes, type KeyObject } from 'node:crypto'
import { cloudDigest, cloudFields, cloudUnusedResult, cloudSign, cloudVerify, normalizeCloudCode, parseCloudDesktop,
  CLOUD_PAIRING_CONTRACT, CLOUD_PAIRING_PRODUCT, type CloudDesktop, type CloudEnvironment,
  type CloudOperation, type CloudPayload, type CloudRequest } from './cloud-pairing-contract.js'
import { registrationSign, registrationPrivateKey, registrationId } from './dsh-registration-contract.js'
import { CloudPairingHttpError } from './cloud-pairing-http.js'
import { ServiceAccessFailure, type ServiceAccessStatus } from './service-access.js'

export interface CloudDesktopJournal {
  contract: 'dshos-cloud-desktop-journal-v3'
  claimId: string
  attemptId: string | null
  revision: number
  startedAt: number
  last: CloudPayload | null
  replyText: string | null
  pending: CloudRequest | null
  /** Explicit refusal stops replay across restarts; the original intent stays
   * available for signed reconciliation when the user submits again. */
  claimRefusal?: ServiceAccessStatus
}
export interface CloudDesktopOptions {
  environment: CloudEnvironment
  desktop: CloudDesktop
  registrationPrivateKey: string
  memberPrivateKey: string
  serviceKey: { keyId: string; publicKey: string }
  /** All journal operations must use one protected, exclusively held local identity. */
  read(): Promise<CloudDesktopJournal | null>
  write(journal: CloudDesktopJournal): Promise<void>
  post(request: string, signal: AbortSignal): Promise<string>
  /** Save pending-auth material only. This callback must never publish ACTIVE. */
  saveBinding(status: CloudPayload): Promise<void>
  assertCurrent(): void
  now(): number
  monotonic(): number
  observe(stage: string, outcome: 'started' | 'completed' | 'unknown' | 'failed', error?: unknown): void
}

export class CloudDesktopPairing {
  private busy = false
  private closed = false
  private nextPoll = 0
  // Keep a refusal in this process even when its durable checkpoint fails.
  // This is a stop signal only; signed reconciliation still decides the result.
  private observedClaimRefusal: ServiceAccessStatus | null = null
  private controller: AbortController | null = null
  get activeOperation(): boolean { return this.busy }
  get hasObservedClaimRefusal(): boolean { return this.observedClaimRefusal !== null }
  get pollDelayMs(): number { this.check(); return Math.max(0, Math.ceil(this.nextPoll - this.options.monotonic())) }
  private readonly privateKey: KeyObject
  constructor(private readonly options: CloudDesktopOptions) {
    parseCloudDesktop(options.desktop)
    this.privateKey = registrationPrivateKey(options.registrationPrivateKey, options.desktop.registrationPublicKey)
    registrationPrivateKey(options.memberPrivateKey, options.desktop.memberPublicKey)
    if (!['PRODUCTION', 'SANDBOX'].includes(options.environment) || !registrationId(options.serviceKey.publicKey, 32))
      throw Error('cloud_pairing_configuration')
  }
  private check(): void { if (this.closed) throw Error('cloud_pairing_closed'); this.options.assertCurrent() }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw Error('cloud_pairing_busy')
    this.check(); this.busy = true
    try { return await run() } finally { this.busy = false }
  }
  private async journal(): Promise<CloudDesktopJournal> {
    this.check(); const journal = await this.options.read(); this.check()
    if (!journal || journal.contract !== 'dshos-cloud-desktop-journal-v3' || !registrationId(journal.claimId) ||
      journal.attemptId !== null && !registrationId(journal.attemptId) || !Number.isSafeInteger(journal.revision) || journal.revision < 0)
      throw Error('cloud_pairing_original_state_unavailable')
    return journal
  }
  private async write(journal: CloudDesktopJournal): Promise<void> {
    this.check(); await this.options.write(structuredClone(journal)); this.check()
  }
  private request(journal: CloudDesktopJournal, operation: CloudOperation, payload: CloudPayload): CloudRequest {
    const now = this.options.now()
    if (!Number.isSafeInteger(now) || now < 0) throw Error('cloud_pairing_clock')
    const body: Omit<CloudRequest, 'signature'> = { contract: CLOUD_PAIRING_CONTRACT, environment: this.options.environment,
      product: CLOUD_PAIRING_PRODUCT, role: 'desktop' as const, operation,
      requestId: randomBytes(16).toString('base64url'), attemptId: journal.attemptId ?? journal.claimId,
      publicKey: this.options.desktop.registrationPublicKey, issuedAt: now, expiresAt: now + 60_000, payload }
    return { ...body, signature: cloudSign('REQUEST', body, this.privateKey) }
  }
  private async exchange(journal: CloudDesktopJournal, request: CloudRequest): Promise<CloudPayload> {
    // A failed read must not erase the only recoverable write (including a
    // claim that never reached the service). Keep it until a verified reply.
    // Queries add no write intent. The journal was freshly read under the vault
    // lease; keep its durable original pending request without rewriting it.
    // Mutations still cannot leave this process until their intent is durable.
    if (!['status','resolve'].includes(request.operation))
      await this.write({ ...journal, pending: request })
    this.check()
    const started = this.options.monotonic(), controller = new AbortController()
    this.nextPoll = started + 5000
    this.controller = controller; let sent = false, timer: ReturnType<typeof setTimeout> | undefined
    this.options.observe(request.operation, 'started')
    try {
      sent = true
      const text = await Promise.race([this.options.post(JSON.stringify(request), controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('cloud_pairing_timeout')) }, 8000) })])
      this.check()
      if (this.options.monotonic() < started || this.options.monotonic() - started >= 8000 || Buffer.byteLength(text) > 16_384)
        throw Error('cloud_pairing_response_expired')
      const value = JSON.parse(text)
      if (JSON.stringify(value) !== text || !cloudFields(value, ['contract', 'product', 'environment', 'keyId', 'requestId', 'requestDigest', 'serverTime', 'result', 'signature']))
        throw Error('cloud_pairing_response_format')
      const { signature, ...reply } = value
      if (reply.contract !== request.contract || reply.product !== request.product || reply.environment !== request.environment ||
        reply.keyId !== this.options.serviceKey.keyId || reply.requestId !== request.requestId || reply.requestDigest !== cloudDigest(request) ||
        !Number.isSafeInteger(reply.serverTime) || (reply.serverTime as number) < request.issuedAt - 30_000 ||
        (reply.serverTime as number) >= request.expiresAt || !cloudVerify('RESPONSE', reply, this.options.serviceKey.publicKey, signature))
        throw Error('cloud_pairing_response_proof')
      const status = reply.result as CloudPayload
      if(status?.state==='unused') {
        if(request.operation!=='resolve'||journal.last!==null||!journal.pending||journal.pending.operation!=='claim'||
          !cloudUnusedResult(status,'desktop',request.publicKey,journal.claimId,this.options.desktop)||
          status.originalDigest!==cloudDigest(journal.pending)) throw Error('cloud_pairing_response_scope');
        const {claimRefusal: _refusal, ...resolved} = journal
        await this.write({...resolved,attemptId:journal.claimId,revision:1,last:status,pending:null,replyText:text});
        this.observedClaimRefusal = null
        this.options.observe('resolve','completed');return status;
      }
      if (!status || status.contract !== request.contract || status.product !== request.product ||
        !registrationId(status.attemptId) || journal.attemptId !== null && status.attemptId !== journal.attemptId ||
        !registrationId(status.mobilePublicKey, 32) || !Number.isSafeInteger(status.revision) ||
        (status.revision as number) < Math.max(1, journal.revision) || status.pollAfterMs !== 5000 ||
        !['claimed', 'authorized', 'registered', 'paired', 'cancelled', 'rejected', 'expired', 'revoked'].includes(status.state as string) ||
        typeof status.phoneSaved !== 'boolean' || typeof status.desktopSaved !== 'boolean' || status.code !== undefined ||
        cloudDigest(status.desktop) !== cloudDigest(this.options.desktop)) throw Error('cloud_pairing_response_scope')
      const manifest = status.manifest as CloudPayload
      if (!manifest || cloudDigest(manifest) !== status.manifestHash || manifest.attemptId !== status.attemptId ||
        manifest.mobilePublicKey !== status.mobilePublicKey || manifest.environment !== request.environment ||
        manifest.product !== request.product || manifest.contract !== request.contract ||
        manifest.createdAt !== status.createdAt || manifest.expiresAt !== status.expiresAt ||
        cloudDigest(manifest.desktop) !== cloudDigest(this.options.desktop)) throw Error('cloud_pairing_manifest_scope')
      if (journal.last && status.revision === journal.revision && cloudDigest(journal.last) !== cloudDigest(status))
        throw Error('cloud_pairing_revision_conflict')
      const {claimRefusal: _refusal, ...resolved} = journal
      await this.write({ ...resolved, attemptId: status.attemptId as string, revision: status.revision as number, last: status, pending: null, replyText: text })
      this.observedClaimRefusal = null
      this.nextPoll = this.options.monotonic() + 5000
      this.options.observe(request.operation, 'completed')
      return status
    } catch (error) {
      if (request.operation === 'claim' && journal.attemptId === null && journal.last === null &&
        error instanceof ServiceAccessFailure && error.access !== null) {
        // Do not infer that an earlier lost response never committed. Preserve
        // its signed request, but persist that this explicit refusal is not an
        // unknown network result and must not be replayed automatically.
        this.check(); this.observedClaimRefusal = structuredClone(error.access)
        try { await this.write({ ...journal, pending: request, claimRefusal: error.access }) }
        catch {
          // Runtime.save records the storage failure. It must not replace this
          // already-observed policy refusal with an ordinary retryable error.
          this.check()
        }
      }
      if (error instanceof CloudPairingHttpError && error.status === 429)
        this.nextPoll = this.options.monotonic() + Math.max(5000,error.retryAfterMs ?? 5000)
      const rejected=error instanceof ServiceAccessFailure&&error.access!==null||
        error instanceof CloudPairingHttpError&&error.status>=400&&error.status<500&&error.status!==408
      this.options.observe(request.operation, rejected||!sent ? 'failed' : 'unknown',error)
      throw error
    } finally { if (timer) clearTimeout(timer); controller.abort(); this.controller = null }
  }
  start(code: string): Promise<CloudPayload> {
    return this.locked(async () => {
      const normalized = normalizeCloudCode(code)
      if (!normalized) throw Error('cloud_pairing_invalid_code')
      if (await this.options.read()) throw Error('cloud_pairing_resume_required')
      const journal: CloudDesktopJournal = { contract: 'dshos-cloud-desktop-journal-v3', claimId: randomBytes(16).toString('base64url'),
        attemptId: null, revision: 0, startedAt: this.options.now(), last: null, pending: null, replyText: null }
      const request = this.request(journal, 'claim', {})
      request.payload = { code: normalized, desktop: this.options.desktop, memberSignature: cloudSign('CLAIM-MEMBER',
        { attemptId: journal.claimId, requestId: request.requestId, code: normalized, desktop: this.options.desktop,
          environment: request.environment, product: request.product },
        registrationPrivateKey(this.options.memberPrivateKey, this.options.desktop.memberPublicKey)) }
      const { signature: _, ...body } = request; request.signature = cloudSign('REQUEST', body, this.privateKey)
      try{return await this.exchange(journal, request)}catch(error){
        if(!(error instanceof CloudPairingHttpError)||error.status!==404||error.reason!=='code_unavailable')throw error
        return this.resolveUnconfirmed(await this.journal())
      }
    })
  }
  private resolveUnconfirmed(journal:CloudDesktopJournal):Promise<CloudPayload>{
    if(journal.last!==null||journal.attemptId!==null||journal.pending?.operation!=='claim')throw Error('cloud_pairing_original_result_required')
    return this.exchange(journal,this.request(journal,'resolve',{original:journal.pending}))
  }
  /** Explicit user retry only. Reconcile/fence the original request before any
   * new code may be submitted; a committed result must finish instead. */
  resolveRefusedClaim(): Promise<CloudPayload> {
    return this.locked(async () => {
      const journal = await this.journal()
      if (!journal.claimRefusal && !this.observedClaimRefusal) throw Error('cloud_pairing_original_result_required')
      return this.resolveUnconfirmed(journal)
    })
  }
  /** Caller schedules at pollAfterMs, pauses while hidden and resumes the same journal. */
  poll(): Promise<CloudPayload> {
    return this.locked(async () => {
      if (this.options.monotonic() < this.nextPoll) throw Error('cloud_pairing_poll_wait')
      const journal = await this.journal()
      if (journal.claimRefusal || this.observedClaimRefusal) throw new ServiceAccessFailure(journal.claimRefusal ?? this.observedClaimRefusal)
      if (journal.attemptId === null && journal.pending?.operation === 'claim' &&
        journal.pending.expiresAt > this.options.now()) {
        try{return await this.exchange(journal,journal.pending)}catch(error){
          if(!(error instanceof CloudPairingHttpError)||error.status!==404||error.reason!=='code_unavailable')throw error
          return this.resolveUnconfirmed(await this.journal())
        }
      }
      try { return await this.exchange(journal, this.request(journal, 'status', {})) }
      catch (error) {
        if (!(error instanceof CloudPairingHttpError) || error.status !== 404 || error.reason !== 'request_unavailable' ||
          journal.attemptId !== null || journal.pending?.operation !== 'claim') throw error
        if(this.options.now() >= journal.startedAt + 300_000)return this.resolveUnconfirmed(journal)
        const original = journal.pending, request = this.request(journal, 'claim', {})
        request.payload = { ...original.payload, memberSignature: cloudSign('CLAIM-MEMBER',
          { attemptId: journal.claimId, requestId: request.requestId, code: original.payload.code, desktop: this.options.desktop,
            environment: request.environment, product: request.product },
          registrationPrivateKey(this.options.memberPrivateKey, this.options.desktop.memberPublicKey)) }
        const {signature: _, ...body} = request; request.signature = cloudSign('REQUEST', body, this.privateKey)
        try{return await this.exchange(journal, request)}catch(retryError){
          if(!(retryError instanceof CloudPairingHttpError)||retryError.status!==404||retryError.reason!=='code_unavailable')throw retryError
          return this.resolveUnconfirmed(await this.journal())
        }
      }
    })
  }
  advance(): Promise<CloudPayload> {
    return this.locked(async () => {
      const status = await this.advanceStep()
      const prepared = status.prepared as CloudPayload | null
      // A verified prepare result already enables our proof. Continue once
      // under the same lock; polling is only for work owned by the other end.
      if (status.state === 'authorized' && prepared && !prepared.desktopProof)
        return this.advanceStep()
      return status
    })
  }
  private async advanceStep(): Promise<CloudPayload> {
      const journal = await this.journal(), status = journal.last
      if (!status || journal.pending) return this.exchange(journal, this.request(journal, 'status', {}))
      if (status.state === 'authorized') {
        const prepared = status.prepared as CloudPayload | null
        // Once handed to the phone, keep a proved challenge until actual expiry.
        // Renewing it early invalidates an otherwise valid in-flight finalization.
        const renewalLeadMs = prepared?.desktopProof ? 0 : 15_000
        if (!prepared || (JSON.parse(prepared.pairingText as string).expiresAt as number) <= this.options.now() + renewalLeadMs)
          return this.exchange(journal, this.request(journal, 'prepare', { manifestHash: status.manifestHash }))
        if (prepared.desktopProof) return status
        const p = JSON.parse(prepared.pairingText as string) as CloudPayload
        const d = this.options.desktop
        if (p.computerId !== d.computerId || p.memberId !== d.memberId || p.newPairingId !== d.pairingId ||
          p.newMobilePublicKey !== status.mobilePublicKey || p.invitationDigest !== status.manifestHash ||
          !registrationId(p.accountBindingId) || !registrationId(p.registrationGeneration) ||
          !registrationId(p.memberKeyGeneration) || !registrationId(p.newPairingGeneration) ||
          p.memberKeyGeneration !== prepared.memberGeneration || typeof prepared.recovery !== 'boolean')
          throw Error('cloud_pairing_challenge_scope')
        const r = prepared.registrationText === null ? null : JSON.parse(prepared.registrationText as string) as CloudPayload
        if (r && (r.computerId !== d.computerId || r.memberId !== d.memberId || r.platform !== 'dsh' ||
          r.registrationPublicKey !== d.registrationPublicKey || r.memberPublicKey !== d.memberPublicKey ||
          r.mobilePublicKey !== status.mobilePublicKey || r.invitationDigest !== status.manifestHash ||
          r.accountBindingId !== p.accountBindingId || r.newGeneration !== p.registrationGeneration ||
          !['create', 'add'].includes(r.purpose as string))) throw Error('cloud_pairing_challenge_scope')
        const desktopProof = {
          registrationSignature: r ? registrationSign('REGISTRATION/' + (r.purpose as string).toUpperCase(), r, this.options.registrationPrivateKey, d.registrationPublicKey) : null,
          registrationMemberSignature: r ? registrationSign('REGISTRATION/' + (r.purpose as string).toUpperCase(), r, this.options.memberPrivateKey, d.memberPublicKey) : null,
          memberSignature: registrationSign((prepared.recovery ? 'DSH-PAIR-RECOVERY' : 'MEMBER-PAIRING') + '/MEMBER', p,
            this.options.memberPrivateKey, d.memberPublicKey) }
        return this.exchange(journal, this.request(journal, 'proof', { pairingDigest: cloudDigest(prepared.pairingText), desktopProof }))
      }
      if (['registered', 'paired'].includes(status.state as string) && !status.desktopSaved) {
        this.check(); await this.options.saveBinding(structuredClone(status)); this.check()
        return this.exchange(journal, this.request(journal, 'saved', { bindingDigest: cloudDigest(status.binding) }))
      }
      return status
  }
  cancel(): Promise<CloudPayload> { return this.locked(async () => {
    const journal = await this.journal(); return this.exchange(journal, this.request(journal, 'cancel', {}))
  }) }
  close(): void { this.closed = true; this.controller?.abort() }
}
