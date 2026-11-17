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
// folders in .whiteboard/ that are the core's, and the built-in commands
const RESERVED = new Set(['pages', 'delivered', ...BUILTIN_COMMANDS])

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

/**
 * The renderers of a config that names none: markboard, the one this package ships. A config that
 * lists renderers gets only those, so `renderers: []` still shows every page as its raw text.
 */
async function defaultRenderers(): Promise<Renderer[]> {
  // afresh with every load of the config, like what a config imports itself, so it reloads too
  const { default: markboard } = await importOwn('markboard')
  return [markboard()]
}

/**
 * The config, cached until invalidate() (which loads it afresh). Errors are returned, not thrown:
 * a config that fails to load leaves the project without renderers, so pages show as raw text,
 * and serves no repository files.
 *
 * `renderers: false` leaves out the default renderer when the config names none, for the command
 * line, which only needs the plugins: then markboard is loaded only if the config imports it.
 */
export function createConfigLoader(proj: Project, { renderers: withRenderers = true } = {}) {
  let cached: Promise<LoadedConfig> | null = null

  async function load(): Promise<Omit<LoadedConfig, 'errors'>> {
    // no config file: the defaults, the same as an empty config
    const configFile = proj.configFile
    const mod = configFile ? await importFresh(configFile) : { default: {} }
    // a config can also be a function that returns one
    const exported: Config | (() => Config | Promise<Config>) = mod.default
    const config: Config = typeof exported === 'function' ? await exported() : exported
    const renderers: LoadedRenderer[] = []
    for (const r of [config?.renderers ?? (withRenderers ? await defaultRenderers() : [])].flat(Infinity) as Renderer[]) {
      if (!r) continue
      const n = normalize(r, configFile)
      if (renderers.some(x => x.name === n.name)) throw new Error(`two renderers are named "${n.name}" in ${configFile}`)
      renderers.push(n)
    }
    const plugins: Plugin[] = []
    for (const e of [config?.plugins ?? []].flat(Infinity) as Plugin[]) {
      if (!e) continue
      if (typeof e !== 'object' || !NAME.test(e.name ?? '')) throw new Error(`a plugin in ${configFile} needs a name: letters, digits, - and _`)
      if (RESERVED.has(e.name)) throw new Error(`plugin name "${e.name}" in ${configFile} is taken by the core (a folder in .whiteboard/ or a command)`)
      pluginCommands(e) // checks them
      if (plugins.some(x => x.name === e.name)) throw new Error(`two plugins are named "${e.name}" in ${configFile}`)
      plugins.push(e)
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
