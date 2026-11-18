// A window around a block: a header with its label (or an address), a button that opens what it
// shows on its own (an address, an image), and one that fills the browser window with it (the page
// does that: src/client/page/window.ts; the same button, or Esc, puts it back). The iframe block
// is one around a page, `:::window` one around any markdown; any block can draw one.
import { html, raw, type Html } from '../html.ts'

// the header's buttons, as icons
const svg = (d: string) => raw(`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`)
const OPEN = svg('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>')
const MAXIMIZE = svg('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>')
const RESTORE = svg('<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>')

export interface WindowOptions {
  /** what the window shows, as HTML */
  body: Html | string
  /** its label, as HTML (a block's label); without one, the header shows `address` */
  label?: Html | string | null
  /** what it shows on its own: an address, an image's; the ↗ button opens it, and hovering the label shows it */
  open?: string | null
  /** wider than the text column */
  wide?: boolean
  /** no header: the window alone, without its buttons */
  bare?: boolean
  /** a class for its body, and a height for it (a CSS length), for what has none of its own (an iframe) */
  bodyClass?: string
  height?: string
}

/** A window around a block's HTML: see the top of this file. */
export function windowFrame({ body, label = null, open = null, wide = false, bare = false, bodyClass = '', height }: WindowOptions): Html {
  const name = label != null && String(label) !== ''
    ? html`<span class="wb-window-title">${raw(String(label))}</span>`
    : open ? html`<span class="wb-window-address">${open}</span>` : html``
  const header = !bare && html`<div class="wb-window-bar">
<span class="wb-window-name"${open ? html` title="${open}"` : ''}>${name}</span>
${open && html`<a class="wb-window-button" href="${open}" target="_blank" rel="noopener" title="Open on its own" aria-label="Open on its own">${OPEN}</a>`}
<button type="button" class="wb-window-button" data-wb-maximize title="Fill the window" aria-label="Fill the window"><span class="wb-window-max">${MAXIMIZE}</span><span class="wb-window-restore">${RESTORE}</span></button>
</div>`
  return html`<div class="wb-window${wide && raw(' wb-wide')}">${header}<div class="wb-window-body${bodyClass && raw(' ' + bodyClass)}"${height ? html` style="height: ${height}"` : ''}>${raw(String(body))}</div></div>`
}
