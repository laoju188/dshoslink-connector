import { request } from 'node:https'
import { performance } from 'node:perf_hooks'
import { SERVICE_ENDPOINTS } from './service-environment.js'
import { cloudFields } from './cloud-pairing-contract.js'
import { parseServiceAccessFailure } from './service-access.js'

export class CloudPairingHttpError extends Error {
  constructor(readonly status: number, readonly reason: string, readonly retryAfterMs?: number) { super(reason) }
}
/** Fixed product endpoint, verified system TLS, no redirects, no URL supplied by UI. */
export function postCloudPairing(text: string, signal: AbortSignal): Promise<string> {
  return exchangeCloudPairing(text, signal)
}
export async function cloudPairingSupported(signal:AbortSignal):Promise<boolean> {
  const value:unknown=JSON.parse(await exchangeCloudPairing(null,signal))
  if(!cloudFields(value,['contract','product','enabled','codeLength','pollAfterMs','serverTime'])||
    value.contract!=='dshos-cloud-pairing-v3'||value.product!=='harmony-dsh'||typeof value.enabled!=='boolean'||
    value.codeLength!==8||value.pollAfterMs!==5000||!Number.isSafeInteger(value.serverTime))
    throw Error('cloud_pairing_capabilities_invalid')
  return value.enabled
}
function exchangeCloudPairing(text: string|null, signal: AbortSignal): Promise<string> {
  if (text!==null&&Buffer.byteLength(text) > 16_384) return Promise.reject(Error('cloud_pairing_request_capacity'))
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const req = request(SERVICE_ENDPOINTS.baseUrl + '/v3/harmony/pairing-code'+(text===null?'/capabilities':''), {
      method: text===null?'GET':'POST', agent: false, rejectUnauthorized: true, signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
    }, response => {
      if (!/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '') || response.headers['content-encoding']) {
        req.destroy(Error('cloud_pairing_response_format')); return
      }
      const chunks: Buffer[] = []; let size = 0
      response.on('error', reject)
      response.on('data', (chunk: Buffer) => { size += chunk.length
        if (size > 16_384) req.destroy(Error('cloud_pairing_response_capacity')); else chunks.push(chunk) })
      response.on('end', () => {
        try {
          signal.throwIfAborted()
          if (performance.now() - started >= 8000) throw Error('cloud_pairing_timeout')
          const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value: unknown = JSON.parse(output)
          if (JSON.stringify(value) !== output) throw Error('cloud_pairing_response_format')
          if (response.statusCode === 200) { resolve(output); return }
          const accessFailure=parseServiceAccessFailure(response.statusCode??0,output)
          if(accessFailure)throw accessFailure
          if (!cloudFields(value, ['error']) && !cloudFields(value, ['error', 'retryAfterMs']) ||
            typeof value.error !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.error) ||
            value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) ||
              (value.retryAfterMs as number) < 0 || (value.retryAfterMs as number) > 300_000)) throw Error('cloud_pairing_response_format')
          throw new CloudPairingHttpError(response.statusCode ?? 0, value.error, value.retryAfterMs as number | undefined)
        } catch (error) { reject(error) }
      })
    })
    const timer = setTimeout(() => req.destroy(Error('cloud_pairing_timeout')), 8000)
    req.once('error', reject); req.once('close', () => clearTimeout(timer)); req.end(text??undefined)
  })
}
