// The project's config: its renderers, its extensions and whether it serves the repository's files. Node loads it
// (see load.js), so it can be TypeScript and import renderer packages from the project's own
// node_modules.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { importFresh } from './load.js'
import { extensionCommands } from './extensions.js'

const NAME = /^[\w-]+$/
/** The command line's own commands: an extension can't be named like one, since its commands are `whiteboard <name>`. */
export const BUILTIN_COMMANDS = new Set(['serve', 'init', 'root', 'new', 'show', 'url', 'docs', 'events', 'wait', 'watch', 'append', 'status', 'skill', 'help'])
// folders in .whiteboard/ that are the core's, and the built-in commands
const RESERVED = new Set(['pages', 'delivered', ...BUILTIN_COMMANDS])

/** An extension's own folder, `.whiteboard/<name>/`, made with a .gitignore that ignores all of it. */
export function extensionDir(wb, name) {
  const dir = path.join(wb, name)
  fs.mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, `# what the ${name} extension keeps; not for git\n*\n`)
  return dir
}

/** A file reference (URL, file: URL string, or absolute path) → absolute path. */
export function toPath(ref) {
  if (ref instanceof URL || (typeof ref === 'string' && ref.startsWith('file:'))) return fileURLToPath(ref)
  return String(ref)
}

function normalize(r, source) {
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
 * The config, cached until invalidate() (which loads it afresh). Errors are returned, not thrown:
 * a config that fails to load leaves the project without renderers, so pages show as raw text,
 * and serves no repository files.
 */
export function createConfigLoader(configFile) {
  let cached = null

  async function load() {
    const mod = await importFresh(configFile)
    let config = mod.default
    if (typeof config === 'function') config = await config()
    const renderers = []
    for (const r of [config?.renderers ?? []].flat(Infinity)) {
      if (!r) continue
      const n = normalize(r, configFile)
      if (renderers.some(x => x.name === n.name)) throw new Error(`two renderers are named "${n.name}" in ${configFile}`)
      renderers.push(n)
    }
    const extensions = []
    for (const e of [config?.extensions ?? []].flat(Infinity)) {
      if (!e) continue
      if (typeof e !== 'object' || !NAME.test(e.name ?? '')) throw new Error(`an extension in ${configFile} needs a name: letters, digits, - and _`)
      if (RESERVED.has(e.name)) throw new Error(`extension name "${e.name}" in ${configFile} is taken by the core (a folder in .whiteboard/ or a command)`)
      extensionCommands(e) // checks them
      if (extensions.some(x => x.name === e.name)) throw new Error(`two extensions are named "${e.name}" in ${configFile}`)
      extensions.push(e)
    }
    return { renderers, extensions, files: config?.files !== false }
  }

  /** @returns {Promise<{ renderers: object[], extensions: object[], files: boolean, errors: Error[] }>} */
  function config() {
    cached ??= load().then(
      value => ({ ...value, errors: [] }),
      error => ({ renderers: [], extensions: [], files: false, errors: [error] }),
    )
    return cached
  }

  return { config, invalidate: () => { cached = null } }
}
