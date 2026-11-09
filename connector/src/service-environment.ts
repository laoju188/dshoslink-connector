// This is a deployment endpoint selection, never an entitlement or IAP decision.
export function serviceEndpoints(environment: string | undefined): {
  readonly baseUrl: string
  readonly relayUrl: string
  readonly credentialSuffix: string
  readonly registrationDirectoryName: string
  readonly registrationStateDirectoryName: string
} {
  if (environment !== undefined && environment !== 'production' && environment !== 'sandbox') {
    throw new Error('DSHOS_LINK_SERVICE_ENVIRONMENT must be production or sandbox')
  }
  const prefix = environment === 'sandbox' ? '/sandbox' : ''
  return Object.freeze({
    baseUrl: `https://dshoslink.cn${prefix}`,
    relayUrl: `wss://dshoslink.cn${prefix}/v1/relay/connect`,
    credentialSuffix: environment === 'sandbox' ? '' : '-production',
    registrationDirectoryName: environment === 'sandbox' ? 'registration-sandbox' : 'registration',
    registrationStateDirectoryName: environment === 'sandbox' ? 'registration-v2-sandbox' : 'registration-v2',
  })
}

export const SERVICE_ENDPOINTS = serviceEndpoints(process.env.DSHOS_LINK_SERVICE_ENVIRONMENT)
