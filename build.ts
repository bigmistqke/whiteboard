// Builds what the package ships as JavaScript, into dist/:
//
//   dist/client/runtime.js     the core in the browser: events, live channel, hand-over to a renderer
//   dist/terminal/client.js    the terminal drawer (xterm included), and style.css with xterm's styles
//   dist/comments/client.js    comments in the browser, and their style.css
//   dist/define.js             ./config: defineConfig, defineRenderer
//   dist/bin/, dist/src/       the engine: the command line and the server, module for module
//   dist/terminal/, dist/comments/, dist/claude-code/   the plugins' server side, and the terminal's host
//   dist/markboard/…               ./markboard (the renderer) and ./template, module for module, with
//                              each template's style and readme
//   dist/markboard/client/main.js  markboard in the browser, one module (morphdom included)
//   dist/markboard/<t>/client.js   a template's browser code: one module with Solid included
//   dist/solid/index.js        ./solid, for template packages that bundle it themselves
//
// Node runs TypeScript of its own, but not inside node_modules, which is where an installed package
// lives: so everything the package runs is built, the engine included. In this repository everything
// on the server can run from source instead (bin/whiteboard.ts, which then loads the `source`
// exports); only browser code is always built. `node build.ts --watch` rebuilds on change.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, watch, type BuildOptions, type Plugin } from 'rolldown'
import { transform } from '@solidjs/compiler'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, 'dist')
const at = (...p: string[]) => path.join(ROOT, ...p)

/** Compile Solid JSX; rolldown strips the types that are left. */
const solidJsx = (): Plugin => ({
  name: 'solid-jsx',
  transform: {
    filter: { id: /\.[jt]sx$/ },
    handler(code: string, id: string) {
      const out = transform(code, { filename: id, generate: 'dom', moduleName: '@solidjs/web' })
      return { code: out.code, map: out.map ?? null, moduleType: id.endsWith('.tsx') ? 'ts' as const : 'js' as const }
    },
  },
})

const bare = (id: string) => !id.startsWith('.') && !path.isAbsolute(id)

const templateDirs = fs.readdirSync(at('markboard'), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(at('markboard', e.name, 'index.ts')))
  .map(e => e.name)
const clients = templateDirs.filter(name => fs.existsSync(at('markboard', name, 'client.tsx')))

const builds: BuildOptions[] = [
  // the core in the browser
  {
    input: at('src/client/runtime.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'client/runtime.js'), format: 'esm' },
  },
  // the terminal drawer
  {
    input: at('terminal/client.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'terminal/client.js'), format: 'esm', minify: true },
  },
  // comments in the browser
  {
    input: at('comments/client.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'comments/client.js'), format: 'esm' },
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
      // the engine, and the plugins that ship with it; the terminal's host is started by its path
      'bin/whiteboard': at('bin/whiteboard.ts'),
      'terminal/index': at('terminal/index.ts'),
      'terminal/host': at('terminal/host.ts'),
      'comments/index': at('comments/index.ts'),
      'claude-code/index': at('claude-code/index.ts'),
    },
    platform: 'node',
    // the helpers the compiler adds (a tagged template holding </script> is rewritten with one) are
    // bundled in: the package doesn't depend on them
    external: (id: string) => (bare(id) && !id.startsWith('@oxc-project/runtime')) || id.startsWith('node:'),
    output: { dir: DIST, format: 'esm', preserveModules: true, preserveModulesRoot: ROOT, entryFileNames: '[name].js' },
  },
  // each template's browser code as one module: Solid and the adapter included, so it needs
  // nothing from the page to run
  ...clients.map((name): BuildOptions => ({
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
  // the drawer's styles after xterm's own
  fs.mkdirSync(path.join(DIST, 'terminal'), { recursive: true })
  fs.writeFileSync(path.join(DIST, 'terminal/style.css'),
    fs.readFileSync(at('node_modules/@xterm/xterm/css/xterm.css'), 'utf8') + '\n' + fs.readFileSync(at('terminal/style.css'), 'utf8'))
  fs.mkdirSync(path.join(DIST, 'comments'), { recursive: true })
  fs.copyFileSync(at('comments/style.css'), path.join(DIST, 'comments/style.css'))
  for (const e of fs.readdirSync(at('markboard'), { withFileTypes: true })) {
    if (!e.isDirectory()) continue  // client/ holds base.css
    for (const f of fs.readdirSync(at('markboard', e.name))) {
      if (!/\.(css|md)$/.test(f)) continue
      fs.mkdirSync(path.join(DIST, 'markboard', e.name), { recursive: true })
      fs.copyFileSync(at('markboard', e.name, f), path.join(DIST, 'markboard', e.name, f))
    }
  }
}

/** Remove files under `dir` older than `since` (left from an earlier build), and folders left empty. */
function prune(dir: string, since: number) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name)
    if (e.isDirectory()) {
      prune(file, since)
      if (!fs.readdirSync(file).length) fs.rmdirSync(file)
    } else if (fs.statSync(file).mtimeMs < since) fs.unlinkSync(file)
  }
}

const options = (b: BuildOptions): BuildOptions => ({ ...b, logLevel: 'warn', transform: { define: { 'process.env.NODE_ENV': '"production"' } } })

if (process.argv.includes('--watch')) {
  copyAssets()
  const watcher = watch(builds.map(options))
  watcher.on('event', e => {
    if (e.code === 'BUNDLE_END') { copyAssets(); e.result?.close() }
    if (e.code === 'ERROR') { console.error(e.error?.message ?? e.error); e.result?.close() }
  })
  console.log('build: watching')
} else {
  // A running server watches dist/ and reloads from it while this runs, so dist/ is never emptied:
  // stylesheets and readmes come first (template modules point at them), bundles overwrite their
  // files in place, and only then are files that this build didn't write removed.
  const started = Date.now()
  copyAssets()
  for (const b of builds) await build(options(b))
  prune(DIST, started)
  console.log(`build: ${path.relative(process.cwd(), DIST) || DIST}`)
}
