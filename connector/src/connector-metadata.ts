/** Connector release and exact upstream compatibility metadata. */
export const CONNECTOR_VERSION = '0.2.14'
// Historical protocol baseline, retained for existing diagnostic consumers.
export const SUPPORTED_DSH_VERSION = '0.1.1-rc.2'
export const SUPPORTED_DSH_VERSIONS = ['0.1.1-rc.2', '0.1.5-rc.1', '0.1.6-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1'] as const
export const LATEST_SUPPORTED_DSH_VERSION = '0.2.2-rc.1'
export const SUPPORTED_DSH_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'

export const CONNECTOR_METADATA = Object.freeze({
  name: 'DSHOS Link Connector',
  packageName: '@dshos-link/connector',
  version: CONNECTOR_VERSION,
  supportedDshVersion: SUPPORTED_DSH_VERSION,
  supportedDshCommit: SUPPORTED_DSH_COMMIT,
  supportedDshVersions: SUPPORTED_DSH_VERSIONS,
  latestSupportedDshVersion: LATEST_SUPPORTED_DSH_VERSION,
})
