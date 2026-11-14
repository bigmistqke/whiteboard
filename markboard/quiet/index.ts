// Content the new-content marking leaves alone: whatever is inside a quiet wrapper never marks its
// block as new, and a block that is quiet as a whole is never marked. For what changes without
// being news to the reader: an echo of their answer, a status line, a timestamp. The mechanism is
// the data-wb-quiet attribute, which any template or hand-written HTML can use as well.
import { html, raw, type DirectiveContext, type Template } from '@bigmistqke/whiteboard/template'

export async function render(ctx: DirectiveContext) {
  // the label and content are HTML already
  const label = ctx.label && raw(ctx.label)
  if (ctx.kind === 'textDirective') return html`<span data-wb-quiet>${label}</span>`
  if (ctx.kind === 'leafDirective') return html`<div data-wb-quiet>${label && html`<p>${label}</p>`}</div>`
  return html`<div data-wb-quiet>${raw(await ctx.toHtml(ctx.children))}</div>`
}

export default {
  name: 'quiet',
  html: render,
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
