// Turns the block's content into gallery items: one per heading (first image in the section is
// its picture), or one per image when there are no headings.
import type { DirectiveContext, Template } from '@bigmistqke/whiteboard/template'

interface Node { type: string; depth?: number; url?: string; alt?: string; children?: Node[] }
export interface Item { src: string | null; alt: string; title: string | null; html: string }

/** Remove and return the first image in a list of nodes (searching inside paragraphs). */
function takeImage(nodes: Node[]): Node | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.type === 'image') { nodes.splice(i, 1); return n }
    if (n.children) {
      const found = takeImage(n.children)
      if (found) {
        if (n.type === 'paragraph' && n.children.every(c => c.type === 'text' && !String((c as any).value).trim())) nodes.splice(i, 1)
        return found
      }
    }
  }
  return null
}

export async function props(ctx: DirectiveContext) {
  const children = ctx.children as Node[]
  const heads = children.filter(n => n.type === 'heading')
  const items: Item[] = []
  if (heads.length) {
    const depth = Math.min(...heads.map(h => h.depth!))
    let current: { heading: Node; body: Node[] } | null = null
    const groups: { heading: Node; body: Node[] }[] = []
    for (const n of children) {
      if (n.type === 'heading' && n.depth === depth) groups.push((current = { heading: n, body: [] }))
      else current?.body.push(n)
    }
    for (const g of groups) {
      const img = takeImage(g.body)
      items.push({ src: img?.url ?? null, alt: img?.alt ?? '', title: await ctx.toHtml(g.heading.children ?? []), html: await ctx.toHtml(g.body) })
    }
  } else {
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.type === 'image') items.push({ src: n.url!, alt: n.alt ?? '', title: n.alt ? ctx.esc(n.alt) : null, html: '' })
        else if (n.children) walk(n.children)
      }
    }
    walk(children)
  }
  return { items, min: ctx.attrs.min ?? null, narrow: 'narrow' in ctx.attrs }
}

export default {
  name: 'gallery',
  props,
  client: new URL('./client.tsx', import.meta.url),
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
