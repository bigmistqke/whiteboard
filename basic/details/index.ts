import type { DirectiveContext, Template } from '@bigmistqke/whiteboard/template'

export async function html(ctx: DirectiveContext) {
  const open = 'open' in ctx.attrs ? ' open' : ''
  return `<details class="wb-details"${open}><summary>${ctx.label ?? 'Details'}</summary><div class="wb-details-body">${await ctx.toHtml(ctx.children)}</div></details>`
}

export default {
  name: 'details',
  html,
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
