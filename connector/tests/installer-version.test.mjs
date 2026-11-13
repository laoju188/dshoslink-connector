import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildManagerArguments } from '../scripts/npm-cli.mjs'
import { CONNECTOR_VERSION } from '../dist/connector-metadata.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manager = fileURLToPath(new URL('../scripts/windows/Manage-DshosLinkConnector.ps1', import.meta.url))
function invoke(body, spec = '') {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    "$ErrorActionPreference='Stop'; . $env:DSHOS_TEST_MANAGER; " + body], {
    encoding: 'utf8', env: { ...process.env, DSHOS_TEST_MANAGER: manager, DSHOS_TEST_SPEC: spec },
    timeout: 30000,
  })
}

test('package, runtime metadata and actual Windows manager agree on the release version', () => {
  assert.equal(CONNECTOR_VERSION, pkg.version)
  const result = invoke('Write-Output $ConnectorVersion')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), pkg.version)
})

for (const action of ['install', 'upgrade']) {
  test(`${action}: real CLI package spec is accepted by the actual manager resolver`, () => {
    const args = buildManagerArguments(action)
    const spec = args[args.indexOf('-PackageSpec') + 1]
    const result = invoke("Resolve-DshosInstallTarget '' $env:DSHOS_TEST_SPEC", spec)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(result.stdout.trim(), `${pkg.name}@${pkg.version}`)
  })
}

test('manager continues rejecting floating or wrong package specs before installation', () => {
  for (const version of ['latest', '0.1.19', '0.1.18', '0.1.17', '0.1.16', '0.1.15', '0.1.14', '0.1.13', '0.1.12', '99.99.99']) {
    const result = invoke("try { Resolve-DshosInstallTarget '' $env:DSHOS_TEST_SPEC } catch { if ($_.Exception.Message.Contains($ConnectorPackageName + '@' + $ConnectorVersion)) { Write-Output 'REJECTED_WRONG_SPEC'; exit 0 }; throw }", `${pkg.name}@${version}`)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'REJECTED_WRONG_SPEC')
  }
})

for(const version of ['0.2.14','0.2.5','0.2.4','0.2.3','0.2.2','0.2.1','0.2.0','0.1.19','0.1.18','0.1.17','0.1.16','0.1.15','0.1.14','0.1.13','0.1.12'])test(`the previously published ${version} remains recognized as historical configuration`, () => {
  const result = invoke(`if ('${version}' -cnotin $PreviousConnectorVersions) { throw 'Published version missing' }`)
  assert.equal(result.status, 0, result.stderr)
})
