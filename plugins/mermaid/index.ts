import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Mermaid diagrams rendered to SVG on the server with Pele (https://pele.run): no JavaScript on
// the page, and colours come from CSS variables, so diagrams follow the light/dark theme.
import crypto from 'node:crypto'
import { render as renderMermaid, PeleError } from 'pele'
import { html, raw, type FenceContext } from '@bigmistqke/whiteboard'

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

export function render(ctx: FenceContext) {
  // ids derive from the source, so an unchanged diagram renders the same markup every time
  const idPrefix = `wbm-${crypto.createHash('sha1').update(ctx.text).digest('hex').slice(0, 8)}-`
  try {
    const { svg } = renderMermaid(ctx.text, { idPrefix, fontFamily: FONT, responsive: true })
    // the SVG is Pele's markup
    return html`<figure class="wb-diagram wb-figure">${raw(svg)}</figure>`
  } catch (err) {
    if (!(err instanceof PeleError)) throw err
    const where = err.line ? ` (line ${err.line}${err.column ? `, column ${err.column}` : ''})` : ''
    const snippet = err.snippet ? `\n\n${err.snippet}` : ''
    return html`<pre class="wb-error">mermaid: ${err.message}${where}${snippet}</pre>`
  }
}

export default function mermaid(): Plugin {
  return definePlugin({
    name: 'mermaid',
    blocks: {
      mermaid: {
        html: render,
        style: new URL('./style.css', import.meta.url),
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
