import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function dependencyPath(from, name) {
  let directory = from
  while (true) {
    const candidate = join(directory, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return realpathSync(dirname(candidate))
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export function buildNotices(root) {
  root = resolve(root)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packages = new Map()
  function visit(from, name, optional = false) {
    const directory = dependencyPath(from, name)
    if (!directory) {
      if (optional) return
      throw new Error(`Missing dependency for license inventory: ${name}`)
    }
    const data = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (data.name !== name) throw new Error(`Dependency identity mismatch: ${name}`)
    const id = `${data.name}@${data.version}`
    if (packages.has(id)) return
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name))
      .map(entry => entry.name).sort()
    if (!files.some(name => /^(licen[cs]e|copying)([.-]|$)/i.test(name))) {
      throw new Error(`Missing license text: ${id}`)
    }
    if (typeof data.license !== 'string') throw new Error(`Missing license identifier: ${id}`)
    const texts = files.map(name => {
      const text = readFileSync(join(directory, name), 'utf8').replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '').trim()
      if (!text) throw new Error(`Empty license text: ${id}/${name}`)
      return `### ${name}\n\n${text}\n`
    })
    packages.set(id, { id, license: data.license, texts })
    for (const child of Object.keys(data.dependencies ?? {})) {
      visit(directory, child, child in (data.optionalDependencies ?? {}))
    }
    for (const child of Object.keys(data.optionalDependencies ?? {})) visit(directory, child, true)
    for (const child of Object.keys(data.peerDependencies ?? {})) {
      visit(directory, child, data.peerDependenciesMeta?.[child]?.optional === true)
    }
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) visit(root, name)
  for (const name of Object.keys(manifest.peerDependencies ?? {})) visit(root, name)
  for (const name of manifest.dshosBundledLibraries ?? []) visit(root, name)
  const rows = [...packages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const providerLicense = readFileSync(join(root, '../patches/dsh-deepseek-balance/LICENSE'), 'utf8')
    .replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '').trim()
  if (!providerLicense) throw new Error('Missing integrated provider license')
  return `# Third-party notices

Generated from the installed dependencies of the frozen connector lockfile by
\`node scripts/write-third-party-notices.mjs\`. Includes runtime and peer dependency
closures and bundled libraries; build-only tools are not distributed with the connector. Dependencies
installed separately by npm or DSH retain their own license files. The versions
below describe the audited build, not a promise that a future registry resolution
of a compatible dependency range will always select the same version.

Third-party copyright and contact details below are retained as upstream notices.
Third-party components retain the licenses listed below.

| Package | License |
| --- | --- |
${rows.map(row => `| \`${row.id}\` | ${row.license} |`).join('\n')}

## Integrated DSH provider extension

The package includes project-maintained derivatives of
\`@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2\`, \`0.1.5-rc.2\`, \`0.1.6-alpha.1\`, \`0.1.7-alpha.2\`, \`0.1.7-rc.2\`, \`0.2.0-rc.1\`, \`0.2.0-rc.2\` \`0.2.1-rc.2\` \`0.2.1-rc.3\`, \`0.2.1-rc.5\` and \`0.2.2-rc.1\`, with versions
\`0.1.1-rc.2-dshoslink.1\`, \`0.1.5-rc.2-dshoslink.1\`, \`0.1.6-alpha.1-dshoslink.1\`, \`0.1.7-alpha.2-dshoslink.1\`, \`0.1.7-rc.2-dshoslink.1\`, \`0.2.0-rc.1-dshoslink.1\`, \`0.2.0-rc.2-dshoslink.1\` \`0.2.1-rc.2-dshoslink.1\` \`0.2.1-rc.3-dshoslink.1\`, \`0.2.1-rc.5-dshoslink.1\` and \`0.2.2-rc.1-dshoslink.1\`. Only the component
matching the supported DSH runtime is installed. They add a normalized balance
query within DSH and are not official upstream releases. Their LICENSE and dshos-source.json retain
the upstream license and build provenance. Its externally installed dependencies
remain under their respective licenses in the DSH installation.

${providerLicense}

${rows.map(row => `## ${row.id}\n\n${row.texts.join('\n')}`).join('\n')}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const content = buildNotices(root)
  const destination = join(root, 'THIRD_PARTY_NOTICES.md')
  if (process.argv.slice(2).length === 0) {
    writeFileSync(destination, content)
  } else if (process.argv.slice(2).join(' ') === '--check') {
    if (readFileSync(destination, 'utf8').replaceAll('\r\n', '\n') !== content) {
      throw new Error('Third-party notices changed; regenerate and review before packing.')
    }
  } else {
    throw new Error('Usage: node scripts/write-third-party-notices.mjs [--check]')
  }
}
