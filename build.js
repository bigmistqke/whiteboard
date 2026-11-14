// Builds what the package ships as JavaScript, into dist/:
//
//   dist/client/runtime.js     the core in the browser: events, live channel, hand-over to a renderer
//   dist/define.js             ./config: defineConfig, defineRenderer
//   dist/markboard/…               ./markboard (the renderer) and ./template, module for module, with
//                              each template's style and readme
//   dist/markboard/client/main.js  markboard in the browser, one module (morphdom included)
//   dist/markboard/<t>/client.js   a template's browser code: one module with Solid included
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

const templateDirs = fs.readdirSync(at('markboard'), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(at('markboard', e.name, 'index.ts')))
  .map(e => e.name)
const clients = templateDirs.filter(name => fs.existsSync(at('markboard', name, 'client.tsx')))

const builds = [
  // the core in the browser
  {
    input: at('src/client/runtime.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'client/runtime.js'), format: 'esm' },
  },
  // markboard in the browser
  {
    input: at('markboard/client/main.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'markboard/client/main.js'), format: 'esm' },
  },
  // what configs and template packages import on the server, module for module so that
  // new URL('./style.css', import.meta.url) still points next to the module
  {
    input: {
      define: at('src/define.ts'),
      'markboard/index': at('markboard/index.ts'),
      'markboard/types': at('markboard/types.ts'),
      ...Object.fromEntries(templateDirs.map(name => [`markboard/${name}/index`, at('markboard', name, 'index.ts')])),
    },
    platform: 'node',
    external: id => bare(id) || id.startsWith('node:'),
    output: { dir: DIST, format: 'esm', preserveModules: true, preserveModulesRoot: ROOT, entryFileNames: '[name].js' },
  },
  // each template's browser code as one module: Solid and the adapter included, so it needs
  // nothing from the page to run
  ...clients.map(name => ({
    input: at('markboard', name, 'client.tsx'),
    platform: 'browser',
    resolve: { alias: { '@bigmistqke/whiteboard/solid': at('solid/index.tsx') } },
    plugins: [solidJsx()],
    output: { file: path.join(DIST, 'markboard', name, 'client.js'), format: 'esm', minify: true },
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
  for (const e of fs.readdirSync(at('markboard'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue  // client/ holds base.css
    for (const f of fs.readdirSync(at('markboard', e.name))) {
      if (!/\.(css|md)$/.test(f)) continue
      fs.mkdirSync(path.join(DIST, 'markboard', e.name), { recursive: true })
      fs.copyFileSync(at('markboard', e.name, f), path.join(DIST, 'markboard', e.name, f))
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
