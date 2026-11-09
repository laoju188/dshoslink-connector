import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

// Bundle the public pure preparation function so DSH cannot hoist its package
// into the host plugin graph. Sharp remains a normal native runtime dependency.
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
if (manifest.dependencies['@deepseek-ai/dsh-attachment-local'] !== undefined
  || manifest.devDependencies['@deepseek-ai/dsh-attachment-local'] !== '0.1.5-rc.1'
  || manifest.dependencies.sharp !== '0.35.4') throw new Error('Unexpected image preparation dependencies')
const result = await build({
  entryPoints: ['src/session-image-prepare.ts'], outfile: 'dist/session-image-prepare.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['sharp'], sourcemap: false, metafile: true,
  banner: { js: "import { createRequire as imageCreateRequire } from 'node:module'; const require = imageCreateRequire(import.meta.url);" },
})
for (const output of Object.values(result.metafile.outputs)) {
  if (output.imports.some(item => item.external && item.path !== 'sharp' && !item.path.startsWith('node:'))) {
    throw new Error('Image preparation must not import DSH host packages at runtime')
  }
}
