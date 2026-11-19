import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Static block: no component, so no JavaScript on the page.
import { html, raw, type DirectiveContext } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

/** A card per item (DirectiveContext.items): a heading, or a `---`, starts one. */
export async function render(ctx: DirectiveContext) {
  const items = await ctx.items()
  const cols = Number(ctx.attrs.cols)
  const style = cols ? html` style="--wb-grid-cols:${cols}"` : null
  // a section's title and html are HTML already
  const cards = items.map(
    s =>
      html`<article class="wb-card">
        ${s.title && html`<header><h3>${raw(s.title)}</h3></header>`}
        <div class="wb-card-body">${raw(s.html)}</div>
      </article>`,
  )
  return html`<div class="wb-grid${'narrow' in ctx.attrs ? '' : ' wb-wide'}" ${style}>${cards}</div>`
}

export default function grid(): Plugin {
  return definePlugin({
    name: 'grid',
    public: builtinPublic('grid'),
    blocks: {
      grid: {
        html: render,
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
