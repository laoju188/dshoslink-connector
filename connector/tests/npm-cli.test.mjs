import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManagerArguments, runCli } from '../scripts/npm-cli.mjs'
import { readFileSync } from 'node:fs'
const releaseVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url),'utf8')).version

test('install pins the exact configured NPM package version', () => {
  const args = buildManagerArguments('install')
  const specIndex = args.indexOf('-PackageSpec')
  assert.notEqual(specIndex, -1)
  assert.equal(args[specIndex + 1], `@dshos-link/connector@${releaseVersion}`)
})

test('status does not reinstall the package', () => {
  const args = buildManagerArguments('status')
  assert.equal(args.includes('-PackageSpec'), false)
})

test('open selects Desktop without installing the package', () => {
  const args = buildManagerArguments('open')
  assert.equal(args[args.indexOf('-Action') + 1], 'open')
  assert.equal(args.includes('-PackageSpec'), false)
  assert.equal(args[args.indexOf('-Profile') + 1], 'desktop')
})

test('existing instance options are forwarded as separate literal arguments', () => {
  const args = buildManagerArguments('install', ['--dsh-home', 'D:\\Original DSH', '--profile', 'desktop', '--dsh-path', 'D:\\DSH\\dsh.cmd'])
  assert.deepEqual(args.slice(-6), ['-DshHome', 'D:\\Original DSH', '-Profile', 'desktop', '-DshPath', 'D:\\DSH\\dsh.cmd'])
  assert.equal(args.includes('-Port'), false)
})

test('1.0.4 does not install, upgrade or open a Web instance; explicit historical status/uninstall remain available', () => {
  for (const action of ['install', 'upgrade', 'open']) {
    assert.throws(() => buildManagerArguments(action, ['--profile', 'web']), /仅支持官方 DSH 桌面版/)
    assert.equal(buildManagerArguments(action).at(-1), 'desktop')
  }
  assert.equal(buildManagerArguments('status', ['--profile', 'web']).at(-1), 'web')
  assert.equal(buildManagerArguments('uninstall', ['--profile', 'web']).at(-1), 'web')
})

test('invalid instance options stop before starting PowerShell', () => {
  for (const options of [ ['--port', '3081'], ['--profile'], ['--profile', 'web', '--profile', 'other'],
    ['--dsh-home', '-Action'], ['--profile', '../other'], ['--dsh-home', 'x\ny'] ]) {
    assert.throws(() => buildManagerArguments('install', options), /用法/)
  }
})

test('unknown actions fail before PowerShell starts', () => {
  assert.throws(() => buildManagerArguments('publish'), /用法/)
})

test('non-Windows platforms fail closed', () => {
  assert.throws(() => runCli(['install'], 'linux'), /仅支持 Windows/)
})

test('stable usage entry never passes a floating tag into the manager', () => {
  assert.throws(() => runCli([], 'win32'), /@dshos-link\/connector@latest/)
  for (const action of ['install', 'upgrade']) {
    const args = buildManagerArguments(action)
    assert.equal(args[args.indexOf('-PackageSpec') + 1], `@dshos-link/connector@${releaseVersion}`)
    assert.equal(args.some(value => value.includes('@latest')), false)
  }
})
