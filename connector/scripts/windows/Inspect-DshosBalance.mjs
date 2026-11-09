// Invoked directly: DSH plugin commands also reconcile the active bundle list.
// Reads package metadata only, never DSH settings, credentials or environment.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.argv[2])
const name = '@deepseek-ai/dsh-llm-deepseek'
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
const spec = manifest.dependencies?.[name]
function installedVersion(packageName) {
  // Node's ordinary resolver can fall through to NODE_PATH or another ancestor
  // installation. Only a dependency entry owned by this profile is evidence.
  try {
    const value = JSON.parse(readFileSync(resolve(root, 'node_modules', packageName, 'package.json'), 'utf8'))
    return value?.name === packageName && typeof value.version === 'string' ? value.version : ''
  } catch { return '' }
}
const version = installedVersion(name)
const prior = spec === undefined ? 'absent' : ['0.1.1-rc.2', '0.1.5-rc.2', '0.1.6-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.1'].includes(spec) ? 'official'
  : typeof spec === 'string' && spec.startsWith('file:') && ['0.1.1-rc.2-dshoslink.1', '0.1.5-rc.2-dshoslink.1', '0.1.6-alpha.1-dshoslink.1', '0.1.7-alpha.2-dshoslink.1', '0.1.7-rc.2-dshoslink.1', '0.2.0-rc.1-dshoslink.1', '0.2.0-rc.2-dshoslink.1', '0.2.1-rc.2-dshoslink.1', '0.2.1-rc.3-dshoslink.1', '0.2.1-rc.5-dshoslink.1', '0.2.2-rc.1-dshoslink.1'].includes(version) ? 'managed' : 'custom'
const connectorVersion = installedVersion('@dshos-link/connector') || null
process.stdout.write('\nDSHOS_BALANCE_PROFILE=' + JSON.stringify({ root, prior, version, connectorVersion }) + '\n')
