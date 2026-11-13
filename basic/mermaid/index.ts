// Mermaid diagrams rendered to SVG on the server with Pele (https://pele.run): no JavaScript on
// the page, and colours come from CSS variables, so diagrams follow the light/dark theme.
import crypto from 'node:crypto'
import { render, PeleError } from 'pele'
import type { FenceContext, Template } from '@bigmistqke/whiteboard/template'

const FONT = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

export function html(ctx: FenceContext) {
  // ids derive from the source, so an unchanged diagram renders the same markup every time
  const idPrefix = `wbm-${crypto.createHash('sha1').update(ctx.text).digest('hex').slice(0, 8)}-`
  try {
    const { svg } = render(ctx.text, { idPrefix, fontFamily: FONT, responsive: true })
    return `<figure class="wb-diagram wb-figure">${svg}</figure>`
  } catch (err) {
    if (!(err instanceof PeleError)) throw err
    const where = err.line ? ` (line ${err.line}${err.column ? `, column ${err.column}` : ''})` : ''
    const snippet = err.snippet ? `\n\n${err.snippet}` : ''
    return `<pre class="wb-error">mermaid: ${ctx.esc(err.message)}${where}${ctx.esc(snippet)}</pre>`
  }
}

export default {
  name: 'mermaid',
  html,
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
