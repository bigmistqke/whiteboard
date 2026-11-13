// Templates come from the project's `.visualize/config.ts`. It is loaded through Vite, so it can
// be TypeScript and import template packages from the project's own node_modules.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = /^[\w-]+$/

/** A template file reference (URL, file: URL string, or absolute path) → absolute path. */
function toPath(ref, field, template) {
  if (ref == null) return null
  if (ref instanceof URL || (typeof ref === 'string' && ref.startsWith('file:'))) return fileURLToPath(ref)
  if (typeof ref === 'string' && path.isAbsolute(ref)) return ref
  throw new Error(`template "${template}": ${field} must be a URL, e.g. new URL('./${field}.js', import.meta.url)`)
}

function flatten(entries, out = []) {
  for (const e of entries ?? []) {
    if (!e) continue
    if (Array.isArray(e)) flatten(e, out)
    else out.push(e)
  }
  return out
}

/** Check and resolve one template object into what the renderer uses. */
function normalize(t, source) {
  if (typeof t !== 'object' || !t) throw new Error(`a template entry in ${source} is not an object`)
  if (!NAME.test(t.name ?? '')) throw new Error(`template name ${JSON.stringify(t.name)} in ${source}: use letters, digits, - and _`)
  const files = {
    client: toPath(t.client, 'client', t.name),
    style: toPath(t.style, 'style', t.name),
    readme: toPath(t.readme, 'readme', t.name),
  }
  for (const [field, file] of Object.entries(files))
    if (file && !fs.existsSync(file)) throw new Error(`template "${t.name}": ${field} file not found: ${file}`)
  return {
    name: t.name,
    code: t.code === true,
    props: typeof t.props === 'function' ? t.props.bind(t) : null,
    html: typeof t.html === 'function' ? t.html.bind(t) : null,
    ...files,
    source,
  }
}

/**
 * The project's config, loaded through Vite (cached until invalidate()). Errors are returned, not
 * thrown. `code` is the template for code blocks no template claims by name: the last one with
 * `code: true`. `files` is false when the config turns the repository view off.
 * @param {import('vite').ViteDevServer} vite
 * @param {string} configFile
 */
export function createTemplateLoader(vite, configFile) {
  let cached = null

  async function load() {
    const mod = await vite.ssrLoadModule(configFile)
    let config = mod.default
    if (typeof config === 'function') config = await config()
    const templates = new Map()
    for (const t of flatten(config?.templates)) {
      const n = normalize(t, configFile)
      templates.set(n.name, n)
    }
    const code = [...templates.values()].findLast(t => t.code) ?? null
    return { templates, code, files: config?.files !== false }
  }

  /** @returns {Promise<{ templates: Map<string, object>, code: object | null, files: boolean, errors: Error[] }>} */
  function config() {
    cached ??= load().then(
      value => ({ ...value, errors: [] }),
      error => ({ templates: new Map(), code: null, files: false, errors: [error] }),
    )
    return cached
  }

  return { config, invalidate: () => { cached = null } }
}
