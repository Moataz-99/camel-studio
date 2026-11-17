// Builds the VS Code extension into vscode/ and packages it as a .vsix.
//   npm run vscode     (runs electron-vite build first for the UI bundle)
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ext = join(root, 'vscode')
const alias = { '@shared': join(root, 'src/shared') }

if (!existsSync(join(root, 'out/renderer/index.html'))) throw new Error('Run electron-vite build first (npm run vscode does).')

for (const dir of ['dist', 'media', 'catalog']) rmSync(join(ext, dir), { recursive: true, force: true })

// The extension host: the shared backend plus the VS Code shell, in one CommonJS file.
await build({
  entryPoints: [join(root, 'src/vscode/extension.ts')],
  outfile: join(ext, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  alias,
  sourcemap: false,
  logLevel: 'warning'
})

// The webview side of the bridge, loaded before the UI.
await build({
  entryPoints: [join(root, 'src/vscode/bridge.ts')],
  outfile: join(ext, 'media/bridge.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  alias,
  logLevel: 'warning'
})

// The same UI bundle the desktop app loads, and the offline Camel catalog.
cpSync(join(root, 'out/renderer'), join(ext, 'media'), { recursive: true })
cpSync(join(root, 'resources/catalog'), join(ext, 'catalog'), { recursive: true })

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
// The extension carries the app's version.
const manifest = join(ext, 'package.json')
writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/"version": "[^"]+"/, `"version": "${version}"`))
if (process.argv.includes('--no-package')) process.exit(0)
mkdirSync(join(root, 'dist'), { recursive: true })
const out = join(root, 'dist', `camel-studio-vscode-${version}.vsix`)
execFileSync(join(root, 'node_modules/.bin/vsce'), ['package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', out], { cwd: ext, stdio: 'inherit' })
console.log(`Packaged ${out}`)
