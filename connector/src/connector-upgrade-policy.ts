/** The installer contract and verified host set are versioned independently of connector releases. */
export const UPGRADE_PROTOCOL_VERSION = 1
export const UPGRADE_HELPER_VERSION = '0.1.3'
export const UPGRADE_HOST_VERSIONS: readonly string[] = ['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1']

export function supportsInAppUpgrade(hostVersion: string): boolean {
  return UPGRADE_HOST_VERSIONS.includes(hostVersion)
}
