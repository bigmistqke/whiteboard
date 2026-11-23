// Timeline: steps in order down a line, a dot per step, each with room for full sentences: what was
// done, what it showed, and (a quote) what it means. Headings at two levels group the steps into
// sections; a `:when[…]` in a step's heading is when it happened. Rendered on the server; no script.
import fs from 'node:fs'
import { definePlugin, html, raw, type DirectiveContext, type Plugin } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

type Node = { type: string; name?: string; value?: string; depth?: number; children?: Node[] }

interface Step {
  title: Node[] | null
  body: Node[]
}

const text = (node: Node): string => node.value ?? (node.children ?? []).map(text).join('')

/** A when's text. Its `:59` in `19:59` parses as a directive named `59`: put it back as written. */
const whenText = (node: Node): string =>
  (node.children ?? [])
    .map(n => (n.type === 'textDirective' ? `:${n.name}${n.children?.length ? `[${text(n)}]` : ''}` : text(n)))
    .join('')

/** Takes a `:when[…]` out of a heading: its text, and the heading without it. */
export function when(title: Node[]): { when: string | null; title: Node[] } {
  const found = title.find(n => n.type === 'textDirective' && n.name === 'when')
  if (!found) return { when: null, title }
  const rest = title.filter(n => n !== found)
  // the space that separated it from the title
  const last = rest[rest.length - 1]
  if (last?.type === 'text' && last.value) last.value = last.value.trimEnd()
  const first = rest[0]
  if (first?.type === 'text' && first.value) first.value = first.value.trimStart()
  return { when: whenText(found).trim(), title: rest }
}

interface Section {
  title: Node[] | null
  steps: Step[]
}

/**
 * Splits the block's content into sections and steps. With headings at two levels, the shallowest
 * starts a section and the next one a step; with one level, every heading starts a step. A `---`
 * also starts a step, untitled. Content before the first heading is an untitled step.
 */
export function parse(children: Node[]): Section[] {
  const depths = [...new Set(children.filter(n => n.type === 'heading').map(n => n.depth!))].sort()
  const sectionDepth = depths.length > 1 ? depths[0] : null
  const stepDepth = depths.length > 1 ? depths[1] : depths[0]

  const sections: Section[] = [{ title: null, steps: [] }]
  let step: Step | null = null
  const section = () => sections[sections.length - 1]

  for (const node of children) {
    if (node.type === 'heading' && node.depth === sectionDepth) {
      sections.push({ title: node.children ?? [], steps: [] })
      step = null
    } else if (node.type === 'heading' && node.depth === stepDepth) {
      step = { title: node.children ?? [], body: [] }
      section().steps.push(step)
    } else if (node.type === 'thematicBreak') {
      step = { title: null, body: [] }
      section().steps.push(step)
    } else {
      if (!step) {
        step = { title: null, body: [] }
        section().steps.push(step)
      }
      step.body.push(node)
    }
  }
  return sections.filter(s => s.title || s.steps.length)
}

async function render(ctx: DirectiveContext) {
  const sections = parse(ctx.children as Node[])
  const rendered = await Promise.all(
    sections.map(async s => {
      const steps = await Promise.all(
        s.steps.map(async step => {
          const split = step.title ? when(step.title) : { when: null, title: null }
          const title = split.title && (await ctx.toHtml(split.title))
          const body = await ctx.toHtml(step.body)
          return html`<li class="wb-tl-step">
            ${split.when && html`<time class="wb-tl-when">${split.when}</time>`}
            ${title && html`<div class="wb-tl-title">${raw(title)}</div>`}
            <div class="wb-tl-body">${raw(body)}</div>
          </li>`
        }),
      )
      const title = s.title && (await ctx.toHtml(s.title))
      return html`<li class="wb-tl-section">
        ${title && html`<div class="wb-tl-section-title">${raw(title)}</div>`}
        <ol class="wb-tl-steps">
          ${steps}
        </ol>
      </li>`
    }),
  )
  return html`<div class="wb-timeline">
    ${ctx.label && html`<div class="wb-tl-caption">${raw(ctx.label)}</div>`}
    <ol class="wb-tl-sections">
      ${rendered}
    </ol>
  </div>`
}

export default function timeline(): Plugin {
  return definePlugin({
    name: 'timeline',
    public: builtinPublic('timeline'),
    style: 'style.css',
    blocks: { timeline: { html: render } },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
