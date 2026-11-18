// Another page inside this one: a URL (a dev server, a deployed site) or an HTML file next to the
// pages (`demo.html` in .whiteboard/pages/ is served as it is), in a frame that can be made taller
// by dragging its bottom edge. With `compose=window`, in a window (src/pages/window.ts): a header with its
// label, open on its own, fill the browser window.
import fs from 'node:fs'
import { builtinPublic } from '../../src/package.ts'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
import { html, type DirectiveContext } from '@bigmistqke/whiteboard'

/** http(s), protocol-relative, or a path on this server; never `javascript:` or `data:`. */
export const safeSrc = (src: string) => /^(https?:)?\/\//i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src)

/** A height in px (a bare number) or a CSS length; else the default. */
export function height(value: string | undefined): string {
  if (value && /^\d+(\.\d+)?$/.test(value)) return `${value}px`
  if (value && /^\d+(\.\d+)?(px|em|rem|vh|svh|dvh)$/.test(value)) return value
  return '480px'
}

export async function render(ctx: DirectiveContext) {
  const src = (ctx.attrs.src ?? '').trim()
  if (!src) return html`<pre class="wb-error">iframe: needs a src, like ::iframe{src="http://localhost:5173"}</pre>`
  if (!safeSrc(src))
    return html`<pre class="wb-error">iframe: src must be an http(s) URL or a path, not ${src.split(':')[0]}:</pre>`
  const title = ctx.labelText ?? ctx.attrs.title ?? src
  // the frame, which the reader can drag taller
  return html`<div class="wb-iframe-frame" style="height: ${height(ctx.attrs.height)}">
    <iframe src="${src}" title="${title}" loading="lazy" referrerpolicy="no-referrer"></iframe>
  </div>`
}

/** What it shows on its own, for the ↗ of a window around it: its address. */
export function open(ctx: DirectiveContext) {
  const src = (ctx.attrs.src ?? '').trim()
  return src && safeSrc(src) ? src : null
}

export default function iframe(): Plugin {
  return definePlugin({
    name: 'iframe',
    public: builtinPublic('iframe'),
    blocks: {
      iframe: {
        html: render,
        open,
        style: 'style.css',
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
