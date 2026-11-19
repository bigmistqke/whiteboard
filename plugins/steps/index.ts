// Steps: one pane, one item at a time, ‹ › between them: an A/B, a sequence of steps, versions of a
// design. In a window (src/pages/window.ts), so it fills the browser window too. The items are laid
// over each other, so the pane is as tall as the tallest and flipping doesn't move the page; which
// one shows is the browser's (client.ts), kept across the page's updates.
import fs from 'node:fs'
import { definePlugin, html, raw, windowFrame, type DirectiveContext, type Plugin } from '@bigmistqke/whiteboard'
import { builtinPublic } from '../../src/package.ts'

/** A height in px (a bare number) or a CSS length; else none. */
const height = (value: string | undefined) =>
  value && /^\d+(\.\d+)?$/.test(value)
    ? `${value}px`
    : value && /^\d+(\.\d+)?(px|em|rem|vh|svh|dvh)$/.test(value)
      ? value
      : undefined

const svg = (d: string) =>
  raw(
    `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`,
  )
const PREV = svg('M10 3.5 5.5 8l4.5 4.5')
const NEXT = svg('M6 3.5 10.5 8 6 12.5')

/** With this many items or fewer, all titled, the header shows their titles as tabs. */
const TABS = 4

export async function render(ctx: DirectiveContext) {
  // one per item (DirectiveContext.items): a heading, or a `---`, starts one
  const items = await ctx.items()
  const tabs = !('count' in ctx.attrs) && items.length <= TABS && items.every(i => i.title)
  const n = items.length
  const marks = tabs
    ? items.map(
        (item, i) =>
          html`<button type="button" class="wb-steps-tab wb-steps-mark" data-steps="${String(i)}">
            ${raw(item.title!)}
          </button>`,
      )
    : html`<span class="wb-steps-count">
        ${items.map((_, i) => html`<span class="wb-steps-mark">${String(i + 1)} / ${String(n)}</span>`)}
      </span>`
  const controls = html`<span class="wb-steps-nav">
    <button
      type="button"
      class="wb-window-button wb-steps-prev"
      data-steps="prev"
      title="Previous (←)"
      aria-label="Previous"
    >
      ${PREV}
    </button>
    ${marks}
    <button type="button" class="wb-window-button wb-steps-next" data-steps="next" title="Next (→)" aria-label="Next">
      ${NEXT}
    </button>
  </span>`
  const body = html`<div class="wb-steps" tabindex="0">
    ${items.map(
      item =>
        html`<section class="wb-steps-item" data-key="${item.key}">
          ${!tabs && item.title ? html`<div class="wb-steps-title">${raw(item.title)}</div>` : ''} ${raw(item.html)}
        </section>`,
    )}
  </div>`
  return windowFrame({
    label: ctx.label,
    className: 'wb-steps-window',
    controls,
    wide: 'wide' in ctx.attrs,
    height: height(ctx.attrs.height),
    body,
  })
}

export default function steps(): Plugin {
  return definePlugin({
    name: 'steps',
    public: builtinPublic('steps'),
    style: 'style.css',
    setup: () => ({ client: 'client.js' }),
    blocks: { steps: { html: render } },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
