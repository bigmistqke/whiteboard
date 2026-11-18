// Builds what the package ships as JavaScript, into dist/:
//
//   dist/client/runtime.js         the core in the browser: events, live channel, hand-over to the page
//   dist/define.js                 the package's entry: defineConfig, definePlugin
//   dist/bin/, dist/src/           the engine: the command line and the server, module for module
//   dist/src/client/page/main.js   the page in the browser, one module (morphdom included), and
//                                  its base.css
//   dist/plugins/<name>/…          each plugin, module for module, with its readme; in its public/,
//                                  its browser files: its styles, and its browser code as one module
//                                  (Solid included for a client.tsx)
//   dist/plugins/terminal/         also the terminal's host, and its public/style.css with xterm's
//   dist/solid/index.js            ./solid, for plugins that bundle it themselves
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
      return {
        code: out.code,
        map: out.map ?? null,
        moduleType: id.endsWith('.tsx') ? ('ts' as const) : ('js' as const),
      }
    },
  },
})

const bare = (id: string) => !id.startsWith('.') && !path.isAbsolute(id)

const pluginDirs = fs
  .readdirSync(at('plugins'), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(at('plugins', e.name, 'index.ts')))
  .map(e => e.name)
// browser code written as Solid components (a block's client), and as plain modules (a page module)
const solidClients = pluginDirs.filter(name => fs.existsSync(at('plugins', name, 'client.tsx')))
const plainClients = pluginDirs.filter(name => fs.existsSync(at('plugins', name, 'client.ts')))

const builds: BuildOptions[] = [
  // the core in the browser
  {
    input: at('src/client/runtime.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'client/runtime.js'), format: 'esm' },
  },
  // plugins' browser modules written as plain modules (the terminal drawer, comments)
  ...plainClients.map((name): BuildOptions => ({
    input: at('plugins', name, 'client.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'plugins', name, 'public', 'client.js'), format: 'esm', minify: true },
  })),
  // the page in the browser
  {
    input: at('src/client/page/main.ts'),
    platform: 'browser',
    output: { file: path.join(DIST, 'src/client/page/main.js'), format: 'esm' },
  },
  // what configs and template packages import on the server, module for module so that
  // new URL('./style.css', import.meta.url) still points next to the module
  {
    input: {
      define: at('src/define.ts'),
      // the engine, and the plugins that ship with it; the terminal's host is started by its path
      'bin/whiteboard': at('bin/whiteboard.ts'),
      'plugins/index': at('plugins/index.ts'),
      ...Object.fromEntries(pluginDirs.map(name => [`plugins/${name}/index`, at('plugins', name, 'index.ts')])),
      'plugins/terminal/host': at('plugins/terminal/host.ts'),
    },
    platform: 'node',
    // the helpers the compiler adds (a tagged template holding </script> is rewritten with one) are
    // bundled in: the package doesn't depend on them
    external: (id: string) => (bare(id) && !id.startsWith('@oxc-project/runtime')) || id.startsWith('node:'),
    output: { dir: DIST, format: 'esm', preserveModules: true, preserveModulesRoot: ROOT, entryFileNames: '[name].js' },
  },
  // a block's browser code written in Solid, as one module: Solid and the adapter included, so it
  // needs nothing from the page to run
  ...solidClients.map((name): BuildOptions => ({
    input: at('plugins', name, 'client.tsx'),
    platform: 'browser',
    resolve: { alias: { '@bigmistqke/whiteboard/solid': at('solid/index.tsx') } },
    plugins: [solidJsx()],
    output: { file: path.join(DIST, 'plugins', name, 'public', 'client.js'), format: 'esm', minify: true },
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

/**
 * Styles and readmes sit next to the modules that point at them; a plugin's public/ folder (its
 * browser files: styles, images, fonts) is copied whole into its built public/, beside its built
 * client module.
 */
function copyAssets() {
  const copyDir = (from: string, to: string) => {
    for (const f of fs.readdirSync(at(from))) {
      if (!/\.(css|md)$/.test(f)) continue
      fs.mkdirSync(path.join(DIST, to), { recursive: true })
      fs.copyFileSync(at(from, f), path.join(DIST, to, f))
    }
  }
  copyDir('src/client/page', 'src/client/page')
  for (const name of pluginDirs) {
    copyDir(`plugins/${name}`, `plugins/${name}`)
    if (fs.existsSync(at('plugins', name, 'public')))
      fs.cpSync(at('plugins', name, 'public'), path.join(DIST, 'plugins', name, 'public'), { recursive: true })
  }
  // the drawer's styles after xterm's own
  fs.writeFileSync(
    path.join(DIST, 'plugins/terminal/public/style.css'),
    fs.readFileSync(at('node_modules/@xterm/xterm/css/xterm.css'), 'utf8') +
      '\n' +
      fs.readFileSync(at('plugins/terminal/public/style.css'), 'utf8'),
  )
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

const options = (b: BuildOptions): BuildOptions => ({
  ...b,
  logLevel: 'warn',
  transform: { define: { 'process.env.NODE_ENV': '"production"' } },
})

if (process.argv.includes('--watch')) {
  copyAssets()
  // a plugin's public/ files aren't part of a bundle: copied again when one changes
  for (const name of pluginDirs) {
    if (fs.existsSync(at('plugins', name, 'public')))
      fs.watch(at('plugins', name, 'public'), { recursive: true }, () => copyAssets())
  }
  const watcher = watch(builds.map(options))
  watcher.on('event', e => {
    if (e.code === 'BUNDLE_END') {
      copyAssets()
      e.result?.close()
    }
    if (e.code === 'ERROR') {
      console.error(e.error?.message ?? e.error)
      e.result?.close()
    }
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
