import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Static block: no component, so no JavaScript on the page.
import { html, raw, type DirectiveContext } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

/** The word a badge's colour is chosen by: its text, lowercased, runs of other characters a `-`. */
export const tone = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

/** `:badge[done]`: a coloured dot and a word, inline wherever text goes. */
export function render(ctx: DirectiveContext) {
  const text = ctx.labelText?.trim()
  if (!text) return html``
  // the label is HTML already; its plain text picks the colour
  return html`<span class="wb-badge" data-badge="${tone(text)}">${raw(ctx.label ?? '')}</span>`
}

export default function badge(): Plugin {
  return definePlugin({
    name: 'badge',
    public: builtinPublic('badge'),
    blocks: {
      badge: {
        html: render,
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
