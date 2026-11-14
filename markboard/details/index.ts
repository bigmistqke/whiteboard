import { html, raw, type DirectiveContext, type Template } from '@bigmistqke/whiteboard/template'

export async function render(ctx: DirectiveContext) {
  // the label and content are HTML already
  return html`<details class="wb-details"${'open' in ctx.attrs && raw(' open')}><summary>${ctx.label ? raw(ctx.label) : 'Details'}</summary><div class="wb-details-body">${raw(await ctx.toHtml(ctx.children))}</div></details>`
}

export default {
  name: 'details',
  html: render,
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
