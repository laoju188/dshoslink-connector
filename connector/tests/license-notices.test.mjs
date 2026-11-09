import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNotices } from '../scripts/write-third-party-notices.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dshos-license-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'connector')
  mkdirSync(root)
  const provider = join(directory, 'patches/dsh-deepseek-balance')
  mkdirSync(provider, { recursive: true })
  writeFileSync(join(provider, 'LICENSE'), 'Provider MIT notice\n')
  function manifest(value) {
    writeFileSync(join(root, 'package.json'), JSON.stringify(value))
  }
  function dependency(name, options = {}, license = 'Upstream copyright and permission\n') {
    const path = join(root, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', ...options }))
    if (license !== null) writeFileSync(join(path, 'LICENSE'), license)
  }
  return { root, manifest, dependency }
}

test('notices include transitive peer licenses, omit build-only tools, and preserve upstream text', t => {
  const f = fixture(t)
  f.manifest({ dependencies: { runtime: '*' }, peerDependencies: { peer: '*' }, devDependencies: { build: '*' } })
  f.dependency('runtime', { dependencies: { common: '*' } })
  f.dependency('peer', { dependencies: { common: '*' } })
  f.dependency('common', { dependencies: { runtime: '*' } }, 'Copyright upstream@example.test\r\nPermission retained\r\n')
  f.dependency('build')
  const text = buildNotices(f.root)
  assert.match(text, /## peer@1\.0\.0/)
  assert.equal(text.match(/## common@1\.0\.0/g).length, 1)
  assert.doesNotMatch(text, /build@1\.0\.0/)
  assert.match(text, /Copyright upstream@example.test\nPermission retained/)
  assert.match(text, /Provider MIT notice/)
  assert.ok(!text.includes(f.root))
})

test('a missing required peer prevents an incomplete report', t => {
  const f = fixture(t)
  f.manifest({ peerDependencies: { missing: '*' } })
  assert.throws(() => buildNotices(f.root), /Missing dependency/)
})

test('bundled libraries retain upstream licenses without becoming host runtime dependencies', t => {
  const f = fixture(t)
  f.manifest({ devDependencies: { bundled: '*', tool: '*' }, dshosBundledLibraries: ['bundled'] })
  f.dependency('bundled', { dependencies: { shared: '*' } })
  f.dependency('shared')
  f.dependency('tool')
  const text = buildNotices(f.root)
  assert.match(text, /## bundled@1\.0\.0/)
  assert.match(text, /## shared@1\.0\.0/)
  assert.doesNotMatch(text, /## tool@1\.0\.0/)
})

test('missing or empty license text prevents packaging a summary-only notice', t => {
  const f = fixture(t)
  f.manifest({ dependencies: { missing: '*' } })
  f.dependency('missing', {}, null)
  assert.throws(() => buildNotices(f.root), /Missing license text/)
  f.dependency('missing', {}, '  \n')
  assert.throws(() => buildNotices(f.root), /Empty license text/)
})

test('uninstalled optional dependencies do not masquerade as installed components', t => {
  const f = fixture(t)
  f.manifest({ dependencies: { runtime: '*' } })
  f.dependency('runtime', { optionalDependencies: { absent: '*' }, peerDependencies: { optionalPeer: '*' }, peerDependenciesMeta: { optionalPeer: { optional: true } } })
  const text = buildNotices(f.root)
  assert.match(text, /## runtime@1\.0\.0/)
  assert.doesNotMatch(text, /## absent|## optionalPeer/)
})
