// Markdown → HTML, with directives and fences handed to templates.
//
// A template with a component becomes an island:
//   <div class="wb-island" data-wb-island="3">fallback html</div>
// and its props go into the `islands` map the page embeds for the client to mount.
// A template with only server.ts html() is inlined as static HTML.
import path from 'node:path'
import crypto from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { toString } from 'mdast-util-to-string'
import { html, raw, type Html } from '../src/html.ts'
import type { ResolvedTemplate } from './templates.ts'

/**
 * An mdast node, loosely: the pipeline hands nodes between remark, the directive plugin and
 * templates, and replaces some in place with `html` nodes.
 */
export interface MdNode {
  type: string
  children?: MdNode[]
  value?: string
  [key: string]: any
}

type LinkFor = (absolutePath: string) => string | null

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).freeze()
const toHast = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypeStringify, { allowDangerousHtml: true }).freeze()

/** `cols=3 open title="a b"` → { cols: '3', open: '', title: 'a b' } (bare words get '' like directive attrs) */
export function parseAttrs(s: unknown) {
  const out: Record<string, string> = {}
  for (const m of String(s ?? '').matchAll(/([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g))
    out[m[1]] = m[2] ? m[2].replace(/^["']|["']$/g, '') : ''
  return out
}

const DIRECTIVES = new Set(['containerDirective', 'leafDirective', 'textDirective'])
const PHRASING = new Set(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link', 'linkReference',
  'image', 'imageReference', 'footnoteReference', 'textDirective'])

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Point relative links and images at what they name on disk: each is resolved from the markdown
 * file's own folder and handed to `linkFor(absolutePath)`, which returns the URL that serves it
 * (or null to leave the link as written).
 */
function rewriteLinks(tree: MdNode, file: string, linkFor?: LinkFor) {
  if (!linkFor || !file) return
  const walk = (node: MdNode) => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.url &&
        !SCHEME.test(node.url) && !/^[/#]/.test(node.url)) {
      const [, target, rest] = /^([^?#]*)(.*)$/s.exec(node.url)!
      let decoded = target
      try { decoded = decodeURIComponent(target) } catch { /* keep as written */ }
      const url = decoded && linkFor(path.resolve(path.dirname(file), decoded))
      if (url) node.url = url + rest
    }
    node.children?.forEach(walk)
  }
  walk(tree)
}

/** Separate a directive's `[label]` (remark-directive stores it as a flagged first paragraph). */
function splitLabel(node: MdNode): { label: MdNode[] | null; children: MdNode[] } {
  const [head, ...rest] = node.children ?? []
  if (node.type === 'containerDirective' && head?.data?.directiveLabel) return { label: head.children ?? null, children: rest }
  if (node.type !== 'containerDirective') return { label: node.children?.length ? node.children : null, children: [] }
  return { label: null, children: node.children ?? [] }
}

const MARKER: Record<string, string> = { textDirective: ':', leafDirective: '::', containerDirective: ':::' }

function literalDirective(node: MdNode, label: MdNode[] | null) {
  const marker = MARKER[node.type]
  const attrs = Object.entries(node.attributes ?? {}).map(([k, v]) => (v ? `${k}="${v}"` : k)).join(' ')
  return `${marker}${node.name}${label ? `[${toString({ type: 'root', children: label } as any)}]` : ''}${attrs ? `{${attrs}}` : ''}`
}

/**
 * The forms a page asks the reader to answer, by name: `:::form{name=…}` containers and
 * hand-written <form name="…"> without an action. Parsed, so a form shown as an example inside a
 * code block doesn't count.
 */
export function formNames(source: string) {
  const tree = parser.parse(String(source ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')) as MdNode
  const names: string[] = []
  const walk = (node: MdNode) => {
    if (node.type === 'containerDirective' && node.name === 'form') {
      const attrs = node.attributes ?? {}
      names.push(attrs.name || attrs.id || 'form')
    } else if (node.type === 'html') {
      for (const m of (node.value ?? '').matchAll(/<form\b([^>]*)>/gi)) {
        if (/\baction\s*=/i.test(m[1])) continue
        const name = /\bname\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1])
        if (name) names.push(name[2] ?? name[3] ?? name[4])
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return [...new Set(names)]
}

export interface RenderOptions {
  page: string
  file: string
  /** a template by name, resolved (see templates.ts) */
  resolve: (name: string) => ResolvedTemplate | null
  /** the template for fences no template claims by name; without one they render as plain code */
  code?: ResolvedTemplate | null
  /** the URL that serves a file on disk, for relative links */
  linkFor?: LinkFor
}

export interface Island { template: string; client: string; props: unknown }

/**
 * Markdown (or an mdast root, rendered as it is) → HTML, with directives and fences handed to
 * templates. Returns the page's HTML, its first heading, the islands to mount and the templates'
 * stylesheets.
 */
export async function renderMarkdown(source: string | MdNode, { page, file, resolve, code = null, linkFor }: RenderOptions) {
  let nextId = 0
  const islands: Record<string, Island> = {}
  const keyCount: Record<string, number> = {}
  const used = new Map<string, ResolvedTemplate>()

  const stringify = (nodes: MdNode[]): string => {
    // inline content (a label, say) is one line: as children of the root, each node would be a block
    // of its own, separated by newlines, which show as spaces
    if (nodes.length && nodes.every(n => PHRASING.has(n.type))) {
      const out = toHast.stringify(toHast.runSync({ type: 'root', children: [{ type: 'paragraph', children: nodes }] } as any))
      return out.replace(/^<p>([\s\S]*)<\/p>$/, '$1')
    }
    return toHast.stringify(toHast.runSync({ type: 'root', children: nodes } as any))
  }
  /** Render mdast nodes to HTML. Transforms nested directives first; safe to call twice on the same nodes. */
  const toHtml = async (nodes: MdNode[]) => { await transform({ type: 'root', children: nodes }); return stringify(nodes) }

  async function sectionsOf(children: MdNode[]) {
    await transform({ type: 'root', children })
    const heads = children.filter(n => n.type === 'heading')
    if (!heads.length) {
      return {
        intro: '',
        sections: children.map(n => ({ title: null, text: null, html: stringify([n]) })),
      }
    }
    const depth = Math.min(...heads.map(h => h.depth))
    const out: { heading: MdNode; body: MdNode[] }[] = []
    const intro: MdNode[] = []
    let current: { heading: MdNode; body: MdNode[] } | null = null
    for (const n of children) {
      if (n.type === 'heading' && n.depth === depth) {
        current = { heading: n, body: [] }
        out.push(current)
      } else if (current) current.body.push(n)
      else intro.push(n)
    }
    return {
      intro: stringify(intro),
      sections: out.map(s => ({ title: stringify(s.heading.children ?? []), text: toString(s.heading as any), html: stringify(s.body) })),
    }
  }

  /** HTML into the markdown tree, where the rest of the pipeline takes it as it is: the one place it becomes a string. */
  const htmlNode = (markup: Html | string): MdNode => ({ type: 'html', value: String(markup) })

  /** A template's output for one directive or fence: static HTML, or an island around it. */
  async function run(template: ResolvedTemplate, ctx: any, fallback: () => Promise<Html | string>): Promise<Html> {
    used.set(template.name, template)
    try {
      // a template may return a string or an `html` result: either is HTML
      const own = template.html ? await template.html(ctx) : null
      const body = raw(own ?? (await fallback()))
      // the element is span or div, chosen here, never from input
      const tag = raw(ctx.kind === 'textDirective' ? 'span' : 'div')
      if (!template.client) return own != null ? body : html`<${tag} data-template="${ctx.name}">${body}</${tag}>`
      const props = template.props ? await template.props(ctx) : await ctx.defaults()
      const id = String(++nextId)
      islands[id] = { template: template.name, client: template.client, props }
      // stable across re-renders while template + props are unchanged, so the client keeps the mounted island
      const hash = crypto.createHash('sha1').update(template.name + '\0' + JSON.stringify(props)).digest('hex').slice(0, 12)
      const key = `${hash}-${(keyCount[hash] = (keyCount[hash] ?? 0) + 1)}`
      return html`<${tag} class="wb-island" data-template="${ctx.name}" data-wb-island="${id}" data-wb-key="${key}">${body}</${tag}>`
    } catch (err) {
      console.error(`template ${template.name}:`, err)
      return html`<pre class="wb-error">template "${template.name}" failed: ${(err as Error).message}</pre>`
    }
  }

  const parse = (src: string) => {
    const tree = parser.parse(String(src ?? '')) as MdNode
    rewriteLinks(tree, file, linkFor)
    return tree
  }
  const markdown = async (src: string) => toHtml(parse(src).children ?? [])
  const inline = async (src: string) => (await markdown(src)).trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1')
  const base = { page, file, dir: path.dirname(file), parseAttrs, toHtml, toString, markdown, inline }

  async function directive(node: MdNode): Promise<MdNode> {
    const { label, children } = splitLabel(node)
    const template = resolve(node.name)
    if (!template) {
      if (node.type === 'textDirective') return { type: 'text', value: literalDirective(node, label) }
      // an unknown directive still shows its content: a typo never breaks the page
      const labelHtml = label && html`<p class="wb-label"><strong>${raw(await toHtml(label))}</strong></p>`
      return htmlNode(html`<div class="wb-unknown" data-directive="${node.name}">${labelHtml}${raw(await toHtml(children))}</div>`)
    }
    const labelHtml = label ? await toHtml(label) : null
    let defaults: Promise<Record<string, unknown>> | undefined
    const ctx = {
      ...base,
      kind: node.type,
      name: node.name,
      attrs: { ...node.attributes },
      label: labelHtml,
      labelText: label ? toString({ type: 'root', children: label } as any) : null,
      children,
      node,
      sections: () => sectionsOf(children),
      defaults: () => (defaults ??= (async () => {
        const content = await toHtml(children)
        return { name: node.name, attrs: { ...node.attributes }, label: labelHtml, html: content, ...(await sectionsOf(children)) }
      })()),
    }
    return htmlNode(await run(template, ctx, () => toHtml(children)))
  }

  async function fence(node: MdNode): Promise<MdNode> {
    const lang: string | null = node.lang || null
    const plain = async () => html`<pre><code${lang && html` class="language-${lang}"`}>${node.value}</code></pre>`
    const template = (lang && resolve(lang)) || code
    if (!template) return htmlNode(await plain())
    const name = code && template === code && lang !== code.name ? code.name : lang
    const attrs = parseAttrs(node.meta)
    const ctx = {
      ...base,
      kind: 'fence',
      name,
      lang,
      attrs,
      text: node.value,
      node,
      defaults: async () => ({ name, attrs, text: node.value }),
    }
    return htmlNode(await run(template, ctx, plain))
  }

  async function transform(parent: MdNode) {
    const kids = parent.children
    if (!kids) return
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i]
      if (DIRECTIVES.has(node.type)) kids[i] = await directive(node)
      else if (node.type === 'code') kids[i] = await fence(node)
      else await transform(node)
    }
  }

  const tree = typeof source === 'string' ? parse(source) : source
  const h1 = tree.children?.find(n => n.type === 'heading' && n.depth === 1)
  const title = h1 ? toString(h1 as any) : null
  await transform(tree)
  const out = stringify(tree.children ?? [])
  const styles = [...used.values()].map(t => t.style).filter((s): s is string => !!s)
  return { html: out, title, islands, styles }
}
