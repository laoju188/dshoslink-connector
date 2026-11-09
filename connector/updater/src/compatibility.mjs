import { createHash } from 'node:crypto';
import { packageManifest } from './archive.mjs';
import { UpgradeRefusal } from './core.mjs';
import { UPGRADE_PROTOCOL_VERSION } from '../../src/connector-upgrade-policy.ts';

// Only pre-contract public archives need this finite migration table. A matching
// version string alone never authorizes restoring a private/modified old package.
const legacy = {
  '0.2.5': ['e4e97c52e946bfe09c5a70d9c2cfbcdc0ae69cb19fe075fda36d978858891884', ['0.2.1-rc.3']],
  '0.2.6': ['bd6543eb9405ee1868fb0e88d62c359346af89e38610266e78f88d858f105580', ['0.2.1-rc.3']],
  '0.2.7': ['46a8051f3fd819189a98d35af0c17e16e82f8edf8bc65c153a118c3bca432c32', ['0.2.1-rc.3']],
  '0.2.8': ['64b84ec80811167ab42925e3a71441c94d2d6396a4deb7888611c2521cf8865d', ['0.2.1-rc.3']],
  '0.2.9': ['c1d376287e8a3f5e1e462f1d140098fd6f5f054b4fb31f9c2d166fac21afb5a0', ['0.2.1-rc.3','0.2.1-rc.5']],
};

export function assertPackageHost(bytes, version, hostVersion, purpose = 'target') {
  const manifest = packageManifest(bytes, version), policy = manifest.dshosUpgrade;
  let hosts;
  if (policy !== undefined) {
    if (!policy || Array.isArray(policy) || policy.protocol !== UPGRADE_PROTOCOL_VERSION
      || !Array.isArray(policy.hosts) || policy.hosts.length < 1 || policy.hosts.length > 32
      || policy.hosts.some(host => typeof host !== 'string' || host.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(host))) {
      throw new UpgradeRefusal('upgrade-protocol-unsupported');
    }
    hosts = policy.hosts;
  } else {
    const old = legacy[version];
    if (!old || createHash('sha256').update(bytes).digest('hex') !== old[0]) throw new UpgradeRefusal('package-compatibility-unknown');
    hosts = old[1];
  }
  if (!hosts.includes(hostVersion)) throw new UpgradeRefusal(purpose === 'previous' ? 'previous-host-incompatible' : 'target-host-incompatible');
}
