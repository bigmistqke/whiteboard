// The project's config: its renderers and whether it serves the repository's files. Node loads it
// (see load.js), so it can be TypeScript and import renderer packages from the project's own
// node_modules.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importFresh } from './load.js'

const NAME = /^[\w-]+$/

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
    if (config?.templates) throw new Error(`${configFile}: \`templates\` moved into the renderer: renderers: [basic({ templates: [...] })]`)
    return { renderers, files: config?.files !== false }
  }

  /** @returns {Promise<{ renderers: object[], files: boolean, errors: Error[] }>} */
  function config() {
    cached ??= load().then(
      value => ({ ...value, errors: [] }),
      error => ({ renderers: [], files: false, errors: [error] }),
    )
    return cached
  }

  return { config, invalidate: () => { cached = null } }
}
