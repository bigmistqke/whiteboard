import { html, raw, type DirectiveContext, type Template } from '@bigmistqke/whiteboard/template'

const TYPES = new Set(['note', 'tip', 'success', 'warning', 'danger', 'question'])

export async function render(ctx: DirectiveContext) {
  const type = [ctx.attrs.type, ...(ctx.attrs.class ?? '').split(/\s+/)].find(t => t && TYPES.has(t)) ?? 'note'
  // the label and content are HTML already
  const title = ctx.label && html`<div class="wb-callout-title">${raw(ctx.label)}</div>`
  return html`<aside class="wb-callout" data-type="${type}">${title}${raw(await ctx.toHtml(ctx.children))}</aside>`
}

export default {
  name: 'callout',
  html: render,
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
