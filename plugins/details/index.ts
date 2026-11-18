import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
import { html, raw, type DirectiveContext } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

export async function render(ctx: DirectiveContext) {
  // the label and content are HTML already
  return html`<details class="wb-details" ${'open' in ctx.attrs && raw(' open')}>
    <summary>${ctx.label ? raw(ctx.label) : 'Details'}</summary>
    <div class="wb-details-body">${raw(await ctx.toHtml(ctx.children))}</div>
  </details>`
}

export default function details(): Plugin {
  return definePlugin({
    name: 'details',
    public: builtinPublic('details'),
    blocks: {
      details: {
        html: render,
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
