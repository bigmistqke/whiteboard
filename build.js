// Builds what the package ships as JavaScript, into dist/:
//
//   dist/client/main.js        the page runtime, one browser module (morphdom included)
//   dist/define.js             ./config and ./template: defineConfig, defineTemplate
//   dist/basic/…               ./basic, module for module, with each template's style and readme
//   dist/basic/<t>/client.js   a template's browser code: one module with Solid included
//   dist/solid/index.js        ./solid, for template packages that bundle it themselves
//
// The engine itself (src/*.js, bin/) is plain JavaScript and runs as it is. Node runs TypeScript
// of its own, but not inside node_modules, which is where an installed package lives: so anything a
// project imports from this package is built. `node build.js --watch` rebuilds on change.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, watch } from 'rolldown'
import { transform } from '@solidjs/compiler'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, 'dist')
const at = (...p) => path.join(ROOT, ...p)

/** Compile Solid JSX; rolldown strips the types that are left. */
const solidJsx = () => ({
  name: 'solid-jsx',
  transform: {
    filter: { id: /\.[jt]sx$/ },
    handler(code, id) {
      const out = transform(code, { filename: id, generate: 'dom', moduleName: '@solidjs/web' })
      return { code: out.code, map: out.map ?? null, moduleType: id.endsWith('.tsx') ? 'ts' : 'js' }
    },
  },
})

const bare = id => !id.startsWith('.') && !path.isAbsolute(id)

const clients = fs.readdirSync(at('basic'), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(at('basic', e.name, 'client.tsx')))
  .map(e => e.name)

const builds = [
  // the page runtime
  {
    input: at('src/client/main.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'client/main.js'), format: 'esm' },
  },
  // what configs and template packages import on the server, module for module so that
  // new URL('./style.css', import.meta.url) still points next to the module
  {
    input: { define: at('src/define.ts'), 'basic/index': at('basic/index.ts'), ...Object.fromEntries(
      fs.readdirSync(at('basic'), { withFileTypes: true }).filter(e => e.isDirectory())
        .map(e => [`basic/${e.name}/index`, at('basic', e.name, 'index.ts')]),
    ) },
    platform: 'node',
    external: id => bare(id) || id.startsWith('node:'),
    output: { dir: DIST, format: 'esm', preserveModules: true, preserveModulesRoot: ROOT, entryFileNames: '[name].js' },
  },
  // each template's browser code as one module: Solid and the adapter included, so it needs
  // nothing from the page to run
  ...clients.map(name => ({
    input: at('basic', name, 'client.tsx'),
    platform: 'browser',
    resolve: { alias: { '@bigmistqke/whiteboard/solid': at('solid/index.tsx') } },
    plugins: [solidJsx()],
    output: { file: path.join(DIST, 'basic', name, 'client.js'), format: 'esm', minify: true },
  })),
  // the Solid adapter, for template packages: Solid stays theirs to bundle
  {
    input: at('solid/index.tsx'),
    platform: 'browser',
    external: bare,
    plugins: [solidJsx()],
    output: { file: path.join(DIST, 'solid/index.js'), format: 'esm' },
  },
]

/** Styles and readmes sit next to the template modules that point at them. */
function copyAssets() {
  for (const e of fs.readdirSync(at('basic'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    for (const f of fs.readdirSync(at('basic', e.name))) {
      if (!/\.(css|md)$/.test(f)) continue
      fs.mkdirSync(path.join(DIST, 'basic', e.name), { recursive: true })
      fs.copyFileSync(at('basic', e.name, f), path.join(DIST, 'basic', e.name, f))
    }
  }
}

const options = b => ({ ...b, logLevel: 'warn', transform: { define: { 'process.env.NODE_ENV': '"production"' } } })

if (process.argv.includes('--watch')) {
  copyAssets()
  const watcher = watch(builds.map(options))
  watcher.on('event', e => {
    if (e.code === 'BUNDLE_END') { copyAssets(); e.result?.close() }
    if (e.code === 'ERROR') { console.error(e.error?.message ?? e.error); e.result?.close() }
  })
  console.log('build: watching')
} else {
  fs.rmSync(DIST, { recursive: true, force: true })
  for (const b of builds) await build(options(b))
  copyAssets()
  console.log(`build: ${path.relative(process.cwd(), DIST) || DIST}`)
}
