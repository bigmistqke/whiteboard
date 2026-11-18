// Another page inside this one: a URL (a dev server, a deployed site) or an HTML file next to the
// pages (`demo.html` in .whiteboard/pages/ is served as it is). A header shows its label and address,
// opens it on its own, and fills the window with it; the frame can be made taller by dragging its
// bottom edge.
import fs from 'node:fs'
import { builtinPublic } from '../../src/package.ts'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
import { html, raw, type DirectiveContext } from '@bigmistqke/whiteboard'

/** http(s), protocol-relative, or a path on this server; never `javascript:` or `data:`. */
export const safeSrc = (src: string) => /^(https?:)?\/\//i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src)

/** A height in px (a bare number) or a CSS length; else the default. */
export function height(value: string | undefined): string {
  if (value && /^\d+(\.\d+)?$/.test(value)) return `${value}px`
  if (value && /^\d+(\.\d+)?(px|em|rem|vh|svh|dvh)$/.test(value)) return value
  return '480px'
}

// the header's buttons, as icons
const svg = (d: string) => raw(`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`)
const OPEN = svg('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>')
const MAXIMIZE = svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>')
const RESTORE = svg('<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>')

export async function render(ctx: DirectiveContext) {
  const src = (ctx.attrs.src ?? '').trim()
  if (!src) return html`<pre class="wb-error">iframe: needs a src, like ::iframe{src="http://localhost:5173"}</pre>`
  if (!safeSrc(src)) return html`<pre class="wb-error">iframe: src must be an http(s) URL or a path, not ${src.split(':')[0]}:</pre>`
  const title = ctx.labelText ?? ctx.attrs.title ?? src
  // a header like a browser window's: the label, or the address without one (hovering the label
  // shows the address), opening it on its own, and filling the window with it (client.ts).
  // `bare`: the frame alone.
  const header = !('bare' in ctx.attrs) && html`<div class="wb-iframe-bar">
<span class="wb-iframe-name" title="${src}">${ctx.label ? html`<span class="wb-iframe-title">${raw(ctx.label)}</span>` : html`<span class="wb-iframe-url">${src}</span>`}</span>
<a class="wb-iframe-button" href="${src}" target="_blank" rel="noopener" title="Open on its own" aria-label="Open on its own">${OPEN}</a>
<button type="button" class="wb-iframe-button" data-wb-maximize title="Fill the window" aria-label="Fill the window"><span class="wb-iframe-max">${MAXIMIZE}</span><span class="wb-iframe-restore">${RESTORE}</span></button>
</div>`
  return html`<div class="wb-iframe${'wide' in ctx.attrs && raw(' wb-wide')}">${header}<div class="wb-iframe-frame" style="height: ${height(ctx.attrs.height)}"><iframe src="${src}" title="${title}" loading="lazy" referrerpolicy="no-referrer"></iframe></div></div>`
}

export default function iframe(): Plugin {
  return definePlugin({
    name: 'iframe',
    public: builtinPublic('iframe'),
    blocks: {
      iframe: {
        html: render,
        style: 'style.css',
      },
    },
    setup: () => ({ client: 'client.js' }),
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
