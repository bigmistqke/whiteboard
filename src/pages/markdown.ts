// Markdown → HTML, with directives and fences handed to blocks.
//
// A block with a component becomes an island:
//   <div class="wb-island" data-wb-island="3">fallback html</div>
// and its props go into the `islands` map the page embeds for the client to mount.
// A block with only server.ts html() is inlined as static HTML.
import path from 'node:path'
import crypto from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkDirective from 'remark-directive'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { toString } from 'mdast-util-to-string'
import { html, raw, type Html } from '../html.ts'
import { isQuestionName } from '../status.ts'
import type { ResolvedBlock } from './blocks.ts'
import type { Plugin, TextLink } from '../define.ts'

/**
 * An mdast node, loosely: the pipeline hands nodes between remark, the directive plugin and
 * blocks, and replaces some in place with `html` nodes.
 */
export interface MdNode {
  type: string
  children?: MdNode[]
  value?: string
  [key: string]: any
}

type LinkFor = (absolutePath: string) => string | null

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkDirective).freeze()

// A line starting with `:::` inside a code fence would close the container directive around the
// fence: the directive parser looks for its closing fence on every line before the code fence's
// content. So inside code fences, a line's leading colons are hidden from it (as a character no
// page uses), and put back in the parsed tree.
const HIDDEN_COLON = '\uE000'
const FENCE = /^(\s*)(`{3,}|~{3,})/

function hideColonsInFences(source: string): string {
  let open: { char: string; length: number } | null = null
  return source
    .split('\n')
    .map(line => {
      const fence = FENCE.exec(line)
      if (!open) {
        if (fence) open = { char: fence[2][0], length: fence[2].length }
        return line
      }
      if (fence && fence[2][0] === open.char && fence[2].length >= open.length && !line.slice(fence[0].length).trim()) {
        open = null
        return line
      }
      return line.replace(
        /^(\s*)(:+)/,
        (_, space: string, colons: string) => space + HIDDEN_COLON.repeat(colons.length),
      )
    })
    .join('\n')
}

function showColons(node: MdNode) {
  if (typeof node.value === 'string' && node.value.includes(HIDDEN_COLON))
    node.value = node.value.replaceAll(HIDDEN_COLON, ':')
  node.children?.forEach(showColons)
}

/** A message's raw HTML, as text: it shows as written, and runs nothing. */
function asText(node: MdNode) {
  if (node.type === 'html') {
    node.type = 'text'
    return
  }
  node.children?.forEach(asText)
}

/** Markdown → mdast: GFM and directives, with code fences safe inside containers. */
function parseMarkdown(source: string): MdNode {
  const tree = parser.parse(hideColonsInFences(source)) as MdNode
  showColons(tree)
  return tree
}
const toHast = unified()
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true })
  .freeze()

/** `cols=3 open title="a b"` → { cols: '3', open: '', title: 'a b' } (bare words get '' like directive attrs) */
export function parseAttrs(s: unknown) {
  const out: Record<string, string> = {}
  for (const m of String(s ?? '').matchAll(/([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g))
    out[m[1]] = m[2] ? m[2].replace(/^["']|["']$/g, '') : ''
  return out
}

const DIRECTIVES = new Set(['containerDirective', 'leafDirective', 'textDirective'])
const PHRASING = new Set([
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'break',
  'link',
  'linkReference',
  'image',
  'imageReference',
  'footnoteReference',
  'textDirective',
])

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Point relative links and images at what they name on disk: each is resolved from the markdown
 * file's own folder and handed to `linkFor(absolutePath)`, which returns the URL that serves it
 * (or null to leave the link as written).
 */
// where text is not linked: it is code, a link already, or an inline directive (a button, a field)
const NO_TEXT_LINKS = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'textDirective', 'definition'])

/** Turn the plugins' text links (`#12`) into links, in plain text only. */
function linkText(tree: MdNode, links: TextLink[]) {
  if (!links.length) return
  const split = (text: string): MdNode[] => {
    let parts: MdNode[] = [{ type: 'text', value: text }]
    for (const link of links) {
      const flags = link.pattern.flags.includes('g') ? link.pattern.flags : link.pattern.flags + 'g'
      parts = parts.flatMap(part => {
        if (part.type !== 'text') return [part]
        const out: MdNode[] = []
        const value = part.value as string
        const re = new RegExp(link.pattern.source, flags)
        let at = 0
        for (let m = re.exec(value); m; m = re.exec(value)) {
          if (!m[0]) {
            re.lastIndex++
            continue
          }
          const href = link.href(m)
          if (!href) continue
          if (m.index > at) out.push({ type: 'text', value: value.slice(at, m.index) })
          out.push({
            type: 'link',
            url: href,
            title: link.title?.(m) ?? null,
            children: [{ type: 'text', value: m[0] }],
          })
          at = m.index + m[0].length
        }
        if (at < value.length) out.push({ type: 'text', value: value.slice(at) })
        return out
      })
    }
    return parts
  }
  const walk = (node: MdNode) => {
    if (!node.children || NO_TEXT_LINKS.has(node.type)) return
    node.children = node.children.flatMap(child =>
      child.type === 'text' ? split(child.value as string) : (walk(child), [child]),
    )
  }
  walk(tree)
}

function rewriteLinks(tree: MdNode, file: string, linkFor?: LinkFor) {
  if (!linkFor || !file) return
  const walk = (node: MdNode) => {
    if (
      (node.type === 'link' || node.type === 'image' || node.type === 'definition') &&
      node.url &&
      !SCHEME.test(node.url) &&
      !/^[/#]/.test(node.url)
    ) {
      const [, target, rest] = /^([^?#]*)(.*)$/s.exec(node.url)!
      let decoded = target
      try {
        decoded = decodeURIComponent(target)
      } catch {
        /* keep as written */
      }
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
  if (node.type === 'containerDirective' && head?.data?.directiveLabel)
    return { label: head.children ?? null, children: rest }
  if (node.type !== 'containerDirective') return { label: node.children?.length ? node.children : null, children: [] }
  return { label: null, children: node.children ?? [] }
}

const MARKER: Record<string, string> = { textDirective: ':', leafDirective: '::', containerDirective: ':::' }

function literalDirective(node: MdNode, label: MdNode[] | null) {
  const marker = MARKER[node.type]
  const attrs = Object.entries(node.attributes ?? {})
    .map(([k, v]) => (v ? `${k}="${v}"` : k))
    .join(' ')
  return `${marker}${node.name}${label ? `[${toString({ type: 'root', children: label } as any)}]` : ''}${attrs ? `{${attrs}}` : ''}`
}

/**
 * The forms a page asks the reader to answer, by name: `:::form{name=…}` containers and
 * hand-written <form name="…"> without an action. Parsed, so a form shown as an example inside a
 * code block doesn't count.
 */
export function formNames(source: string) {
  const tree = parseMarkdown(String(source ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''))
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
  return [...new Set(names)].filter(isQuestionName)
}

export interface RenderOptions {
  page: string
  file: string
  /** a block by name, resolved (see blocks.ts) */
  resolve: (name: string) => ResolvedBlock | null
  /** the block for fences no block claims by name; without one they render as plain code */
  code?: ResolvedBlock | null
  /** the URL that serves a file on disk, for relative links */
  linkFor?: LinkFor
  /** the plugins' text links (`#12` → an issue), applied to plain text */
  textLinks?: TextLink[]
  /**
   * a message (a comment, a chat message), not a page: raw HTML shows as text, and directives as
   * written (no buttons or forms in a message); code fences and text links work as on a page
   */
  message?: boolean
  /** the plugins that compose themselves around blocks (Plugin.compose), by name: a block with that attribute goes in it */
  composers?: Map<string, NonNullable<Plugin['compose']>>
}

export interface Island {
  block: string
  client: string
  props: unknown
}

/**
 * Markdown (or an mdast root, rendered as it is) → HTML, with directives and fences handed to
 * blocks. Returns the page's HTML, its first heading, the islands to mount and the blocks'
 * stylesheets.
 */
export async function renderMarkdown(
  source: string | MdNode,
  { page, file, resolve, code = null, linkFor, textLinks = [], message = false, composers }: RenderOptions,
) {
  let nextId = 0
  const islands: Record<string, Island> = {}
  const keyCount: Record<string, number> = {}
  const used = new Map<string, ResolvedBlock>()

  const stringify = (nodes: MdNode[]): string => {
    // inline content (a label, say) is one line: as children of the root, each node would be a block
    // of its own, separated by newlines, which show as spaces
    if (nodes.length && nodes.every(n => PHRASING.has(n.type))) {
      const out = toHast.stringify(
        toHast.runSync({ type: 'root', children: [{ type: 'paragraph', children: nodes }] } as any),
      )
      return out.replace(/^<p>([\s\S]*)<\/p>$/, '$1')
    }
    return toHast.stringify(toHast.runSync({ type: 'root', children: nodes } as any))
  }
  /** Render mdast nodes to HTML. Transforms nested directives first; safe to call twice on the same nodes. */
  const toHtml = async (nodes: MdNode[]) => {
    await transform({ type: 'root', children: nodes })
    return stringify(nodes)
  }

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
      sections: out.map(s => ({
        title: stringify(s.heading.children ?? []),
        text: toString(s.heading as any),
        html: stringify(s.body),
      })),
    }
  }

  /** HTML into the markdown tree, where the rest of the pipeline takes it as it is: the one place it becomes a string. */
  const htmlNode = (markup: Html | string): MdNode => ({ type: 'html', value: String(markup) })

  /**
   * A block's output for one directive or fence: static HTML, or an island around it; then put in
   * what the plugins named by its attributes compose around it (Plugin.compose), in the order
   * written: the first innermost. Not inline blocks, not a block of the wrapping plugin's own name, not one that
   * renders nothing (left out of a build), and not one that says what's wrong with it instead.
   */
  async function run(block: ResolvedBlock, ctx: any, fallback: () => Promise<Html | string>): Promise<Html> {
    let out = await output(block, ctx, fallback)
    const shown = String(out).trim()
    if (!composers?.size || ctx.kind === 'textDirective' || !shown || shown.startsWith('<pre class="wb-error"'))
      return out
    const attrs: Record<string, string> = ctx.attrs ?? {}
    let open: string | null | undefined
    for (const name of Object.keys(attrs)) {
      const compose = composers.get(name)
      if (!compose || block.name === name) continue
      try {
        open ??= block.open?.(ctx) ?? null
        const context = {
          children: out,
          block: block.name,
          value: attrs[name] ?? '',
          attrs,
          label: ctx.label ?? null,
          open,
        }
        out = raw(String(await compose(context)))
      } catch (err) {
        console.error(`plugin ${name}: compose:`, err)
        out = html`<pre class="wb-error">
plugin "${name}" failed to compose around block "${block.name}": ${(err as Error).message}</pre>`
      }
    }
    return out
  }

  async function output(block: ResolvedBlock, ctx: any, fallback: () => Promise<Html | string>): Promise<Html> {
    used.set(block.name, block)
    try {
      // a block may return a string or an `html` result: either is HTML
      const own = block.html ? await block.html(ctx) : null
      const body = raw(own ?? (await fallback()))
      // the element is span or div, chosen here, never from input
      const tag = raw(ctx.kind === 'textDirective' ? 'span' : 'div')
      if (!block.client) return own != null ? body : html`<${tag} data-block="${ctx.name}">${body}</${tag}>`
      const props = block.props ? await block.props(ctx) : await ctx.defaults()
      const id = String(++nextId)
      islands[id] = { block: block.name, client: block.client, props }
      // stable across re-renders while block + props are unchanged, so the client keeps the mounted island
      const hash = crypto
        .createHash('sha1')
        .update(block.name + '\0' + JSON.stringify(props))
        .digest('hex')
        .slice(0, 12)
      const key = `${hash}-${(keyCount[hash] = (keyCount[hash] ?? 0) + 1)}`
      return html`<${tag} class="wb-island" data-block="${ctx.name}" data-wb-island="${id}" data-wb-key="${key}">${body}</${tag}>`
    } catch (err) {
      console.error(`block ${block.name}:`, err)
      return html`<pre class="wb-error">block "${block.name}" failed: ${(err as Error).message}</pre>`
    }
  }

  const parse = (src: string) => {
    const tree = parseMarkdown(String(src ?? ''))
    if (message) asText(tree)
    rewriteLinks(tree, file, linkFor)
    linkText(tree, textLinks)
    return tree
  }
  const markdown = async (src: string) => toHtml(parse(src).children ?? [])
  const inline = async (src: string) => (await markdown(src)).trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1')
  const base = { page, file, dir: path.dirname(file), parseAttrs, toHtml, toString, markdown, inline }

  async function directive(node: MdNode): Promise<MdNode> {
    const { label, children } = splitLabel(node)
    const block = resolve(node.name)
    if (!block) {
      if (node.type === 'textDirective') return { type: 'text', value: literalDirective(node, label) }
      // an unknown directive still shows its content: a typo never breaks the page
      const labelHtml = label && html`<p class="wb-label"><strong>${raw(await toHtml(label))}</strong></p>`
      return htmlNode(
        html`<div class="wb-unknown" data-directive="${node.name}">${labelHtml}${raw(await toHtml(children))}</div>`,
      )
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
      defaults: () =>
        (defaults ??= (async () => {
          const content = await toHtml(children)
          return {
            name: node.name,
            attrs: { ...node.attributes },
            label: labelHtml,
            html: content,
            ...(await sectionsOf(children)),
          }
        })()),
    }
    return htmlNode(await run(block, ctx, () => toHtml(children)))
  }

  async function fence(node: MdNode): Promise<MdNode> {
    const lang: string | null = node.lang || null
    const plain = async () => html`<pre><code${lang && html` class="language-${lang}"`}>${node.value}</code></pre>`
    // a fence goes to the block of its language only if that block takes fences: ```text is code,
    // not the text field of the same name
    const named = lang ? resolve(lang) : null
    const block = (named?.fences ? named : null) || code
    if (!block) return htmlNode(await plain())
    const name = code && block === code && lang !== code.name ? code.name : lang
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
    return htmlNode(await run(block, ctx, plain))
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
  // blocks of one plugin can share a stylesheet (the form and its fields): linked once
  const styles = [...new Set([...used.values()].map(t => t.style).filter((s): s is string => !!s))]
  return { html: out, title, islands, styles }
}
