// markboard's templates: its own and those passed to markboard({ templates }), checked and resolved into
// what the markdown renderer uses.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Html } from '../src/html.ts'

const NAME = /^[\w-]+$/

/** A template as the renderer uses it: checked, with its files as absolute paths. */
export interface ResolvedTemplate {
  name: string
  /** the template for code blocks in general */
  code: boolean
  props: ((ctx: any) => unknown) | null
  html: ((ctx: any) => string | Html | null | Promise<string | Html | null>) | null
  client: string | null
  style: string | null
  readme: string | null
  /** where it came from: `markboard`, or `markboard({ templates })` */
  source: string
}

export interface ResolvedTemplates { templates: Map<string, ResolvedTemplate>; code: ResolvedTemplate | null }

/** A template file reference (URL, file: URL string, or absolute path) → absolute path. */
function toPath(ref: unknown, field: string, template: string): string | null {
  if (ref == null) return null
  if (ref instanceof URL || (typeof ref === 'string' && ref.startsWith('file:'))) return fileURLToPath(ref)
  if (typeof ref === 'string' && path.isAbsolute(ref)) return ref
  throw new Error(`template "${template}": ${field} must be a URL, e.g. new URL('./${field}.js', import.meta.url)`)
}

function flatten(entries: unknown, out: any[] = []): any[] {
  for (const e of (entries as unknown[]) ?? []) {
    if (!e) continue
    if (Array.isArray(e)) flatten(e, out)
    else out.push(e)
  }
  return out
}

/** Check and resolve one template object into what the renderer uses. */
function normalize(t: any, source: string): ResolvedTemplate {
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
 * Resolve groups of template entries, `source` naming where they came from. Later entries replace
 * earlier ones with the same name. `code` is the template for code blocks no template claims by
 * name: the last one with `code: true`.
 */
export function resolveTemplates(groups: { entries: unknown; source: string }[]): ResolvedTemplates {
  const templates = new Map<string, ResolvedTemplate>()
  for (const { entries, source } of groups) {
    for (const t of flatten(entries)) {
      const n = normalize(t, source)
      templates.set(n.name, n)
    }
  }
  return { templates, code: [...templates.values()].findLast(t => t.code) ?? null }
}
