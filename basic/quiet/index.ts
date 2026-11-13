// Content the new-content marking leaves alone: whatever is inside a quiet wrapper never marks its
// block as new, and a block that is quiet as a whole is never marked. For what changes without
// being news to the reader: an echo of their answer, a status line, a timestamp. The mechanism is
// the data-wb-quiet attribute, which any template or hand-written HTML can use as well.
import type { DirectiveContext, Template } from '@bigmistqke/whiteboard/template'

export async function html(ctx: DirectiveContext) {
  if (ctx.kind === 'textDirective') return `<span data-wb-quiet>${ctx.label ?? ''}</span>`
  if (ctx.kind === 'leafDirective') return `<div data-wb-quiet>${ctx.label ? `<p>${ctx.label}</p>` : ''}</div>`
  return `<div data-wb-quiet>${await ctx.toHtml(ctx.children)}</div>`
}

export default {
  name: 'quiet',
  html,
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
