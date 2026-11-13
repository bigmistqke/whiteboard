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

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).freeze()
const toHast = unified().use(remarkRehype, { allowDangerousHtml: true }).use(rehypeStringify, { allowDangerousHtml: true }).freeze()

export const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** `cols=3 open title="a b"` → { cols: '3', open: '', title: 'a b' } (bare words get '' like directive attrs) */
export function parseAttrs(s) {
  const out = {}
  for (const m of String(s ?? '').matchAll(/([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g))
    out[m[1]] = m[2] ? m[2].replace(/^["']|["']$/g, '') : ''
  return out
}

const DIRECTIVES = new Set(['containerDirective', 'leafDirective', 'textDirective'])

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Point relative links and images at what they name on disk: each is resolved from the markdown
 * file's own folder and handed to `linkFor(absolutePath)`, which returns the URL that serves it
 * (or null to leave the link as written).
 */
function rewriteLinks(tree, file, linkFor) {
  if (!linkFor || !file) return
  const walk = node => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && node.url &&
        !SCHEME.test(node.url) && !/^[/#]/.test(node.url)) {
      const [, target, rest] = /^([^?#]*)(.*)$/s.exec(node.url)
      let decoded = target
      try { decoded = decodeURIComponent(target) } catch { /* keep as written */ }
      const url = decoded && linkFor(path.resolve(path.dirname(file), decoded))
      if (url) node.url = url + rest
    }
    node.children?.forEach(walk)
  }
  walk(tree)
}

/**
 * remark-directive needs an outer container fence to be longer than the ones inside it
 * (`::::details` around `:::callout`). Writers — agents especially — use `:::` everywhere, so pair
 * opening and closing fences by nesting and lengthen each one to 3 + the depth of what it contains.
 * Fences inside code blocks are left alone.
 */
export function balanceContainers(source) {
  const lines = source.split('\n')
  const stack = []
  const pairs = []
  let fence = null
  lines.forEach((line, i) => {
    const code = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (code) {
      if (!fence) fence = code[1]
      else if (code[1][0] === fence[0] && code[1].length >= fence.length && !line.trim().slice(code[1].length).trim()) fence = null
      return
    }
    if (fence) return
    if (/^:{3,}[\w-]/.test(line)) stack.push({ open: i, children: [] })
    else if (/^:{3,}\s*$/.test(line) && stack.length) {
      const pair = stack.pop()
      pair.close = i
      ;(stack.length ? stack[stack.length - 1].children : pairs).push(pair)
    }
  })
  const height = p => (p.height ??= p.children.length ? 1 + Math.max(...p.children.map(height)) : 0)
  const rewrite = p => {
    const colons = ':'.repeat(3 + height(p))
    lines[p.open] = lines[p.open].replace(/^:{3,}/, colons)
    lines[p.close] = lines[p.close].replace(/^:{3,}/, colons)
    p.children.forEach(rewrite)
  }
  pairs.forEach(rewrite)
  return lines.join('\n')
}

/** Separate a directive's `[label]` (remark-directive stores it as a flagged first paragraph). */
function splitLabel(node) {
  const [head, ...rest] = node.children ?? []
  if (node.type === 'containerDirective' && head?.data?.directiveLabel) return { label: head.children, children: rest }
  if (node.type !== 'containerDirective') return { label: node.children?.length ? node.children : null, children: [] }
  return { label: null, children: node.children ?? [] }
}

function literalDirective(node, label) {
  const marker = { textDirective: ':', leafDirective: '::', containerDirective: ':::' }[node.type]
  const attrs = Object.entries(node.attributes ?? {}).map(([k, v]) => (v ? `${k}="${v}"` : k)).join(' ')
  return `${marker}${node.name}${label ? `[${toString({ type: 'root', children: label })}]` : ''}${attrs ? `{${attrs}}` : ''}`
}

/**
 * @param {string | object} source  markdown, or an mdast root to render as it is
 * @param {{ page: string, file: string, resolve: (name: string) => object | null, code?: object | null, linkFor?: (absolutePath: string) => string | null }} opts
 *   resolve returns a normalised template (see templates.js): { name, props, html, client, style };
 *   code is the template for fences no template claims by name (without one they render as plain code)
 */
export async function renderMarkdown(source, { page, file, resolve, code = null, linkFor }) {
  let nextId = 0
  const islands = {}
  const keyCount = {}
  const used = new Map()

  const stringify = nodes => toHast.stringify(toHast.runSync({ type: 'root', children: nodes }))
  /** Render mdast nodes to HTML. Transforms nested directives first; safe to call twice on the same nodes. */
  const toHtml = async nodes => { await transform({ children: nodes }); return stringify(nodes) }

  async function sectionsOf(children) {
    await transform({ children })
    const heads = children.filter(n => n.type === 'heading')
    if (!heads.length) {
      return {
        intro: '',
        sections: children.map(n => ({ title: null, text: null, html: stringify([n]) })),
      }
    }
    const depth = Math.min(...heads.map(h => h.depth))
    const out = []
    let intro = []
    let current = null
    for (const n of children) {
      if (n.type === 'heading' && n.depth === depth) {
        current = { heading: n, body: [] }
        out.push(current)
      } else if (current) current.body.push(n)
      else intro.push(n)
    }
    return {
      intro: stringify(intro),
      sections: out.map(s => ({ title: stringify(s.heading.children), text: toString(s.heading), html: stringify(s.body) })),
    }
  }

  async function run(template, ctx, fallback) {
    used.set(template.name, template)
    try {
      const inline = ctx.kind === 'textDirective'
      const html = template.html ? await template.html(ctx) : null
      if (!template.client) {
        const tag = inline ? 'span' : 'div'
        return html ?? `<${tag} data-template="${esc(ctx.name)}">${await fallback()}</${tag}>`
      }
      const props = template.props ? await template.props(ctx) : await ctx.defaults()
      const id = String(++nextId)
      islands[id] = { template: template.name, client: template.client, props }
      // stable across re-renders while template + props are unchanged, so the client keeps the mounted island
      const hash = crypto.createHash('sha1').update(template.name + '\0' + JSON.stringify(props)).digest('hex').slice(0, 12)
      const key = `${hash}-${(keyCount[hash] = (keyCount[hash] ?? 0) + 1)}`
      const tag = inline ? 'span' : 'div'
      return `<${tag} class="wb-island" data-template="${esc(ctx.name)}" data-wb-island="${id}" data-wb-key="${key}">${html ?? (await fallback())}</${tag}>`
    } catch (err) {
      console.error(`template ${template.name}:`, err)
      return `<pre class="wb-error">template "${esc(template.name)}" failed: ${esc(err.message)}</pre>`
    }
  }

  const parse = src => {
    const tree = parser.parse(balanceContainers(String(src ?? '')))
    rewriteLinks(tree, file, linkFor)
    return tree
  }
  const markdown = async src => toHtml(parse(src).children)
  const inline = async src => (await markdown(src)).trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1')
  const base = { page, file, dir: path.dirname(file), esc, parseAttrs, toHtml, toString, markdown, inline }

  async function directive(node) {
    const { label, children } = splitLabel(node)
    const template = resolve(node.name)
    if (!template) {
      if (node.type === 'textDirective') return { type: 'text', value: literalDirective(node, label) }
      const labelHtml = label ? `<p class="wb-label"><strong>${await toHtml(label)}</strong></p>` : ''
      return { type: 'html', value: `<div class="wb-unknown" data-directive="${esc(node.name)}">${labelHtml}${await toHtml(children)}</div>` }
    }
    const labelHtml = label ? await toHtml(label) : null
    let defaults
    const ctx = {
      ...base,
      kind: node.type,
      name: node.name,
      attrs: { ...node.attributes },
      label: labelHtml,
      labelText: label ? toString({ type: 'root', children: label }) : null,
      children,
      node,
      sections: () => sectionsOf(children),
      defaults: () => (defaults ??= (async () => {
        const html = await toHtml(children)
        return { name: node.name, attrs: { ...node.attributes }, label: labelHtml, html, ...(await sectionsOf(children)) }
      })()),
    }
    return { type: 'html', value: await run(template, ctx, () => toHtml(children)) }
  }

  async function fence(node) {
    const lang = node.lang || null
    const plain = async () => `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(node.value)}</code></pre>`
    const template = (lang && resolve(lang)) || code
    if (!template) return { type: 'html', value: await plain() }
    const name = template === code && lang !== code.name ? code.name : lang
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
    return { type: 'html', value: await run(template, ctx, plain) }
  }

  async function transform(parent) {
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
  const h1 = tree.children.find(n => n.type === 'heading' && n.depth === 1)
  const title = h1 ? toString(h1) : null
  await transform(tree)
  const html = stringify(tree.children)
  const styles = [...used.values()].map(t => t.style).filter(Boolean)
  return { html, title, islands, styles }
}
