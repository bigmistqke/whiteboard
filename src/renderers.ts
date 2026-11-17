// The project's config: its renderers, its plugins and whether it serves the repository's files. Node loads it
// (see load.ts), so it can be TypeScript and import renderer packages from the project's own
// node_modules.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importFresh, importOwn } from './load.ts'
import { pluginCommands } from './plugins.ts'
import type { Config, Plugin, RenderContext, Renderer, StoredPage } from './define.ts'
import type { Project } from './config.ts'

/** A renderer as the core uses it: its methods bound, its client a path. */
export interface LoadedRenderer {
  name: string
  render: Renderer['render'] | null
  docs: Renderer['docs'] | null
  expects: ((page: StoredPage, ctx: RenderContext) => string[] | Promise<string[]>) | null
  client: string | null
}

/** A config as loaded: what went wrong is in `errors`. */
export interface LoadedConfig {
  renderers: LoadedRenderer[]
  plugins: Plugin[]
  files: boolean
  errors: unknown[]
}

const NAME = /^[\w-]+$/
/** The command line's own commands: a plugin can't be named like one, since its commands are `whiteboard <name>`. */
export const BUILTIN_COMMANDS = new Set(['serve', 'init', 'root', 'new', 'show', 'url', 'docs', 'events', 'wait', 'watch', 'append', 'pick', 'status', 'skill', 'help'])
// folders in .whiteboard/ that are the core's or meant for the project's own code (plugins,
// templates, renderers: a plugin's folder holds its data, ignored by git), and the built-in commands
const RESERVED = new Set(['pages', 'plugins', 'templates', 'renderers', ...BUILTIN_COMMANDS])

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

function normalize(r: Renderer, source: string | null): LoadedRenderer {
  if (typeof r !== 'object' || !r) throw new Error(`a renderer in ${source} is not an object`)
  if (!NAME.test(r.name ?? '')) throw new Error(`renderer name ${JSON.stringify(r.name)} in ${source}: use letters, digits, - and _`)
  const client = r.client == null ? null : toPath(r.client)
  if (client && !fs.existsSync(client)) throw new Error(`renderer "${r.name}": client file not found: ${client}`)
  return {
    name: r.name,
    render: typeof r.render === 'function' ? r.render.bind(r) : null,
    docs: typeof r.docs === 'function' ? r.docs.bind(r) : null,
    expects: typeof r.expects === 'function' ? r.expects.bind(r) : null,
    client,
  }
}

/** The built-in plugins, afresh with every load of the config, like what a config imports itself. */
async function builtinPlugins(): Promise<Plugin[]> {
  const { builtins } = await importOwn('plugins')
  return builtins()
}

/** Check a plugin, as the config gives it. */
function checkPlugin(e: Plugin, where: string | null) {
  if (typeof e !== 'object' || !NAME.test(e?.name ?? '')) throw new Error(`a plugin in ${where} needs a name: letters, digits, - and _`)
  if (RESERVED.has(e.name)) throw new Error(`plugin name "${e.name}" in ${where} is taken by the core (a folder in .whiteboard/ or a command)`)
  pluginCommands(e) // checks them
}

/**
 * The config, cached until invalidate() (which loads it afresh). Errors are returned, not thrown:
 * a config that fails to load leaves the project without its plugins, so pages show as raw text,
 * and serves no repository files.
 *
 * The project's plugins are the built-in ones, then the config's: one with a built-in's name
 * replaces it. Their blocks make the markdown renderer. `builtins: false` leaves the built-ins and
 * the renderer out, for the command line, which only needs the config's plugins (their commands, the
 * session), so it doesn't load the highlighter and the rest.
 */
export function createConfigLoader(proj: Project, { builtins: withBuiltins = true } = {}) {
  let cached: Promise<LoadedConfig> | null = null

  async function load(): Promise<Omit<LoadedConfig, 'errors'>> {
    // no config file: the defaults, the same as an empty config
    const configFile = proj.configFile
    const mod = configFile ? await importFresh(configFile) : { default: {} }
    // a config can also be a function that returns one
    const exported: Config | (() => Config | Promise<Config>) = mod.default
    const config: Config = typeof exported === 'function' ? await exported() : exported
    const plugins: Plugin[] = withBuiltins ? await builtinPlugins() : []
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
    const renderers: LoadedRenderer[] = []
    if (withBuiltins) {
      const { default: markboard } = await importOwn('markboard')
      const blocks = plugins.flatMap(p => Object.entries(p.blocks ?? {}).map(([name, block]) => ({ name, block, plugin: p.name })))
      const styles = plugins.map(p => p.style).filter((s): s is URL | string => !!s)
      renderers.push(normalize(markboard({ blocks, style: config?.style, styles }), configFile))
    }
    return { renderers, plugins, files: config?.files !== false }
  }

  function config(): Promise<LoadedConfig> {
    cached ??= load().then(
      value => ({ ...value, errors: [] }),
      error => ({ renderers: [], plugins: [], files: false, errors: [error] }),
    )
    return cached
  }

  return { config, invalidate: () => { cached = null } }
}
