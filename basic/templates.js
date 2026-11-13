// basic's templates: its own and those passed to basic({ templates }), checked and resolved into
// what the markdown renderer uses.
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
 * Resolve groups of template entries ({ entries, source }), source naming where they came from. Later entries replace earlier ones with the same name. `code` is the
 * template for code blocks no template claims by name: the last one with `code: true`.
 * @returns {{ templates: Map<string, object>, code: object | null }}
 */
export function resolveTemplates(groups) {
  const templates = new Map()
  for (const { entries, source } of groups) {
    for (const t of flatten(entries)) {
      const n = normalize(t, source)
      templates.set(n.name, n)
    }
  }
  return { templates, code: [...templates.values()].findLast(t => t.code) ?? null }
}
