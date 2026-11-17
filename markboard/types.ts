// Blocks: how a plugin extends a page's markdown.
//
//   definePlugin({ name: 'callout', blocks: { callout: { html: ctx => … } } })
//
// A page's markdown hands its extension points (`:::name`, `::name`, `:name` and ```` ```name ````) to
// the block of that name, from whichever plugin brings it. `defineBlock` only returns its argument.
//
// Blocks build their HTML with `html`, which escapes every value unless it is HTML already
// (`raw()`, or what `html` returned): `html`<li>${title}</li>``. The context's `label`, `toHtml()`,
// `markdown()`, `inline()` and a section's `title` and `html` are HTML: pass them through `raw()`.
import type { Api, WbEvent } from '../src/define.ts'
import type { Html } from '../src/html.ts'

export type { Api, WbEvent, Html }
export { html, raw, escape } from '../src/html.ts'

// ---- blocks ------------------------------------------------------------------------------------

/**
 * A block handles the directive or fence with its name (its key in a plugin's `blocks`): `:::name`,
 * `::name`, `:name` and ```` ```name ````. Server functions run while the page renders; `client`
 * runs in the browser.
 *
 * File references are URLs relative to the plugin's module, so they work wherever it is installed:
 *   client: new URL('./client.js', import.meta.url)
 */
export interface Block<Props = unknown> {
  /**
   * `'any'`: also render every fence no block claims by name, and the code view of repository
   * files: the block for code in general, such as a syntax highlighter. When several blocks set it,
   * the last plugin's wins.
   */
  fence?: 'any'
  /** props for the client; JSON-serialisable. Without it a client gets the defaults (see DirectiveProps / FenceProps). */
  props?(ctx: ServerContext): Props | Promise<Props>
  /**
   * HTML for the block, as a string or built with `html`. Without `client` this is the whole
   * output; with it, what shows until it mounts.
   */
  html?(ctx: ServerContext): string | Html | null | Promise<string | Html | null>
  /** a browser module whose default export is a `Mount` */
  client?: URL | string
  /** a stylesheet linked on every page that uses the block */
  style?: URL | string
}

/** A block with typed props, for one written apart from its plugin. */
export const defineBlock = <Props = unknown>(block: Block<Props>): Block<Props> => block

/**
 * Default export of a block's `client` module: mounted once per block, again with new props when
 * the block changes. Return a cleanup, or nothing: it runs when the block is replaced or removed.
 */
export type Mount<Props = unknown> = (
  element: HTMLElement,
  props: Props,
  api: ClientApi,
) => void | (() => void) | Promise<void | (() => void)>

// ---- server context ----------------------------------------------------------------------------

export interface Section {
  /** heading content as HTML (no <h*> wrapper), null when the block has no headings */
  title: string | null
  /** heading as plain text */
  text: string | null
  html: string
}

interface BaseContext {
  /** page id, e.g. "plan", or "-/docs/guide.md" for a repository file */
  page: string
  /** absolute path of the markdown file, and its folder (resolve files next to the page with it) */
  file: string
  dir: string
  name: string
  attrs: Record<string, string>
  parseAttrs(s: string): Record<string, string>
  /** render mdast nodes to HTML; nested directives and fences go through their blocks */
  toHtml(nodes: unknown[]): Promise<string>
  toString(node: unknown): string
  /** render a markdown string to HTML (blocks included) */
  markdown(src: string): Promise<string>
  /** like markdown(), without the wrapping <p> for a single paragraph */
  inline(src: string): Promise<string>
  /** what a client gets when the block has no props() */
  defaults(): Promise<Record<string, unknown>>
}

/** `:::name[label]{attrs}` … `:::`, `::name[label]{attrs}`, `:name[label]{attrs}` */
export interface DirectiveContext extends BaseContext {
  kind: 'containerDirective' | 'leafDirective' | 'textDirective'
  /** label as HTML / plain text, null without one */
  label: string | null
  labelText: string | null
  /** the block's content as mdast nodes */
  children: unknown[]
  /** split the content at its shallowest headings, or at blank lines when it has none */
  sections(): Promise<{ intro: string; sections: Section[] }>
}

/** ```name attrs */
export interface FenceContext extends BaseContext {
  kind: 'fence'
  text: string
  /** the fence's language (its first word); for a fence claimed by name it equals `name`, null when there is none */
  lang: string | null
}

export type ServerContext = DirectiveContext | FenceContext

/** Default props of a directive without props(). */
export interface DirectiveProps {
  name: string
  attrs: Record<string, string>
  label: string | null
  html: string
  intro: string
  sections: Section[]
}

/** Default props of a fence without props(). */
export interface FenceProps {
  name: string
  attrs: Record<string, string>
  text: string
}

// ---- client api --------------------------------------------------------------------------------

export type Theme = 'light' | 'dark'

/** Passed to every Mount: the core's api, and markboard's theme. */
export interface ClientApi extends Api {
  /** the theme in effect (the reader's choice, else the system's) */
  theme(): Theme
  onTheme(fn: (theme: Theme) => void): () => void
}
