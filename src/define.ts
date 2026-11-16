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
 * Behaviour on every page, next to what the renderer draws, and commands of its own. `setup` runs
 * once per loaded config, on the server, and returns what the extension adds to it. Everything is
 * optional but the name.
 *
 * What an extension adds lives under its name, so two extensions can't collide:
 * - its routes are mounted at `/api/<name>/…`,
 * - its commands are `whiteboard <name>` and `whiteboard <name> <sub>`,
 * - its files go in `.whiteboard/<name>/`, which ignores itself in git and reloads nothing.
 * The core checks a route's token and arguments before its code runs, and lists routes and commands
 * in `whiteboard help` and `whiteboard docs`.
 */
export interface Extension {
  /** letters, digits, - and _; not a folder of the core (`pages`, `delivered`) nor a built-in command */
  name: string
  setup?(ctx: ExtensionContext): ExtensionHooks | Promise<ExtensionHooks>
  /** by subcommand: `''` is `whiteboard <name>` itself, `stop` is `whiteboard <name> stop` */
  commands?: Record<string, Command>
  /**
   * Markdown for whoever writes pages here, printed by `whiteboard docs` with the renderers' own:
   * what the extension sends to the page's log, and how to answer it (comments say how to reply)
   */
  docs?(): string | Promise<string>
  /**
   * The agent session the command line runs in, for an extension that knows how its agent says so
   * (Claude Code's reads `CLAUDE_CODE_SESSION_ID`); null when it doesn't run in one. `whiteboard
   * new` claims the page it makes for this session, and `whiteboard status` marks the session's
   * pages. The first extension that names a session wins.
   */
  session?(): string | null | undefined | Promise<string | null | undefined>
}

export const defineExtension = (extension: Extension): Extension => extension

export interface Project {
  name: string
  /** the project folder */
  dir: string
  /** its .whiteboard folder */
  wb: string
}

export interface ExtensionContext {
  project: Project
  /** the extension's own folder, `.whiteboard/<name>/` (made, and ignored in git) */
  dataDir: string
  /** whether a request carries the project's token: for a check of its own, beyond a route's `auth` */
  authorized(req: import('node:http').IncomingMessage): boolean
  /** the URL that serves a file of the extension (its browser module, a stylesheet) */
  asset(file: URL | string): string
}

/**
 * The type of a body or query field, or a command option: `string`, `number`, `boolean` or
 * `string[]`, with `?` when it may be left out.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'string?' | 'number?' | 'boolean?' | 'string[]?'

export interface ExtensionHooks {
  /** by method and path, `'POST /start'`: mounted at `/api/<name>/start` */
  routes?: Record<string, Route>
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
  /**
   * A browser module whose default export is an `ExtensionMount`: on every page, the core imports
   * it once the renderer has mounted, and hands it the page and the api a renderer gets. For
   * behaviour on the page's own content (its forms, say); markup of the extension's own can come
   * from `shell` instead. Serve it with `ctx.asset`.
   */
  client?: URL | string
}

export interface Route {
  description: string
  /** needs the project's token: for anything that runs code. The core refuses a request without it */
  auth?: boolean
  /** the JSON body's fields; any other field is refused */
  body?: Record<string, FieldType>
  /** the query's fields */
  query?: Record<string, FieldType>
  /** writes to `res` itself, for as long as it likes (server-sent events): `run` gets `res`, its result is ignored */
  stream?: boolean
  /**
   * What the route does. Its result is sent as JSON (`{ ok: true }` for none); an error it throws is
   * sent as `{ error }` with the error's `status` (default 500).
   */
  run(request: RouteRequest): unknown | Promise<unknown>
}

export interface RouteRequest {
  body: Record<string, unknown>
  query: Record<string, unknown>
  req: import('node:http').IncomingMessage
  /** only for a stream route */
  res?: import('node:http').ServerResponse
}

/** `whiteboard <extension> [sub] …` */
export interface Command {
  description: string
  /** the positional arguments, for the help: `[page]` */
  args?: string
  /** `--name`: its type, what it means, and for the help a word for its value (`<id>`) */
  options?: Record<string, { type: FieldType; description?: string; value?: string; short?: string }>
  /** takes arguments after `--`, passed on untouched (`ctx.rest`); for the help, what they are */
  rest?: string
  run(ctx: CommandContext): void | Promise<void>
}

export interface CommandContext {
  /** the options, parsed and checked by their declaration */
  options: Record<string, unknown>
  positionals: string[]
  /** what followed `--`, untouched (only for a command that declares `rest`) */
  rest: string[]
  project: Project
  /** the extension's own folder, `.whiteboard/<name>/` */
  dataDir: string
  /** the project's token, for the requests the command sends (header `x-whiteboard-token`) */
  token: string
  /** the base URL of the project's server, started when it isn't running */
  server(): Promise<string>
  /** the path of a page or file of the project, as the server serves it: `/plan` */
  pagePath(page?: string): string
  /** a link that gives a browser the project's token, then goes to `path` */
  authLink(path: string): Promise<string>
  /** what is open on each page (or on `page` and the pages below it), as `whiteboard status` reports it */
  status(page?: string): Promise<PageStatus[]>
  /** record that `event` was handed to an agent, as a wait does: from then on it counts as picked up */
  pickUp(event: WbEvent): void
}

/** What is open on one page. */
export interface PageStatus {
  page: string
  /** the page's file */
  file: string
  /** the session that claimed the page with `whiteboard new`, if one did */
  owner: string | null
  /** the event types the page waits on the reader for (its renderer's `expects`) */
  asks: string[]
  /** those no event from the reader answered yet */
  open: string[]
  /** the open ones no running wait or watch listens for */
  unheard: string[]
  /** the reader's events on the page that no wait, watch or hook handed out */
  unpicked: WbEvent[]
  /** the running waits and watches that cover the page */
  listeners: Listener[]
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

/** The default export of an extension's browser module: the same arguments as a renderer's mount. */
export type ExtensionMount = (root: HTMLElement, page: PageHandle, api: Api) => void | Promise<void>

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
  /**
   * Say that the page's content changed in place: a renderer that patches the page on an update
   * (markboard morphs it) calls this after each patch, so that extensions working on the content
   * can put back what they add to it. A renderer that leaves its content alone never needs to.
   */
  rendered(): void
  /** called after each `rendered()`; returns an unsubscribe */
  onRendered(fn: () => void): () => void
  /**
   * The page's corner: a column at the bottom right, above whatever covers the bottom of the
   * window (`--wb-inset-bottom`), for floating buttons. The renderer and the extensions each add
   * their own; the core draws nothing in it.
   */
  corner(): HTMLElement
  /**
   * A count in the tab title, under `key`: `(text)` in front of the page's title; null removes it.
   * Lower `order` comes first (default 0), so what waits for the reader can lead.
   */
  badge(key: string, text: string | null, order?: number): void
  /** the page's own title, behind the badges: for a renderer whose page changes its title */
  title(title: string): void
  /**
   * The page's named forms and where each stands. The core looks after every `<form name>` without
   * an `action`: it sends a submit as an event, keeps drafts, puts the last answer back, and marks
   * each form with its state (`data-wb-waiting`, `-unheard`, `-pending`, `-decided`). How that
   * looks is the renderer's; this is for drawing more than the attributes allow (a summary, a count)
   */
  forms(): FormStatus[]
  /** called after the forms were marked again: the log, the listeners or the page changed */
  onForms(fn: (forms: FormStatus[]) => void): () => void
}

/**
 * Where a named form stands:
 * - waiting: an agent is listening and wants its answer
 * - unheard: no answer, and no agent is listening
 * - pending: answered, but no agent has picked the answer up yet
 * - decided: an agent picked up its latest answer
 */
export type FormState = 'waiting' | 'unheard' | 'pending' | 'decided'

export interface FormStatus {
  form: HTMLFormElement
  /** the form's name: the type of its answers */
  name: string
  state: FormState
  /** its latest answer */
  last: WbEvent | undefined
}
