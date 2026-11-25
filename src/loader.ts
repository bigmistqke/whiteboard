// The project's config: its plugins, its stylesheet and whether it serves the repository's files.
// Node loads it (see load.ts), so it can be TypeScript and import plugins from the project's own
// node_modules. What the loader makes of it: the plugins (the built-in ones, then the config's), and
// the pages (how markdown is rendered with their blocks).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importFresh, importOwn } from './load.ts'
import { createPages, type Pages } from './pages/index.ts'
import { pluginCommands } from './plugins.ts'
import { inPublic, publicDirOf } from './public.ts'
import type { BuildConfig, Config, Plugin } from './define.ts'
import type { Project } from './config.ts'

/** A config as loaded: what went wrong is in `errors`. */
export interface LoadedConfig {
  /** how pages render, with the plugins' blocks; null when the config failed to load, or for the command line */
  pages: Pages | null
  plugins: Plugin[]
  /** the plugins' event types declared `handOut: true`: those that reach an agent unasked */
  handedOut: Set<string>
  /** the plugins' event types declared `forReader: true`: from the agent, a message for the reader */
  forReader: Set<string>
  /** each plugin's public folder, by name: the one place its browser files are served from */
  publicDirs: Map<string, string>
  files: boolean
  /** what `whiteboard build` makes */
  build: BuildConfig
  errors: unknown[]
}

const NAME = /^[\w-]+$/
/** The command line's own commands: a plugin can't be named like one, since its commands are `whiteboard <name>`. */
export const BUILTIN_COMMANDS = new Set([
  'serve',
  'init',
  'root',
  'new',
  'claim',
  'show',
  'url',
  'docs',
  'events',
  'wait',
  'watch',
  'append',
  'handled',
  'status',
  'scroll',
  'close',
  'prune',
  'build',
  'edit',
  'skill',
  'paths',
  'help',
])
// folders in .whiteboard/ that are the core's or meant for the project's own plugins (a plugin's own
// folder holds its data, ignored by git), and the built-in commands
const RESERVED = new Set(['pages', 'plugins', ...BUILTIN_COMMANDS])

/** A plugin's own folder, `.whiteboard/<name>/`, made with a .gitignore that ignores all of it. */
export function pluginDir(wb: string, name: string): string {
  const dir = path.join(wb, name)
  fs.mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, `# what the ${name} plugin keeps; not for git\n*\n`)
  return dir
}

/** A file reference (URL, file: URL string, or absolute path) → absolute path. */
export function toPath(ref: unknown): string {
  if (ref instanceof URL || (typeof ref === 'string' && ref.startsWith('file:'))) return fileURLToPath(ref)
  return String(ref)
}

/** The built-in plugins, afresh with every load of the config, like what a config imports itself. */
async function builtinPlugins(): Promise<Plugin[]> {
  const { builtins } = await importOwn('plugins')
  return builtins()
}

/** Check a plugin, as the config gives it. */
function checkPlugin(e: Plugin, where: string | null) {
  if (typeof e !== 'object' || !NAME.test(e?.name ?? ''))
    throw new Error(`a plugin in ${where} needs a name: letters, digits, - and _`)
  if (RESERVED.has(e.name))
    throw new Error(`plugin name "${e.name}" in ${where} is taken by the core (a folder in .whiteboard/ or a command)`)
  pluginCommands(e) // checks them
  for (const type of Object.keys(e.events ?? {}))
    if (!type.startsWith(`${e.name}:`) || type.length <= e.name.length + 1)
      throw new Error(`plugin ${e.name}: event type "${type}" must be named after it: ${e.name}:<what>`)
}

/**
 * The config, cached until invalidate() (which loads it afresh). Errors are returned, not thrown:
 * a config that fails to load leaves the project without its plugins, so pages show as raw text,
 * and serves no repository files.
 *
 * The project's plugins are the built-in ones, then the config's: one with a built-in's name
 * replaces it. Their blocks make the pages. `pages: false` leaves the pages out, for the command
 * line, which only needs the plugins (their commands, the session, their events).
 */
export function createConfigLoader(proj: Project, { pages: withPages = true } = {}) {
  let cached: Promise<LoadedConfig> | null = null

  async function load(): Promise<Omit<LoadedConfig, 'errors'>> {
    // no config file: the defaults, the same as an empty config
    const configFile = proj.configFile
    const mod = configFile ? await importFresh(configFile) : { default: {} }
    // a config can also be a function that returns one
    const exported: Config | (() => Config | Promise<Config>) = mod.default
    const config: Config = typeof exported === 'function' ? await exported() : exported
    const plugins: Plugin[] = await builtinPlugins()
    const builtin = new Set(plugins.map(p => p.name))
    const added = new Set<string>()
    for (const e of [config?.plugins ?? []].flat(Infinity) as Plugin[]) {
      if (!e) continue
      checkPlugin(e, configFile)
      if (added.has(e.name)) throw new Error(`two plugins are named "${e.name}" in ${configFile}`)
      added.add(e.name)
      // one with a built-in's name replaces it, in its place
      if (builtin.has(e.name)) plugins[plugins.findIndex(p => p.name === e.name)] = e
      else plugins.push(e)
    }
    // each plugin's browser files are served from its public folder alone: its files are named in it
    const publicDirs = new Map(plugins.map(p => [p.name, publicDirOf(p, proj.wb)]))
    const blocks = plugins.flatMap(p =>
      Object.entries(p.blocks ?? {}).map(([name, block]) => ({
        name,
        block,
        plugin: p.name,
        public: publicDirs.get(p.name)!,
      })),
    )
    const styles = plugins
      .filter(p => p.style)
      .map(p => ({ plugin: p.name, file: inPublic(publicDirs.get(p.name)!, p.style!, `plugin ${p.name}: style`) }))
    const links = plugins.flatMap(p => (p.links ? [p.links.bind(p)] : []))
    // the plugins that compose themselves around other blocks (Plugin.compose): a block with an
    // attribute of their name
    const composers = new Map(
      plugins.flatMap(p => (typeof p.compose === 'function' ? [[p.name, p.compose.bind(p)] as const] : [])),
    )
    const pages = withPages ? createPages({ blocks, style: config?.style, styles, links, composers }) : null
    const declared = (flag: 'handOut' | 'forReader') =>
      new Set(
        plugins.flatMap(p =>
          Object.entries(p.events ?? {})
            .filter(([, spec]) => spec?.[flag])
            .map(([type]) => type),
        ),
      )
    return {
      pages,
      plugins,
      handedOut: declared('handOut'),
      forReader: declared('forReader'),
      publicDirs,
      files: config?.files !== false,
      build: config?.build ?? {},
    }
  }

  function config(): Promise<LoadedConfig> {
    cached ??= load().then(
      value => ({ ...value, errors: [] }),
      error => ({
        pages: null,
        plugins: [],
        handedOut: new Set<string>(),
        forReader: new Set<string>(),
        publicDirs: new Map<string, string>(),
        files: false,
        build: {},
        errors: [error],
      }),
    )
    return cached
  }

  return {
    config,
    invalidate: () => {
      cached = null
    },
  }
}
