// HTML from a template literal, escaped by default:
//
//   html`<li><a href="/${id}">${title}</a></li>`
//
// Every interpolated value is escaped, in text and in attributes alike, unless it is HTML already:
// what `html` itself returns, or a string passed through `raw()` on purpose (markdown's output, say).
// An array is joined, so `${items.map(i => html`<li>${i}</li>`)}` needs no `.join('')`; null,
// undefined and false render as nothing, so `${cond && html`…`}` works when `cond` is a boolean (a
// count of 0 would render as 0: write `count > 0 && …`).
//
// Everything that builds HTML uses it: the core's page shell, the page on the server and in the
// browser, and plugins (`import { html, raw } from '@bigmistqke/whiteboard'`).

/** A piece of HTML that is not escaped again. `String(piece)` is its markup. */
export class Html {
  value: string
  constructor(value: string) { this.value = value }
  toString() { return this.value }
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Text → HTML that shows it as text. */
export const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ESCAPE[c]!)

/** Markup to use as it is: only for HTML that is safe already, never for text from outside. */
export const raw = (value: unknown): Html => new Html(String(value ?? ''))

function part(value: unknown): string {
  if (value == null || value === false) return ''
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(part).join('')
  return escape(value)
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1]
  return new Html(out)
}
