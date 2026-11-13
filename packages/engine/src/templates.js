// Templates come from config files: the optional global `<root>/config.ts` and each project's
// `.visualize/config.ts`. Configs are loaded through Vite, so they can be TypeScript and import
// template packages from the project's own node_modules.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globalConfigFile } from './config.js'

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
 * @param {import('vite').ViteDevServer} vite
 */
export function createTemplateLoader(vite) {
  const cache = new Map()

  async function load(file) {
    const mod = await vite.ssrLoadModule(file)
    let config = mod.default
    if (typeof config === 'function') config = await config()
    const templates = new Map()
    for (const t of flatten(config?.templates)) {
      const n = normalize(t, file)
      templates.set(n.name, n)
    }
    return { name: config?.name ?? null, templates }
  }

  /** Load a config file (cached until invalidate()). Errors are returned, not thrown. */
  function config(file) {
    if (!cache.has(file)) {
      cache.set(file, load(file).then(
        value => ({ ...value, error: null }),
        error => ({ name: null, templates: new Map(), error }),
      ))
    }
    return cache.get(file)
  }

  /**
   * Templates that apply to a project's pages (or, with no project, to the root's pages):
   * the global config's, replaced by name with the project's. `code` is the template for code
   * blocks no template claims by name: the last one with `code: true` that was not replaced.
   * @returns {Promise<{ templates: Map<string, object>, code: object | null, errors: Error[] }>}
   */
  async function forProject(project) {
    const files = [globalConfigFile(), project?.configFile].filter(Boolean)
    const loaded = await Promise.all(files.map(config))
    const templates = new Map()
    let code = null
    for (const c of loaded) for (const [name, t] of c.templates) {
      templates.set(name, t)
      if (t.code) code = t
    }
    if (code && templates.get(code.name) !== code) code = [...templates.values()].findLast(t => t.code) ?? null
    return { templates, code, errors: loaded.map(c => c.error).filter(Boolean) }
  }

  return { forProject, invalidate: () => cache.clear() }
}
