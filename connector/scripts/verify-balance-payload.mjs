import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const stamp = JSON.parse(readFileSync(new URL('dist/dshos-balance-build.json', root), 'utf8'))
for (const name of ['balance-api.ts', 'build.mjs', 'baseline.json', 'baseline-0.1.5.json', 'baseline-0.1.6.json', 'baseline-0.1.7.json', 'baseline-0.1.7-rc.2.json', 'baseline-0.2.0-rc.1.json', 'baseline-0.2.0-rc.2.json', 'baseline-0.2.1-rc.2.json', 'baseline-0.2.1-rc.3.json', 'baseline-0.2.1-rc.5.json', 'baseline-0.2.2-rc.1.json', 'balance-provider.mjs', 'LICENSE']) {
  if (stamp.sources[name] !== digest(readFileSync(new URL(`../patches/dsh-deepseek-balance/${name}`, root)))) {
    throw new Error('Integrated balance source changed. Rebuild using Build-WindowsRelease.ps1 before packing.')
  }
}
for (const name of ['dshos-link-deepseek-provider.tgz', 'dshos-link-deepseek-provider-015.tgz', 'dshos-link-deepseek-provider-016.tgz', 'dshos-link-deepseek-provider-017.tgz', 'dshos-link-deepseek-provider-017rc2.tgz', 'dshos-link-deepseek-provider-020rc1.tgz', 'dshos-link-deepseek-provider-020rc2.tgz', 'dshos-link-deepseek-provider-021rc2.tgz', 'dshos-link-deepseek-provider-021rc3.tgz', 'dshos-link-deepseek-provider-021rc5.tgz', 'dshos-link-deepseek-provider-022rc1.tgz']) {
  const payloadHash = digest(readFileSync(new URL(`dist/${name}`, root)))
  const sidecar = readFileSync(new URL(`dist/${name}.sha256`, root), 'utf8').trim().toLowerCase()
  if (payloadHash !== sidecar || payloadHash !== stamp.payloads?.[name]) {
    throw new Error('Integrated balance payload mismatch. Rebuild the complete connector release.')
  }
}
