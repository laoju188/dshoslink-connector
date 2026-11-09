import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPGRADE_HELPER_VERSION, UPGRADE_PROTOCOL_VERSION, UPGRADE_HOST_VERSIONS } from '../src/connector-upgrade-policy.ts'
import { SUPPORTED_DSH_VERSIONS } from '../src/connector-metadata.ts'

// A plain tsc invocation overwrites this special bundle with an unbundled
// development import. Reject that output before it can enter a release tarball.
export function verifyBuildOutput(root = process.cwd()) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if(manifest.dshosUpgrade?.protocol!==UPGRADE_PROTOCOL_VERSION || JSON.stringify(manifest.dshosUpgrade.hosts)!==JSON.stringify(SUPPORTED_DSH_VERSIONS)
    || UPGRADE_HOST_VERSIONS.some(host=>!SUPPORTED_DSH_VERSIONS.includes(host)))throw Error('Upgrade host compatibility metadata is inconsistent')
  const library = '@deepseek-ai/dsh-attachment-local'
  if (manifest.dependencies?.[library] !== undefined || !manifest.dshosBundledLibraries?.includes(library)) {
    throw Error('Image preparation library must remain bundled, not a host runtime dependency')
  }
  const output = readFileSync(resolve(root, 'dist/session-image-prepare.js'), 'utf8')
  const imports = [...output.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)].map(match => match[1])
  if (imports.some(name => name !== 'sharp' && !isBuiltin(name))) {
    throw Error('Image bundle is incomplete; run the complete build after the final TypeScript compilation')
  }
  const updater=JSON.parse(readFileSync(resolve(root,'dist/updater-payload.json'),'utf8'))
  const digest=file=>createHash('sha256').update(readFileSync(resolve(root,file))).digest('hex')
  if(updater.name!=='@dshos-link/connector-updater'||updater.version!==UPGRADE_HELPER_VERSION||digest('dist/updater.tgz')!==updater.sha256)
    throw Error('Upgrade coordinator payload is missing or inconsistent; run the complete build')
  const files=['scripts/build-updater.mjs','src/connector-upgrade-preflight.ts','src/connector-upgrade-policy.ts','src/connector-metadata.ts','package.json','updater/src/compatibility.mjs','updater/src/core.mjs','updater/src/archive.mjs','updater/src/index.mjs','updater/src/remote.mjs','updater/src/client.jsx','LICENSE','THIRD_PARTY_NOTICES.md']
  if(!updater.sources||files.some(file=>digest(file)!==updater.sources[file]))
    throw Error('Upgrade coordinator output is stale; run the complete build after source changes')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyBuildOutput()
