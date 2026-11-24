// Timeline: steps in order down a line, a dot per step, each with room for full sentences: what was
// done and what it showed. The shallowest headings in it are its steps; deeper headings are a
// step's own. A `:when[…]` in a step's heading is when it happened, and in any other heading too. A timeline inside a step is
// that step's sub steps, drawn a level in (style.css). Rendered on the server; no script.
import fs from 'node:fs'
import { definePlugin, html, raw, type DirectiveContext, type Plugin } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

type Node = {
  type: string
  name?: string
  value?: string
  depth?: number
  children?: Node[]
}

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

/**
 * Splits the block's content into steps: a heading at the shallowest level in it starts one, titled
 * by it, and so does a `---`, untitled. Deeper headings are part of a step's body. Content before
 * the first heading is an untitled step.
 */
export function parse(children: Node[]): Step[] {
  const depth = Math.min(...children.filter(n => n.type === 'heading').map(n => n.depth!))
  const steps: Step[] = []
  for (const node of children) {
    if (node.type === 'heading' && node.depth === depth) steps.push({ title: node.children ?? [], body: [] })
    else if (node.type === 'thematicBreak') steps.push({ title: null, body: [] })
    else {
      if (!steps.length) steps.push({ title: null, body: [] })
      steps[steps.length - 1].body.push(node)
    }
  }
  return steps
}

/** A step: when, title and body; a timeline in its body (its sub steps) renders as its own block. */
async function renderStep(ctx: DirectiveContext, step: Step) {
  const split = step.title ? when(step.title) : { when: null, title: null }
  const title = split.title && (await ctx.toHtml(split.title))
  const body = await ctx.toHtml(step.body)
  return html`<li class="wb-tl-step">
    ${split.when && html`<time class="wb-tl-when">${split.when}</time>`}
    ${title && html`<div class="wb-tl-title" data-wb-title>${raw(title)}</div>`}
    ${body.trim() && html`<div class="wb-tl-body">${raw(body)}</div>`}
  </li>`
}

/** `:when[…]` anywhere else, in any heading: shown above it (style.css), as in a step. */
export function renderWhen(ctx: DirectiveContext) {
  // its label as written: the node, since a `:59` in it is a directive of its own (whenText)
  const at = whenText((ctx as DirectiveContext & { node: Node }).node).trim()
  return at ? html`<time class="wb-when">${at}</time>` : html``
}

async function render(ctx: DirectiveContext) {
  const steps = await Promise.all(parse(ctx.children as Node[]).map(step => renderStep(ctx, step)))
  return html`<div class="wb-timeline">
    ${ctx.label && html`<div class="wb-tl-caption">${raw(ctx.label)}</div>`}
    <ol class="wb-tl-steps">
      ${steps}
    </ol>
  </div>`
}

export default function timeline(): Plugin {
  return definePlugin({
    name: 'timeline',
    public: builtinPublic('timeline'),
    style: 'style.css',
    blocks: { timeline: { html: render }, when: { html: renderWhen } },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
