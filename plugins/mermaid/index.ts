import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Mermaid diagrams rendered to SVG on the server with Pele (https://pele.run): no JavaScript on
// the page, and colours come from CSS variables, so diagrams follow the light/dark theme.
import crypto from 'node:crypto'
// pele loads the first time a page has a diagram, not with the plugin
let pele: typeof import('pele') | undefined
import { html, raw, type FenceContext } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

export async function render(ctx: FenceContext) {
  pele ??= await import('pele')
  // ids derive from the source, so an unchanged diagram renders the same markup every time
  const idPrefix = `wbm-${crypto.createHash('sha1').update(ctx.text).digest('hex').slice(0, 8)}-`
  try {
    const { svg } = pele.render(ctx.text, { idPrefix, fontFamily: FONT, responsive: true })
    // the SVG is Pele's markup
    return html`<figure class="wb-diagram wb-figure">${raw(svg)}</figure>`
  } catch (err) {
    if (!(err instanceof pele.PeleError)) throw err
    const where = err.line ? ` (line ${err.line}${err.column ? `, column ${err.column}` : ''})` : ''
    const snippet = err.snippet ? `\n\n${err.snippet}` : ''
    return html`<pre class="wb-error">mermaid: ${err.message}${where}${snippet}</pre>`
  }
}

export default function mermaid(): Plugin {
  return definePlugin({
    name: 'mermaid',
    public: builtinPublic('mermaid'),
    blocks: {
      mermaid: {
        fence: true,
        html: render,
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
