import type { DirectiveContext, Template } from '@visualize/engine/template'

const TYPES = new Set(['note', 'tip', 'success', 'warning', 'danger', 'question'])

export async function html(ctx: DirectiveContext) {
  const type = [ctx.attrs.type, ...(ctx.attrs.class ?? '').split(/\s+/)].find(t => t && TYPES.has(t)) ?? 'note'
  const title = ctx.label ? `<div class="vz-callout-title">${ctx.label}</div>` : ''
  return `<aside class="vz-callout" data-type="${type}">${title}${await ctx.toHtml(ctx.children)}</aside>`
}

export default {
  name: 'callout',
  html,
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
