import type { CloudPairingRemoteClient } from './cloud-pairing.js'

type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
export type CloudPairingGatewayClient = {
  [K in keyof CloudPairingRemoteClient]: (...args: Parameters<NonNullable<CloudPairingRemoteClient[K]>>) =>
    Promise<RemoteResult<Awaited<ReturnType<NonNullable<CloudPairingRemoteClient[K]>>>>>
}

/** The DSH Gateway returns a RemoteResult even when a business call fails.
 * Unwrap at the UI boundary; no retry, invented success, or raw error display. */
async function value<T>(result: Promise<RemoteResult<T>>): Promise<T> {
  const reply = await result
  if (!reply.ok) throw new Error('cloud_pairing_host_unavailable')
  return reply.value
}

export function cloudPairingClient(remote: CloudPairingGatewayClient): CloudPairingRemoteClient {
  return {
    observeEntry: (viewId,event,cycle) => value(remote.observeEntry!(viewId,event,cycle)),
    openView: () => value(remote.openView()),
    status: viewId => value(remote.status(viewId)),
    claim: (viewId, code,entry) => value(remote.claim(viewId, code,entry)),
    cancel: viewId => value(remote.cancel(viewId)),
    suspend: viewId => value(remote.suspend(viewId)),
  }
}
