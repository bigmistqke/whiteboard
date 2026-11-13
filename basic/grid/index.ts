// Static template: no component, so no JavaScript on the page.
import type { DirectiveContext, Template } from '@bigmistqke/whiteboard/template'

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export async function html(ctx: DirectiveContext) {
  const { intro, sections } = await ctx.sections()
  const cols = Number(ctx.attrs.cols)
  const style = cols ? ` style="--wb-grid-cols:${cols}"` : ''
  const cards = sections.map(s => {
    let title = s.title
    let badge: string | null = null
    const m = title ? /^(.*?)\s*\{([^}]+)\}\s*$/s.exec(title) : null
    if (m) { title = m[1]; badge = m[2].trim() }
    const b = badge ? `<span class="wb-badge" data-badge="${ctx.esc(slug(badge))}">${ctx.esc(badge)}</span>` : ''
    const head = title || b ? `<header>${title ? `<h3>${title}</h3>` : ''}${b}</header>` : ''
    return `<article class="wb-card"${badge ? ` data-badge="${ctx.esc(slug(badge))}"` : ''}>${head}<div class="wb-card-body">${s.html}</div></article>`
  })
  const wide = 'narrow' in ctx.attrs ? '' : ' wb-wide'
  return `${intro}<div class="wb-grid${wide}"${style}>${cards.join('')}</div>`
}

export default {
  name: 'grid',
  html,
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
