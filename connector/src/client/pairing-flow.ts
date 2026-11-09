import { useEffect, useMemo, useState } from 'react'
import type { PairingFlowStatus } from '../dsh-enrollment-remote.js'

export type { PairingFlowStatus }
export type EnrollmentWindow = NonNullable<NonNullable<PairingFlowStatus['enrollment']>['window']>
export type PairingResult<T> = { ok: true; value: T } | { ok: false; error: unknown }
export interface EnrollmentRemote {
  status(): Promise<PairingResult<PairingFlowStatus>>

}

// The desktop settings page owns one read loop. A read failure or view teardown
// never sends a command. Mutations invalidate older reads before changing state.
export function usePairingFlow(remote: EnrollmentRemote | undefined) {
  const [state, setState] = useState<PairingFlowStatus | null>(null)
  const [readError, setReadError] = useState(false), [busy, setBusy] = useState(false)
  const lifetime = useMemo(() => ({ alive: false, request: 0, reading: false, pending: false }), [remote])
  const refresh = useMemo(() => async (force = false): Promise<void> => {
    if (!remote || !lifetime.alive || !force && (lifetime.reading || lifetime.pending)) return
    const request = ++lifetime.request; lifetime.reading = true
    // A slow bridge must not leave an apparently actionable old state. Keep
    // the one in-flight read until it settles; do not pile up replacement RPCs.
    const waiting=setTimeout(()=>{if(lifetime.alive&&request===lifetime.request)setReadError(true)},15000)
    try {
      const result = await remote.status()
      if (!lifetime.alive || request !== lifetime.request) return
      if (result.ok) { setState(result.value); setReadError(false) }
      else setReadError(true)
    } catch { if (lifetime.alive && request === lifetime.request) setReadError(true) }
    finally { clearTimeout(waiting); if (request === lifetime.request) lifetime.reading = false }
  }, [remote, lifetime])
  const run = useMemo(() => async <T>(action: () => Promise<PairingResult<T>>): Promise<PairingResult<T>> => {
    if (!lifetime.alive || lifetime.pending) return { ok: false, error: 'enrollment_busy' }
    lifetime.pending = true; lifetime.request++; setBusy(true)
    try { return await action() }
    catch (error) { return { ok: false, error } }
    finally {
      // Keep the action gate through the authoritative readback. An older
      // read/action cannot release a newer action's gate or replace its result.
      await refresh(true)
      lifetime.pending = false
      if (lifetime.alive) setBusy(false)
    }
  }, [lifetime, refresh])
  useEffect(() => {
    lifetime.alive = true; setState(null); setReadError(false); setBusy(false)
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => { lifetime.alive = false; lifetime.request++; clearInterval(timer) }
  }, [lifetime, refresh])
  return { state, readError, busy, run, recheck:refresh }
}
export type PairingFlowController = ReturnType<typeof usePairingFlow>
