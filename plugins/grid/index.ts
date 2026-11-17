import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
// Static block: no component, so no JavaScript on the page.
import { html, raw, type DirectiveContext } from '@bigmistqke/whiteboard'

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export async function render(ctx: DirectiveContext) {
  const { intro, sections } = await ctx.sections()
  const cols = Number(ctx.attrs.cols)
  const style = cols ? html` style="--wb-grid-cols:${cols}"` : null
  const cards = sections.map(s => {
    let title = s.title
    let badge: string | null = null
    const m = title ? /^(.*?)\s*\{([^}]+)\}\s*$/s.exec(title) : null
    if (m) { title = m[1]; badge = m[2].trim() }
    // a section's title and html are HTML already; the badge is text from the heading
    const b = badge && html`<span class="wb-badge" data-badge="${slug(badge)}">${badge}</span>`
    const head = (title || b) && html`<header>${title && html`<h3>${raw(title)}</h3>`}${b}</header>`
    return html`<article class="wb-card"${badge && html` data-badge="${slug(badge)}"`}>${head}<div class="wb-card-body">${raw(s.html)}</div></article>`
  })
  return html`${raw(intro)}<div class="wb-grid${'narrow' in ctx.attrs ? '' : ' wb-wide'}"${style}>${cards}</div>`
}

export default function grid(): Plugin {
  return definePlugin({
    name: 'grid',
    blocks: {
      grid: {
        html: render,
        style: new URL('./style.css', import.meta.url),
      },
    },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
