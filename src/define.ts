// The contract between the core, a project's config and its plugins.
//
//   import { defineConfig, definePlugin, html } from '@bigmistqke/whiteboard'
//
// The core stores pages as markdown, renders them, keeps the event log and runs the live channel
// between them and a browser. Everything else is a plugin: the syntax pages are written in (blocks),
// behaviour on every page, commands, routes. defineConfig and definePlugin only return their
// argument; they exist for types.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Html } from './html.ts'

// HTML from a template literal, escaped by default: for a block, a plugin's `shell`
export { html, raw, escape, Html } from './html.ts'
export { windowFrame, type WindowOptions } from './pages/window.ts'

// ---- config ------------------------------------------------------------------------------------

export interface Config {
  /** shown in page titles and the overview (default: the folder name) */
  name?: string
  /**
   * Serve the project's other files at /-/<path> and watch them for changes (default: true).
   * Set it to false for a project whose folder is not a repository, such as your home folder:
   * then only `.whiteboard/` is served and watched.
   */
  files?: boolean
  /**
   * Plugins, added to the built-in ones (form, chat, code, comments and the rest); one with a
   * built-in's name replaces it (`code({ themes })`). Such as the terminal drawer
   * (`@bigmistqke/whiteboard/terminal`).
   */
  plugins?: Plugin[]
  /** a stylesheet linked on every page, after the built-in ones: the project's own look */
  style?: URL | string
  /** what `whiteboard build` makes: a static site of some pages, without what is only for writing them */
  build?: BuildConfig
}

/**
 * `whiteboard build`: pages rendered once, as plain HTML files with their images and styles, links
 * between them relative. What is for writing them is left out: the live channel, the event log,
 * and the plugins and blocks in `skip`. What is for reading stays (steps, ⤢, the theme, contents).
 */
export interface BuildConfig {
  /**
   * Which pages, as globs from the project's folder; `!` leaves out: `['docs/**\/*.md', '!docs/notes/**']`.
   * Each lands in `out` at its place below the folder they share (`docs/api/forms.md` →
   * `api/forms.html`); a README.md or index.md is its folder's index.html.
   */
  pages?: string[]
  /** plugins or blocks left out of the site (default: form, chat, comments, draft) */
  skip?: string[]
  /** the folder the site goes to, from the project's folder (default: site) */
  out?: string
}

export const defineConfig = (config: Config): Config => config

// ---- plugins --------------------------------------------------------------------------------

/**
 * What extends whiteboard: syntax (blocks), behaviour on every page, and commands. `setup` runs
 * once per loaded config, on the server, and returns what the plugin adds to it. Everything is
 * optional but the name.
 *
 * What a plugin adds lives under its name, so two plugins can't collide:
 * - its routes are mounted at `/api/<name>/…`,
 * - its commands are `whiteboard <name>` and `whiteboard <name> <sub>`,
 * - its files go in `.whiteboard/<name>/`, which ignores itself in git and reloads nothing.
 * The core checks a route's token and arguments before its code runs, and lists routes and commands
 * in `whiteboard help` and `whiteboard docs`.
 */
export interface Plugin {
  /** letters, digits, - and _; not a folder of the core (`pages`, and `plugins` for local plugins) nor a built-in command */
  name: string
  /**
   * Syntax: the blocks it adds to pages, by name: `:::name`, `::name`, `:name` and ```` ```name ````
   * go to the block of that name. Block names are unique across a project's plugins.
   */
  blocks?: Record<string, Block<any>>
  /**
   * The folder its browser files are served from, and nothing else of it: its client modules,
   * stylesheets, images, fonts (TypeScript there is served with its types stripped). `client` and
   * `style` here and in its blocks name files in it. definePlugin defaults it to `public/` next to
   * the module that calls it; a plain object plugin has the project's `.whiteboard/public/`.
   */
  public?: URL | string
  /** a stylesheet linked on every page, in its public folder (a block's `style` links only where it is used) */
  style?: URL | string
  /**
   * Text that links somewhere, as written in plain text (`#12` → an issue): the core turns each
   * match into a link when it renders a page, but not inside code, links or inline directives.
   * Called once per project folder (`dir`), so it can read the project (its git remote, say).
   */
  links?(ctx: { dir: string }): TextLink[]
  /**
   * The event types it writes to the log, named `<plugin name>:<what>`, and who they're for.
   * `whiteboard docs` lists them. Only those with `handOut: true` reach an agent unasked: a `wait`
   * or `watch` on a page hands them out, `whiteboard status` counts them, and the hooks deliver them.
   * Others stay in the log, for `whiteboard events` or a `wait --type` that asks for them by name.
   */
  events?: Record<string, EventSpec>
  /**
   * Composes itself around other blocks: a block whose `compose` attribute names this plugin
   * (`::image{src compose=window}`, ```` ```mermaid {compose=window} ````) is put in what this
   * returns, the block's own HTML as `children`, as a component gets what it wraps. The block needs
   * to know nothing of it. Several named (`compose=lightbox,window`) compose in the order written, the
   * first innermost. Not inline blocks, nor a block of this plugin's name (`:::window` is one already).
   * What it reads of the block's attributes (the window's `title`) its docs say.
   */
  compose?(ctx: ComposeContext): string | Html | Promise<string | Html>
  setup?(ctx: PluginContext): PluginHooks | Promise<PluginHooks>
  /** by subcommand: `''` is `whiteboard <name>` itself, `stop` is `whiteboard <name> stop` */
  commands?: Record<string, Command>
  /**
   * Markdown for whoever writes pages here, printed by `whiteboard docs` after how pages are written,
   * under a heading the core adds (`# Plugin: <name>`), so start below it (`##`):
   * what the plugin sends to the page's log, and how to answer it (comments say how to reply)
   */
  docs?(): string | Promise<string>
  /**
   * The agent session the command line runs in, for a plugin that knows how its agent says so
   * (Claude Code's reads `CLAUDE_CODE_SESSION_ID`); null when it doesn't run in one. `whiteboard
   * new` claims the page it makes for this session, and `whiteboard status` marks the session's
   * pages. The first plugin that names a session wins.
   */
  session?(): string | null | undefined | Promise<string | null | undefined>
}

/**
 * A plugin, with its public folder defaulted to `public/` next to the module that calls this
 * (found from the call stack), when it doesn't say one.
 */
export const definePlugin = (plugin: Plugin): Plugin =>
  plugin.public != null ? plugin : { ...plugin, public: callerPublic() }

/** `public/` next to the module that called definePlugin: the first frame of the stack in another file. */
function callerPublic(): URL | undefined {
  const own = import.meta.url
  for (const line of (new Error().stack ?? '').split('\n').slice(1)) {
    const m = /(file:\/\/[^\s)]+?|\/[^\s():]+?):\d+:\d+/.exec(line)
    if (!m) continue
    const url = m[1].startsWith('file:') ? m[1] : `file://${m[1]}`
    if (url === own) continue
    return new URL('./public/', url)
  }
  return undefined
}

/** A pattern in a page's text that links somewhere (Plugin.links). */
export interface TextLink {
  /** what to find; matched against each run of plain text */
  pattern: RegExp
  /** where a match links to; null leaves it as text */
  href(match: RegExpExecArray): string | null
  /** what the link says on hover */
  title?(match: RegExpExecArray): string
}

/** One of a plugin's event types. */
export interface EventSpec {
  /** what it is, and its `data`: for `whiteboard docs` */
  description?: string
  /** hand it to an agent unasked, like a form's answer (a message for the agent); default false */
  handOut?: boolean
  /**
   * one from the agent is a message for the reader (a reply in a thread, a chat message): it waits
   * for them until read, which the page records once its element (marked `data-wb-message` with the
   * event's id) has been in view; default false
   */
  forReader?: boolean
}

export interface Project {
  name: string
  /** the project folder */
  dir: string
  /** its .whiteboard folder */
  wb: string
}

export interface PluginContext {
  project: Project
  /** the plugin's own folder, `.whiteboard/<name>/` (made, and ignored in git) */
  dataDir: string
  /**
   * whether a request carries the project's token: for a check of its own, beyond a route's `auth`.
   * No request (`shell` for a page being built) has none.
   */
  authorized(req: IncomingMessage | null): boolean
  /** the URL that serves a file of the plugin (its browser module, a stylesheet) */
  asset(file: URL | string): string
}

/**
 * The type of a body or query field, or a command option: `string`, `number`, `boolean` or
 * `string[]`, with `?` when it may be left out.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'string?' | 'number?' | 'boolean?' | 'string[]?'

export interface PluginHooks {
  /** by method and path, `'POST /start'`: mounted at `/api/<name>/start` */
  routes?: Record<string, Route>
  /**
   * Markup for the page shell, outside the page's root: `head` at the end of <head>, `body` at
   * the end of <body>. Called for every page; null adds nothing. The body is there for the first
   * render, so an element in it can take part in the view transition between two pages.
   *
   * Something that covers an edge of the window (a drawer at the bottom) says how much of it, as a
   * length in `--wb-inset-bottom` on :root, registered with `@property` so that it computes to
   * pixels. The page keeps its own fixed elements clear of it and counts what is behind it as out
   * of view.
   *
   * `req` is the browser's request for the page; null for a page `whiteboard build` writes, which no
   * browser asked for: what is only for the project's own browser (the terminal's drawer, behind
   * `authorized`) has nothing to add there.
   */
  shell?(
    req: IncomingMessage | null,
  ):
    | { head?: string | Html; body?: string | Html }
    | null
    | Promise<{ head?: string | Html; body?: string | Html } | null>
  /**
   * A browser module whose default export is an `PluginMount`: on every page, the core imports
   * it once the page has mounted, and hands it the page and its api. For
   * behaviour on the page's own content (its forms, say); markup of the plugin's own can come
   * from `shell` instead. A file in the plugin's public folder: `'client.js'`.
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
  req: IncomingMessage
  /** only for a stream route */
  res?: ServerResponse
}

/** `whiteboard <plugin> [sub] …` */
export interface Command {
  description: string
  /** the positional arguments, for the help: `[page]` */
  args?: string
  /** `--name`: its type, what it means, and for the help a word for its value (`value: 'id'` shows as `--name <id>`) */
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
  /** the project's event log, for `@bigmistqke/whiteboard/log` (`read(ctx.eventsFile)`, …) */
  eventsFile: string
  /** the plugin's own folder, `.whiteboard/<name>/` */
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
  /**
   * Hand the reader's events on `page` (and below it, unless `exact`) or of `type` to `onEvent`, as `whiteboard
   * wait` does: each once, also those from before, never an agent's own, and each counted as picked
   * up from then on. With `follow: false` only those nobody picked up yet. Resolves with how many.
   * For the log's other primitives, import `@bigmistqke/whiteboard/log`.
   */
  handOut(
    filter: { page?: string | null; type?: string | null; exact?: boolean },
    onEvent: (event: WbEvent) => void,
    options?: { count?: number; follow?: boolean; signal?: AbortSignal },
  ): Promise<number>
}

/** What is open on one page. */
export interface PageStatus {
  page: string
  /** what the reader knows it by: its first heading, else its name */
  title: string
  /** the page's file */
  file: string
  /** the session that claimed the page with `whiteboard new`, if one did */
  owner: string | null
  /** the event types the page waits on the reader for: its named forms */
  asks: string[]
  /** where each of them stands, as the page shows it: open, pending or decided */
  questions: { name: string; state: FormState }[]
  /** those waiting for the reader: no answer yet, or a running wait asks for a new one */
  open: string[]
  /** the open ones no running wait or watch (but the fallback) takes */
  unheard: string[]
  /** the agent's messages on the page the reader hasn't read (see EventSpec.forReader) */
  unread: WbEvent[]
  /** the reader's events on the page that no wait, watch or hook handed out */
  unpicked: WbEvent[]
  /** the running waits and watches that cover the page */
  listeners: Listener[]
}

// ---- pages ---------------------------------------------------------------------------------------

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
  /** the page's frontmatter (see PageHandle.frontmatter) */
  frontmatter: Record<string, unknown>
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
  /** `source` without its frontmatter: the page's content */
  body: string
  /** the frontmatter's fields, when the file starts with one (`source` keeps it): YAML, as parsed */
  frontmatter: Record<string, unknown>
  /** why the frontmatter couldn't be read (it is then empty), shown on the page */
  frontmatterError?: string | null
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
  /** `awaiting`: how many things on the page wait for the reader: open questions, unread messages */
  pages: { id: string; file: string; mtime: number; lastEvent: string | null; awaiting: number }[]
  /**
   * The shared server's overview at `/` (see Entries in DESIGN.md): every project's pages, by
   * project, those waiting for the reader first; `note` is said under them (the server's version).
   */
  groups?: { title: string; base: string; dir: string; files: boolean; pages: PagesSource['pages'] }[]
  /** projects without pages, folded under the groups: their name and where they are served */
  empty?: { title: string; base: string }[]
  note?: string
}

/** What the core offers the pages on the server: how files are served and linked. */
export interface RenderContext {
  project: { name: string; dir: string; files: boolean }
  /**
   * The URL the browser loads a file from: a client module, a stylesheet, an image next to a
   * block. Files are served only once asked for, and are watched from then on:
   * a stylesheet reloads in place, a browser module reloads the page.
   */
  asset(file: string | URL): string
  /**
   * The URL that shows a file or folder on disk (also `file.md` for `file`), or null when it does
   * not exist or nothing serves it. For relative links: resolve them from the page's folder first.
   */
  urlFor(file: string): string | null
  /** false in a build (`whiteboard build`): the page is a file, with no updates and no events */
  live?: boolean
  /** in a build, the plugins and blocks left out: their blocks render as nothing */
  skip?: ReadonlySet<string>
  /**
   * The path the project is served under: '' for a server of its own, `/rg/develop` under a shared
   * server (see Entries). Every URL the server makes starts with it; `asset` and `urlFor` add it.
   */
  base?: string
  /** under a shared server: the entry the project is in, and how the project is known in it (`worktrees › cmux`) */
  entry?: { name: string; label?: string }
}

/**
 * The default export of a plugin's browser module (from `setup`): the page's root, the page, and its
 * api. It runs once per page load, and is never unmounted: going to another page loads a new one.
 */
export type PluginMount = (root: HTMLElement, page: PageHandle, api: Api) => void | Promise<void>

/** The page, in the browser. */
export interface PageHandle {
  id: string
  kind: StoredPage['kind']
  /**
   * false on a built page (`whiteboard build`): a file, with no server behind it, so no events, no
   * listeners and no updates; only what is for reading runs.
   */
  live: boolean
  /** what the server render returned with the HTML now in the root; it changes with each live update */
  data: Reactive<unknown>
  /**
   * The page's frontmatter: YAML between `---` lines at its start, as parsed; empty for a page
   * without one, one that doesn't parse, and for the overview, folders and code. It changes with a
   * live update that changed it, once the new page is in place (`onChange` comes before, with the
   * old one still here). The top level is the core's and other tools' (`title`, `tags`); a plugin's
   * own is under `plugins:`, by its name, and is its `settings`.
   */
  frontmatter: Reactive<Record<string, unknown>>
  /**
   * For a plugin's browser module, its own entry in the page's frontmatter, under `plugins:` by its
   * name, as parsed: `plugins: { toc: true }` is `true` for toc, `plugins: { toc: { maxWidth: 240px } }`
   * an object; undefined when the page says nothing for it (and for the page module). It changes
   * when that entry does.
   */
  settings: Reactive<unknown>
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
  /**
   * in the browser: appended here and shown at once, but the server hasn't confirmed it yet. Show
   * it as on its way ("sending…"), not as done. Should it fail, it leaves the events again.
   */
  sending?: true
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
  /**
   * a `wait` or `watch` without `--page`: it takes only what no other listener would, and asks no
   * question again. At most one runs per project.
   */
  fallback?: boolean
}

/** How a toast looks and acts (Api.toast). */
export interface ToastOptions {
  /** its colour: `info` (the accent, the default), `warn`, or `alert` (as for what is new) */
  kind?: 'info' | 'warn' | 'alert'
  /** milliseconds before it goes, 7000 by default; 0: it stays until closed through its `Toast` */
  ms?: number
  /** what a click on it does (go to what it is about); a toast that goes by itself also closes */
  onClick?: () => void
  /** gives it a ✕, which runs this and closes it */
  onDismiss?: () => void
  /** a name to find it by (`data-toast`), for its styles and for tests */
  name?: string
  /** where it is among the corner's toasts: lower first (default 0) */
  order?: number
  /**
   * more about it, for whoever wants to know: the toast stays a short line, with a ▸ that unfolds
   * this under it (and keeps it open while it is read). Keep `text` a few words, and put the why here.
   */
  details?: string
}

/** A toast on the screen: change what it says (a count), hide it and show it again, or close it. */
export interface Toast {
  close(): void
  update(text: string): void
  hide(): void
  show(): void
}

/**
 * A value that changes: call it for what it is now, and `.on(fn)` to hear each change, with the
 * new value (it returns an unsubscribe). Every changing value of the api is one, so a framework
 * can turn any of them into its own reactive value with one helper (the Solid one does).
 */
export interface Reactive<T> {
  (): T
  on(fn: (value: T) => void): () => void
}

/** What the core gives the page and every plugin in the browser. Framework-free: its changing values are Reactive. */
export interface Api {
  /** this page's id */
  page: string
  /**
   * A path of the project's server as this page requests it: `url('/api/<plugin>/x')`. Under a shared
   * server the project is served below a path (`/rg/develop`), so a plugin's client asks through this
   * rather than writing `/api/…` itself.
   */
  url(path: string): string
  /** every event recorded for this page, oldest first */
  events: Reactive<WbEvent[]>
  /** the latest event of a type, e.g. the last submit of a form */
  last(type: string): WbEvent | undefined
  /** record an event for this page: it lands in the log, where the agent reads it */
  append(type: string, data?: Record<string, unknown>, action?: string | null): Promise<WbEvent>
  /** has an agent picked this event up (a `wait` or `watch` handed it out)? */
  pickedUp(id: string): boolean
  /**
   * The agent's messages on this page the reader hasn't read, oldest first (see
   * EventSpec.forReader). An element marked `data-wb-message="<event id>"` reads its message once
   * it has been in view; `markRead` does so for messages read otherwise (a thread closed).
   */
  unread: Reactive<WbEvent[]>
  markRead(ids: string[]): void
  /**
   * A message's markdown (a comment, a chat message) as HTML, rendered by the server like a page:
   * code fences highlighted, text links (`#12`), but raw HTML as text and no directives. Cached.
   */
  markdown(text: string): Promise<string>
  /** the agents waiting for answers on this page right now */
  listeners: Reactive<Listener[]>
  /**
   * Say that the page's content changed in place: the page module calls it after each patch on an update
   * (it morphs it) calls this after each patch, so that plugins working on the content
   * can put back what they add to it.
   */
  rendered(): void
  /** called after each `rendered()`; returns an unsubscribe */
  onRendered(fn: () => void): () => void
  /**
   * The page's corner: a column at the bottom right, above whatever covers the bottom of the
   * window (`--wb-inset-bottom`), for floating buttons. The page and the plugins each add
   * their own; the core draws nothing in it.
   */
  corner(): HTMLElement
  /**
   * A count in the tab title, under `key`: `(text)` in front of the page's title; null removes it.
   * Lower `order` comes first (default 0), so what waits for the reader can lead.
   */
  badge(key: string, text: string | null, order?: number): void
  /** the page's own title, behind the badges */
  title(title: string): void
  /**
   * A short label in the page's corner that says what is going on and takes the reader there:
   * what waits for them, what is new, an answer nobody listens for. It goes after a few seconds,
   * or on a click, which runs `onClick` (go to what it is about); with `ms: 0` it stays, and what
   * this returns changes its text, hides and shows it, or closes it.
   */
  toast(text: string, options?: ToastOptions): Toast
  /**
   * The page's named forms and where each stands. The core looks after every `<form name>` without
   * an `action`: it sends a submit as an event, keeps drafts, puts the last answer back, and marks
   * each form with its state (`data-wb-open`, `-pending`, `-decided`). How that
   * looks is the page's styles'; this is for drawing more than the attributes allow (a summary, a
   * count). It changes when the forms are marked again: the log, the listeners or the page changed.
   */
  forms: Reactive<FormStatus[]>
}

/**
 * Where a named form stands:
 * - waiting: an agent is listening and wants its answer
 * - unheard: no answer, and no agent is listening
 * - pending: answered, but no agent has picked the answer up yet
 * - decided: an agent picked up its latest answer
 */
export type FormState = 'open' | 'pending' | 'decided'

export interface FormStatus {
  form: HTMLFormElement
  /** the form's name: the type of its answers */
  name: string
  state: FormState
  /** its latest answer */
  last: WbEvent | undefined
}

// ---- blocks ------------------------------------------------------------------------------------

/**
 * A block handles the directives with its name (its key in a plugin's `blocks`): `:::name`,
 * `::name` and `:name`; and, when it says so (`fence`), the code fences of that language,
 * ```` ```name ````. Server functions run while the page renders; `client` runs in the browser.
 *
 * Its files are in its plugin's public folder, named within it, so they work wherever it is
 * installed: `client: 'chart.js'`, `style: 'chart.css'`.
 */
export interface Block<Props = unknown> {
  /**
   * Which code fences it renders. `true`: those of its name (```` ```mermaid ````). `'any'`: those
   * too, and every fence no block claims by name, and the code view of repository files: the block
   * for code in general, such as a syntax highlighter (when several set it, the last plugin's wins).
   * Without it, a fence of its name is code like any other: ```` ```text ```` is no text field.
   */
  fence?: boolean | 'any'
  /** props for the client; JSON-serialisable. Without it a client gets the defaults (see DirectiveProps / FenceProps). */
  props?(ctx: ServerContext): Props | Promise<Props>
  /**
   * HTML for the block, as a string or built with `html`. Without `client` this is the whole
   * output; with it, what shows until it mounts.
   */
  html?(ctx: ServerContext): string | Html | null | Promise<string | Html | null>
  /**
   * What the block shows, on its own: an image's file, a page's address: what a plugin composed
   * around it gets as `open` (Plugin.compose), the window's ↗. Without it, the window has no ↗.
   */
  open?(ctx: ServerContext): string | null
  /** a browser module whose default export is a `Mount`, in its plugin's public folder: `'chart.js'` */
  client?: URL | string
  /** a stylesheet linked on every page that uses the block, in its plugin's public folder: `'chart.css'` */
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

/**
 * One of a block's items (DirectiveContext.items): what a grid makes a card of, steps a step. A
 * heading at the block's shallowest heading level starts one, titled by it; so does a `---`, without
 * a title; content with neither is one item.
 */
export interface Item {
  /** the heading's content as HTML (no <h*> around it); null for an item a `---` started */
  title: string | null
  /** the heading as plain text */
  text: string | null
  /** the item's content as HTML */
  html: string
  /** the same as mdast nodes, for a block that takes it apart (its first picture, say) */
  nodes: unknown[]
  /** stays the same while its heading does (its slug), else its place: to remember an item across updates */
  key: string
}

interface BaseContext {
  /** page id, e.g. "plan", or "-/docs/guide.md" for a repository file */
  page: string
  /** absolute path of the markdown file, and its folder (resolve files next to the page with it) */
  file: string
  dir: string
  /**
   * The address of a file named relative to the page (an image's `src`): served, the server's; in a
   * build, of a copy beside the built page. A URL, an address from the root, or a file that isn't
   * there comes back as written.
   */
  fileUrl(src: string): string
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
  /** the content as items: a heading at its shallowest heading level, or a `---`, starts one (Item) */
  items(): Promise<Item[]>
}

/** ```name attrs */
export interface FenceContext extends BaseContext {
  kind: 'fence'
  text: string
  /** the fence's language (its first word); for a fence claimed by name it equals `name`, null when there is none */
  lang: string | null
}

export type ServerContext = DirectiveContext | FenceContext

/** What a plugin's `compose` gets: the block it goes around, and that block's HTML as `children`. */
export interface ComposeContext {
  /** the block's HTML: what is composed in */
  children: Html
  /** the block's name: `image`, `mermaid` */
  block: string
  /** the block's attributes */
  attrs: Record<string, string>
  /** the block's label as HTML, null without one (fences have none) */
  label: string | null
  /** what the block shows on its own (Block.open): an image's file, a page's address; null without */
  open: string | null
}

/** Default props of a directive without props(). */
export interface DirectiveProps {
  name: string
  attrs: Record<string, string>
  label: string | null
  html: string
  /** its items (Item), without their mdast nodes */
  items: Omit<Item, 'nodes'>[]
}

/** Default props of a fence without props(). */
export interface FenceProps {
  name: string
  attrs: Record<string, string>
  text: string
}

// ---- client api --------------------------------------------------------------------------------

export type Theme = 'light' | 'dark'

/** Passed to every Mount: the core's api, and the page's theme. */
export interface ClientApi extends Api {
  /** the theme in effect (the reader's choice, else the system's) */
  theme: Reactive<Theme>
}
