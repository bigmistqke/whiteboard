// Draft: what is there while a page is written, and not once it is built (`whiteboard build` leaves
// it out by default): a note to check something, two versions of a paragraph, a question for later.
import fs from 'node:fs'
import { definePlugin, html, raw, type DirectiveContext, type Plugin } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

export async function render(ctx: DirectiveContext) {
  const label = ctx.label != null && String(ctx.label) !== '' ? ctx.label : 'draft'
  return html`<aside class="wb-draft">
    <div class="wb-draft-label">${raw(String(label))}</div>
    ${raw(await ctx.toHtml(ctx.children))}
  </aside>`
}

export default function draft(): Plugin {
  return definePlugin({
    name: 'draft',
    public: builtinPublic('draft'),
    style: 'style.css',
    blocks: { draft: { html: render } },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
