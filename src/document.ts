// A page as the browser gets it: the page's render, the plugins' parts (markup for <head> and
// <body>, their browser modules, notices of those that failed), and the handoff the browser runtime
// starts from. Put together here once, for a page the server serves and for one `whiteboard build`
// writes; what differs is told: how a file is addressed, whether the page is live, which plugins
// are left out, where a failing plugin is said.
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import { html, raw, type Html } from './html.ts'
import { PACKAGE_DIR } from './package.ts'
import type { MountedRoute } from './plugins.ts'
import type { Plugin, PluginHooks, Rendered, SlotName, StoredPage } from './define.ts'

/** The browser runtime, built by build.ts. */
export const RUNTIME = path.join(PACKAGE_DIR, 'dist', 'client', 'runtime.js')
/** The page in the browser (markdown live: morphing, blocks' islands, forms' marks), built by build.ts. */
export const PAGE_CLIENT = path.join(PACKAGE_DIR, 'dist', 'src', 'client', 'page', 'main.js')

/** A plugin once set up: what its setup returned, its mounted routes, or why it failed. */
export interface SetUp extends PluginHooks {
  name: string
  table: MountedRoute[]
  plugin: Plugin
  error?: Error
}

/** A render as the document takes it. `page`: whether the page's browser part runs (not on raw text). */
export interface Render {
  page: boolean
  out: Rendered
  notices: string[]
}

/** The slots at the end of <body>, in the order they are there; `corner` is the page's dock. */
const BODY_SLOTS = ['aside', 'bottom', 'overlay'] as const

/** A plugin's markup in a slot. */
type Slotted = { name: string; html: Html }

/** What the plugins add to a page. */
export interface PageParts {
  head: Html[]
  /** each plugin's markup in each slot, in plugin order */
  slots: { [K in Exclude<SlotName, 'header'>]: Slotted[] }
  /** their browser modules, which the runtime imports after the page's */
  clients: { name: string; client: string }[]
  /** the event types that, from the agent, are messages for the reader (EventSpec.forReader) */
  messages: string[]
}

/**
 * What the plugins add to a page: each one's markup for the slots (`slots`, asked with the browser's request, or
 * null for a page no browser asked for), and its browser module. One that failed to start or fails
 * here is left out and told to `failed`; so are those in `leaveOut` (a build's skip), silently.
 */
export async function pluginParts(
  hooks: SetUp[],
  req: IncomingMessage | null,
  {
    asset,
    messages,
    leaveOut = new Set(),
    failed,
  }: {
    asset(ref: string | URL): string
    messages: string[]
    leaveOut?: ReadonlySet<string>
    failed(message: string): void
  },
): Promise<PageParts> {
  const included = hooks.filter(h => !leaveOut.has(h.name))
  for (const h of included) if (h.error) failed(`plugin "${h.name}" failed to start: ${h.error.message}`)
  const working = included.filter(h => !h.error)
  const parts = await Promise.all(
    working.map(async h => {
      try {
        return (await h.slots?.(req)) ?? null
      } catch (err) {
        failed(`plugin "${h.name}" failed on this page: ${(err as Error).message}`)
        return null
      }
    }),
  )
  const slotted = (slot: Exclude<SlotName, 'header'>): Slotted[] =>
    working.flatMap((h, i) => {
      const markup = parts[i]?.[slot]
      return markup == null ? [] : [{ name: h.name, html: raw(String(markup)) }]
    })
  return {
    head: parts.map(x => raw(String(x?.head ?? ''))),
    slots: {
      aside: slotted('aside'),
      bottom: slotted('bottom'),
      overlay: slotted('overlay'),
      corner: slotted('corner'),
    },
    clients: working.filter(h => h.client).map(h => ({ name: h.name, client: asset(h.client!) })),
    messages,
  }
}

/** A stored page's frontmatter, for the browser (PageHandle.frontmatter): a markdown page's, else none. */
export const frontmatterOf = (page: StoredPage): Record<string, unknown> =>
  page.kind === 'page' ? page.frontmatter : {}

/** JSON made safe inside a <script>. */
const json = (s: unknown) => JSON.stringify(s).replace(/</g, '\\u003c')

// the page's corner (the corner slot): the one thing the core puts on every page, empty, for the
// page's and the plugins' floating buttons and toasts; above what covers the bottom of the window.
// Above the page and what floats on it (comment threads: 20), under what fills the window (a
// maximized frame: 40, a lightbox or the terminal drawer: 50)
const DOCK_STYLE =
  '#wb-dock{position:fixed;right:16px;bottom:calc(16px + var(--wb-inset-bottom,0px));z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:6px}#wb-dock:not(:has(> :not(:empty))){display:none}' +
  // the slots (SlotName) and each plugin's element in one: laid out as what is in them says, as if
  // that were where the slot is (a fixed drawer, a panel, a button in the header bar)
  '[data-wb-slot]:not(#wb-dock),[data-wb-slot]>[data-plugin]{display:contents}' +
  // toasts (api.toast): labels in the corner, in the page's theme colours where it has them
  '.wb-toasts{display:flex;flex-direction:column;align-items:flex-end;gap:6px}.wb-toasts:empty{display:none}' +
  '.wb-toast{display:inline-flex;align-items:center;gap:8px;cursor:pointer;padding:5px 12px;border-radius:99px;font:600 .8rem/1.4 var(--sans,system-ui,sans-serif);background:var(--accent,#1d5bbf);color:var(--accent-text,#fff);border:1px solid transparent;box-shadow:0 2px 10px rgb(0 0 0/.18)}' +
  '.wb-toast[hidden]{display:none}.wb-toast[data-kind=warn]{background:var(--warn,#6b4fc0)}.wb-toast[data-kind=alert]{background:var(--bad,#c4352b);color:#fff}' +
  // where an agent scrolled the page to, lit up a moment
  '@keyframes wb-flash{from{outline-color:var(--accent,#1d5bbf)}to{outline-color:transparent}}.wb-flash{outline:3px solid transparent;outline-offset:6px;border-radius:4px;animation:wb-flash 2s ease-out}' +
  '.wb-toast-dismiss{margin-right:-4px;padding:0 4px;border-left:1px solid rgb(255 255 255/.35);opacity:.75}.wb-toast-dismiss:hover{opacity:1}' +
  // a toast's details (ToastOptions.details): a ▸ on its line, unfolding them under it
  '.wb-toast{max-width:min(24rem,calc(100vw - 32px));text-align:left}.wb-toast-more{margin:0 -4px 0 -2px;padding:0 4px;opacity:.75}.wb-toast-more:hover{opacity:1}' +
  '.wb-toast[data-open]{flex-wrap:wrap;border-radius:12px}.wb-toast-details{flex-basis:100%;padding:2px 0 3px;font-weight:400;cursor:text}.wb-toast-details[hidden]{display:none}'

/** How a page is put out: by the server (live) or by a build (a file with no server behind it). */
export interface Output {
  /** a page the server serves: events, listeners and updates; false for a built page */
  live: boolean
  /** what the page's own requests start with (ServerOptions.base); '' for a built page */
  base: string
  /** the address of a file the page loads */
  asset(ref: string | URL): string
  /** the address of the browser runtime */
  runtime: string
  /** the title when the render has none and the page no id: the project's name */
  title: string
  /** what the browser runs and how it looks, compared again when the live channel is back */
  stamps?: { code: string; style: string }
}

/** Each plugin's own element in a slot, with what it rendered there. */
const slotted = (list: Slotted[]) => list.map(x => html`<div data-plugin="${x.name}">${x.html}</div>`)

/** A page as a document: the render, the plugins' parts, and the handoff for the browser runtime. */
export function pageDocument(
  page: StoredPage,
  { page: rendered, out, notices }: Render,
  parts: PageParts,
  o: Output,
): string {
  const handoff = {
    id: page.id,
    kind: page.kind,
    live: o.live,
    base: o.base,
    client: rendered ? o.asset(PAGE_CLIENT) : null,
    data: out.data ?? null,
    frontmatter: frontmatterOf(page),
    plugins: parts.clients,
    messages: parts.messages,
    ...(o.stamps && { stamps: o.stamps }),
  }
  // the page's head and html are HTML already; the handoff is JSON made safe for a script tag
  return String(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>${out.title || page.id || o.title}</title>
          <style>
            ${DOCK_STYLE}
          </style>
          ${raw(String(out.head ?? ''))}${parts.head}
        </head>
        <body data-page="${page.id}" data-kind="${page.kind}">
          ${notices.map(n => html`<pre class="wb-error" role="alert">${n}</pre>`)}
          <div id="wb-root">${raw(String(out.html))}</div>
          <div id="wb-dock" data-wb-slot="corner">${slotted(parts.slots.corner)}</div>
          <script type="application/json" id="wb-page">
            ${raw(json(handoff))}
          </script>
          <script type="module" src="${o.runtime}"></script>
          ${BODY_SLOTS.map(name => html`<div data-wb-slot="${name}">${slotted(parts.slots[name])}</div>`)}
        </body>
      </html>`,
  )
}
