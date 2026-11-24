// Windows (src/pages/window.ts): a header with a label, a button that fills the browser window, and
// one that opens what it shows on its own. `:::window[label] … :::` puts any markdown in one (a
// table, a screenshot with text); any other block is put in one with `compose=window` (this plugin's
// compose). `::image[label]{src}` and `::video[label]{src}` are one image or video: alone, or in a
// window with `compose=window`.
import fs from 'node:fs'
import { definePlugin, html, raw, windowFrame, type DirectiveContext, type Plugin } from '@bigmistqke/whiteboard'

interface Node {
  type: string
  url?: string
  value?: string
  children?: Node[]
}

/** What it shows on its own: the file of one image or video, its only content. */
export function openOf(children: Node[]): string | null {
  const content = children.filter(n => !(n.type === 'text' && !n.value?.trim()))
  if (content.length !== 1) return null
  const only = content[0]
  if (only.type === 'paragraph') return openOf(only.children ?? [])
  if (only.type === 'image') return only.url ?? null
  if (only.type === 'html') return /^\s*<(?:video|img|audio)\b[^>]*\bsrc="([^"]+)"/i.exec(only.value ?? '')?.[1] ?? null
  return null
}

/** A height in px (a bare number) or a CSS length; else none. */
const height = (value: string | undefined) =>
  value && /^\d+(\.\d+)?$/.test(value)
    ? `${value}px`
    : value && /^\d+(\.\d+)?(px|em|rem|vh|svh|dvh)$/.test(value)
      ? value
      : undefined

/** http(s), protocol-relative, or a path on this server; never `javascript:` or `data:`. */
const safeSrc = (src: string) => /^(https?:)?\/\//i.test(src) || !/^[a-z][a-z0-9+.-]*:/i.test(src)

/** ::image[label]{src} and ::video[label]{src loop autoplay muted poster}: one file (in a window with `compose=window`). */
const media = (kind: 'image' | 'video') => (ctx: DirectiveContext) => {
  const src = (ctx.attrs.src ?? '').trim()
  if (!src)
    return html`<pre class="wb-error">
${kind}: needs a src, like ::${kind}[a label]{src="${kind === 'image' ? 'shot.png' : 'demo.mp4'}"}</pre>`
  if (!safeSrc(src))
    return html`<pre class="wb-error">${kind}: src must be an http(s) URL or a path, not ${src.split(':')[0]}:</pre>`
  const alt = ctx.labelText ?? ctx.attrs.alt ?? ''
  const flag = (name: string) => name in ctx.attrs && raw(` ${name}`)
  const poster = ctx.attrs.poster && safeSrc(ctx.attrs.poster) ? html` poster="${ctx.fileUrl(ctx.attrs.poster)}"` : ''
  const body =
    kind === 'image'
      ? html`<img src="${ctx.fileUrl(src)}" alt="${alt}" loading="lazy" />`
      : html`<video
          src="${ctx.fileUrl(src)}"
          controls${flag('loop')}${flag('autoplay')}${'autoplay' in ctx.attrs || 'muted' in ctx.attrs ? raw(' muted') : ''}
          playsinline
          preload="metadata"
          ${poster}${alt ? html` aria-label="${alt}"` : ''}
        ></video>`
  return body
}

/** What an image or video shows on its own, for the ↗ of a window around it: its file. */
const mediaOpen = (ctx: DirectiveContext) => {
  const src = (ctx.attrs.src ?? '').trim()
  return src && safeSrc(src) ? ctx.fileUrl(src) : null
}

export async function render(ctx: DirectiveContext) {
  return windowFrame({
    label: ctx.label,
    open: openOf(ctx.children as Node[]),
    wide: 'wide' in ctx.attrs,
    height: height(ctx.attrs.height),
    body: await ctx.toHtml(ctx.children),
  })
}

export default function windows(): Plugin {
  return definePlugin({
    name: 'window',
    // any block that says `compose=window` goes in one: its `title` or label the window's title,
    // its ↗ what the block shows on its own
    compose: ({ children, label, open, attrs }) =>
      windowFrame({ label: attrs.title ? html`${attrs.title}` : label, open, wide: 'wide' in attrs, body: children }),
    blocks: {
      window: { html: render },
      image: { html: media('image'), open: mediaOpen },
      video: { html: media('video'), open: mediaOpen },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
