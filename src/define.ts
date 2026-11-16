// The contract between the core, a project's config and its renderers.
//
//   import { defineConfig, defineRenderer, defineExtension } from '@bigmistqke/whiteboard/config'
//
// The core stores pages, keeps the event log and runs the live channel between them and a browser.
// How a page looks and behaves is a renderer's: the core hands it the page as stored, and the
// renderer turns it into whatever it likes. Both functions only return their argument; they exist
// for types, so a renderer package needs nothing from the core at runtime.
import type { Html } from './html.js'

// ---- config ------------------------------------------------------------------------------------

export interface Config {
  /** shown in page titles and the overview (default: the folder name) */
  name?: string
  /**
   * The renderers this project can use. The first is the default; a page picks another by name in
   * its frontmatter (`renderer: slides`). Without any, pages show as their raw text.
   */
  renderers?: Renderer[]
  /**
   * Serve the project's other files at /-/<path> and watch them for changes (default: true).
   * Set it to false for a project whose folder is not a repository, such as your home folder:
   * then only `.whiteboard/` is served and watched.
   */
  files?: boolean
  /**
   * Extensions: behaviour on every page, whatever renderer draws it, such as the terminal drawer
   * (`@bigmistqke/whiteboard/terminal`). Each adds routes to the server and markup to the page.
   */
  extensions?: Extension[]
}

export const defineConfig = (config: Config): Config => config

// ---- extensions --------------------------------------------------------------------------------

/**
 * Behaviour on every page, next to what the renderer draws. `setup` runs once per loaded config,
 * on the server, and returns what the extension adds; all of it is optional.
 *
 * Each extension has a folder of its own, `.whiteboard/<name>/`, for files it keeps (a socket, a
 * log): it ignores itself in git, and changes in it reload nothing.
 */
export interface Extension {
  /** letters, digits, - and _; not `pages` or `delivered` (folders of the core) */
  name: string
  setup(ctx: ExtensionContext): ExtensionHooks | Promise<ExtensionHooks>
}

export const defineExtension = (extension: Extension): Extension => extension

export interface ExtensionContext {
  project: { name: string; dir: string; wb: string }
  /** the extension's own folder, `.whiteboard/<name>/` (made, and ignored in git) */
  dataDir: string
  /** whether a request carries the project's token (see `whiteboard terminal`): needed for anything that runs code */
  authorized(req: import('node:http').IncomingMessage): boolean
  /** the URL that serves a file of the extension (its browser module, a stylesheet) */
  asset(file: URL | string): string
}

export interface ExtensionHooks {
  /**
   * Answer a request, before pages are looked up: return true when it was this extension's. Its
   * own routes go under /api/<name>/ or /_/<name>/.
   */
  handle?(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL): boolean | Promise<boolean>
  /**
   * Markup for the page shell, outside the renderer's root: `head` at the end of <head>, `body` at
   * the end of <body>. Called for every page; null adds nothing. The body is there for the first
   * render, so an element in it can take part in the view transition between two pages.
   *
   * Something that covers an edge of the window (a drawer at the bottom) says how much of it, as a
   * length in `--wb-inset-bottom` on :root, registered with `@property` so that it computes to
   * pixels. A renderer keeps its own fixed elements clear of it and counts what is behind it as out
   * of view (markboard does).
   */
  shell?(req: import('node:http').IncomingMessage): { head?: string | Html; body?: string | Html } | null | Promise<{ head?: string | Html; body?: string | Html } | null>
}

// ---- renderers ---------------------------------------------------------------------------------

/**
 * Turns stored pages into what the reader sees. `render` runs on the server, `client` in the
 * browser; a renderer can have either or both. The core calls `render` for the first paint and
 * again whenever the browser side asks for it (`page.render()`), and tells the client when its page
 * changed; what then changes on screen is up to the renderer.
 */
export interface Renderer {
  name: string
  /** server: the page's HTML, shown in the page's root before the client mounts (optional) */
  render?(page: StoredPage, ctx: RenderContext): Rendered | Promise<Rendered>
  /** browser: a module whose default export is a `RendererMount` (optional) */
  client?: URL | string
  /** markdown documentation for whoever writes pages for this renderer: `whiteboard docs` */
  docs?(ctx: RenderContext): string | Promise<string>
  /**
   * The event types a page waits on the reader for: its questions (for markboard, its named forms).
   * Only the renderer can know them, since they are written in its syntax. `whiteboard status` and
   * the hooks use them to say which questions have no answer, and which nobody listens for
   * (optional; without it a page asks nothing)
   */
  expects?(page: StoredPage, ctx: RenderContext): string[] | Promise<string[]>
}

export const defineRenderer = (renderer: Renderer): Renderer => renderer

export interface Rendered {
  /** the page's HTML: a string, or built with `html` (the core turns it into a string once) */
  html: string | Html
  title?: string
  /** extra markup for <head>: stylesheets, meta */
  head?: string | Html
  /** JSON handed to the client with the HTML, e.g. what to mount where */
  data?: unknown
}

/** A render as the browser gets it: the core has turned its HTML into strings. */
export interface RenderedPage extends Rendered {
  html: string
  head?: string
}

/** A page as the core stores it: what is in the file, read as is. */
export type StoredPage = PageSource | FileSource | FolderSource | PagesSource

interface StoredBase {
  /** "plan", "task/plan", "-/docs/guide.md" for a repository file, "" for the overview */
  id: string
  /** absolute path on disk */
  file: string
  /** last modified, ms */
  mtime: number | null
}

/** A page: a markdown file in .whiteboard/pages/, or one in the repository. */
export interface PageSource extends StoredBase {
  kind: 'page'
  source: string
  /** the frontmatter's fields, when the file starts with one (`source` keeps it) */
  frontmatter: Record<string, string>
}

/** Any other text file in the repository. */
export interface FileSource extends StoredBase {
  kind: 'file'
  source: string
}

/** A folder in the repository. */
export interface FolderSource extends StoredBase {
  kind: 'folder'
  entries: { name: string; dir: boolean }[]
}

/** The overview, or a folder of pages without an index.md. */
export interface PagesSource extends StoredBase {
  kind: 'pages'
  /** `listeners`: how many agents are waiting for answers on the page right now */
  pages: { id: string; file: string; mtime: number; lastEvent: string | null; listeners: number }[]
}

/** What the core offers a renderer on the server. */
export interface RenderContext {
  project: { name: string; dir: string; files: boolean }
  /**
   * The URL the browser loads a file from: a client module, a stylesheet, an image next to a
   * template. Files are served only once a renderer asked for them, and are watched from then on:
   * a stylesheet reloads in place, a browser module reloads the page.
   */
  asset(file: string | URL): string
  /**
   * The URL that shows a file or folder on disk (also `file.md` for `file`), or null when it does
   * not exist or nothing serves it. For relative links: resolve them from the page's folder first.
   */
  urlFor(file: string): string | null
}

/** Default export of a renderer's `client` module. Return a cleanup, or nothing. */
export type RendererMount = (root: HTMLElement, page: PageHandle, api: Api) => void | (() => void) | Promise<void | (() => void)>

/** The page, in the browser. */
export interface PageHandle {
  id: string
  kind: StoredPage['kind']
  /** what the server render returned with the HTML now in the root */
  data: unknown
  /** called when the stored page changed; returns an unsubscribe */
  onChange(fn: () => void): () => void
  /** the server render, afresh */
  render(): Promise<RenderedPage>
  /** the page as stored, afresh */
  stored(): Promise<StoredPage>
}

// ---- events ------------------------------------------------------------------------------------

export interface WbEvent {
  id: string
  ts: string
  page: string
  /** what kind of event: for a submitted form, the form's name */
  type: string
  /** the button that submitted a form; null for other events */
  action: string | null
  data: Record<string, unknown>
  /** 'cli' for events the command line appended (`whiteboard append`), such as an agent's reply */
  from?: 'cli'
  /** in the browser: an agent has picked this event up (`whiteboard wait` or `watch` handed it out) */
  pickedUp?: true
}

/**
 * An agent waiting for answers right now: a running `whiteboard wait` or `watch`. `page` is its
 * page filter ("" for every page; a page also covers the pages below it), `type` the event type it
 * waits for, null for any.
 */
export interface Listener {
  page: string
  type: string | null
  command: 'wait' | 'watch'
}

/** What the core gives every renderer in the browser. Framework-free: getters and subscriptions. */
export interface Api {
  /** this page's id */
  page: string
  /** every event recorded for this page, oldest first */
  events(): WbEvent[]
  /** called with the new list whenever it changes; returns an unsubscribe */
  onEvents(fn: (events: WbEvent[]) => void): () => void
  /** the latest event of a type, e.g. the last submit of a form */
  last(type: string): WbEvent | undefined
  /** record an event for this page: it lands in the log, where the agent reads it */
  append(type: string, data?: Record<string, unknown>, action?: string | null): Promise<WbEvent>
  /** has an agent picked this event up (a `wait` or `watch` handed it out)? */
  pickedUp(id: string): boolean
  /** the agents waiting for answers on this page right now */
  listeners(): Listener[]
  onListeners(fn: (listeners: Listener[]) => void): () => void
}
