import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
import { html, raw, type DirectiveContext } from '@bigmistqke/whiteboard/template'

const TYPES = new Set(['note', 'tip', 'success', 'warning', 'danger', 'question'])

export async function render(ctx: DirectiveContext) {
  const type = [ctx.attrs.type, ...(ctx.attrs.class ?? '').split(/\s+/)].find(t => t && TYPES.has(t)) ?? 'note'
  // the label and content are HTML already
  const title = ctx.label && html`<div class="wb-callout-title">${raw(ctx.label)}</div>`
  return html`<aside class="wb-callout" data-type="${type}">${title}${raw(await ctx.toHtml(ctx.children))}</aside>`
}

export default function callout(): Plugin {
  return definePlugin({
    name: 'callout',
    blocks: {
      callout: {
        html: render,
        style: new URL('./style.css', import.meta.url),
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
