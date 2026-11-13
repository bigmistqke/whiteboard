// The public contract between the engine, configs and templates.
//
//   import { defineConfig } from '@visualize/engine/config'
//   import { defineTemplate } from '@visualize/engine/template'
//
// Both functions only return their argument; they exist for types. A published template package
// does not need the engine at runtime: it can export plain objects that match `Template`.

// ---- config ------------------------------------------------------------------------------------

/** Templates may be nested in arrays (a set returns several); falsy entries are skipped. */
export type TemplateEntry = Template | null | false | undefined | readonly TemplateEntry[]

export interface Config {
  /** project name: pages are served at /<name>/… (default: the folder name) */
  name?: string
  /** later entries replace earlier ones with the same name; a project's replace the global config's */
  templates?: TemplateEntry[]
}

export const defineConfig = (config: Config): Config => config

// ---- templates ---------------------------------------------------------------------------------

/**
 * A template handles the directive or fence with its `name`: `:::name`, `::name`, `:name` and
 * ```` ```name ````. Server functions run while the page renders; `client` runs in the browser.
 *
 * File references are URLs relative to the template module, so they work wherever it is installed:
 *   client: new URL('./client.js', import.meta.url)
 */
export interface Template<Props = unknown> {
  name: string
  /** props for the client; JSON-serialisable. Without it a client gets the defaults (see DirectiveProps / FenceProps). */
  props?(ctx: ServerContext): Props | Promise<Props>
  /** HTML for the block. Without `client` this is the whole output; with it, what shows until it mounts. */
  html?(ctx: ServerContext): string | null | Promise<string | null>
  /** a browser module whose default export is a `Mount` */
  client?: URL | string
  /** a stylesheet linked on every page that uses the template */
  style?: URL | string
  /** markdown documentation: syntax and examples, rendered live at /_/docs */
  readme?: URL | string
}

export const defineTemplate = <Props = unknown>(template: Template<Props>): Template<Props> => template

/** Default export of a template's `client` module. Return a cleanup, or nothing. */
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
  /** page id, e.g. "project/plan" */
  page: string
  /** absolute path of the markdown file, and its folder (resolve files next to the page with it) */
  file: string
  dir: string
  name: string
  attrs: Record<string, string>
  esc(s: unknown): string
  parseAttrs(s: string): Record<string, string>
  /** render mdast nodes to HTML; nested directives and fences go through their templates */
  toHtml(nodes: unknown[]): Promise<string>
  toString(node: unknown): string
  /** render a markdown string to HTML (templates included) */
  markdown(src: string): Promise<string>
  /** like markdown(), without the wrapping <p> for a single paragraph */
  inline(src: string): Promise<string>
  /** what a client gets when the template has no props() */
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

export interface VzEvent {
  id: string
  ts: string
  page: string
  form: string
  /** value of the button that submitted the form */
  action: string | null
  data: Record<string, unknown>
}

export type Theme = 'light' | 'dark'

/** Passed to every Mount. Framework-free: read with the getters, follow with the subscriptions. */
export interface ClientApi {
  /** this page's id */
  page: string
  /** every form submission recorded for this page, oldest first */
  events(): VzEvent[]
  /** called with the new list whenever it changes; returns an unsubscribe */
  onEvents(fn: (events: VzEvent[]) => void): () => void
  /** the latest submission of a named form */
  lastSubmit(form: string): VzEvent | undefined
  /** the theme in effect (the reader's choice, else the system's) */
  theme(): Theme
  onTheme(fn: (theme: Theme) => void): () => void
}
