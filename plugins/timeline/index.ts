// Timeline: steps in order down a line, a dot per step, each with room for full sentences: what was
// done, what it showed, and (a quote) what it means. Headings at two levels group the steps into
// sections, and each level below that is a step's sub steps, a timeline inside it; a `:when[…]` in
// a step's heading is when it happened. Rendered on the server; no script.
import fs from 'node:fs'
import { definePlugin, html, raw, type DirectiveContext, type Plugin } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

type Node = { type: string; name?: string; value?: string; depth?: number; children?: Node[] }

interface Step {
  title: Node[] | null
  body: Node[]
  /** its sub steps, from the next heading level down: a timeline of their own inside the step */
  steps: Step[]
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
 * Steps from content: a heading at `depths[0]` starts one, titled by it, and so does a `---`
 * (untitled) where `breaks`. A step's content up to its first heading at the next level is its
 * body; from there on it is that level's steps, the same way, so they nest to any depth. A heading
 * of a level a step doesn't use before that is ordinary content of its body. Content before the
 * first step is an untitled one.
 */
function stepsOf(nodes: Node[], depths: number[], breaks: boolean): Step[] {
  const [depth, ...deeper] = depths
  const groups: { title: Node[] | null; nodes: Node[] }[] = []
  for (const node of nodes) {
    if (node.type === 'heading' && node.depth === depth) groups.push({ title: node.children ?? [], nodes: [] })
    else if (breaks && node.type === 'thematicBreak') groups.push({ title: null, nodes: [] })
    else {
      if (!groups.length) groups.push({ title: null, nodes: [] })
      groups[groups.length - 1].nodes.push(node)
    }
  }
  return groups.map(({ title, nodes }) => {
    const at = deeper.length ? nodes.findIndex(n => n.type === 'heading' && n.depth === deeper[0]) : -1
    if (at === -1) return { title, body: nodes, steps: [] }
    return { title, body: nodes.slice(0, at), steps: stepsOf(nodes.slice(at), deeper, false) }
  })
}

/**
 * Splits the block's content into sections and steps. With headings at two levels or more, the
 * shallowest starts a section and the next one a step, and each level below that a step's sub
 * steps; with one level, every heading starts a step. A `---` also starts a step, untitled.
 * Content before the first heading is an untitled step.
 */
export function parse(children: Node[]): Section[] {
  const depths = [...new Set(children.filter(n => n.type === 'heading').map(n => n.depth!))].sort((a, b) => a - b)
  const sectionDepth = depths.length > 1 ? depths[0] : null
  const stepDepths = depths.length > 1 ? depths.slice(1) : depths

  const sections: { title: Node[] | null; nodes: Node[] }[] = [{ title: null, nodes: [] }]
  for (const node of children) {
    if (node.type === 'heading' && node.depth === sectionDepth) sections.push({ title: node.children ?? [], nodes: [] })
    else sections[sections.length - 1].nodes.push(node)
  }
  return sections
    .map(s => ({ title: s.title, steps: s.nodes.length ? stepsOf(s.nodes, stepDepths, true) : [] }))
    .filter(s => s.title || s.steps.length)
}

/** A step: when, title and body, then its sub steps as a timeline of their own. */
async function renderStep(ctx: DirectiveContext, step: Step): Promise<ReturnType<typeof html>> {
  const split = step.title ? when(step.title) : { when: null, title: null }
  const title = split.title && (await ctx.toHtml(split.title))
  const body = await ctx.toHtml(step.body)
  const steps = await Promise.all(step.steps.map(sub => renderStep(ctx, sub)))
  return html`<li class="wb-tl-step">
    ${split.when && html`<time class="wb-tl-when">${split.when}</time>`}
    ${title && html`<div class="wb-tl-title">${raw(title)}</div>`}
    ${body.trim() && html`<div class="wb-tl-body">${raw(body)}</div>`}
    ${
      steps.length > 0 &&
      html`<ol class="wb-tl-steps wb-tl-sub">
        ${steps}
      </ol>`
    }
  </li>`
}

async function render(ctx: DirectiveContext) {
  const sections = parse(ctx.children as Node[])
  const rendered = await Promise.all(
    sections.map(async s => {
      const steps = await Promise.all(s.steps.map(step => renderStep(ctx, step)))
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
