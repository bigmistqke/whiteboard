// The server of one project, as a request handler: `createServer(project)` gives one, and
// `start` in serve.ts makes it listen on a port. Nothing happens on import, and a server's state
// (listeners, open pages, watchers) lives in it, so tests can make one for a throwaway project and
// send it requests.
//
//   /                the overview: the project's pages
//   /<page>          a page from .whiteboard/pages/<page>.md
//   /-/<path>        a file of the project, from the repository (unless the config sets files: false)
//   /_/docs          how to write pages here: markdown, and each plugin's docs
//   /_/file/<path>   a file a plugin asked to serve (its client, a stylesheet)
//   /_/auth          sets the project's token as a cookie (see auth.ts)
//   /api/<ext>/…     a plugin's own routes (see Plugin in define.ts)
//   /api/…           the stored page, its render, events, live changes
//
// The core reads pages as they are stored and renders them as markdown, with the blocks the project's
// plugins bring (pages.ts). When the config fails to load, a page shows as its raw
// text.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import fs from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import type { Project } from './config.ts'
import { appendEvent, isEventId, readEvents, matches, pickedUp, forAgent } from './events.ts'
import { html, raw, type Html } from './html.ts'
import { createConfigLoader, pluginDir, toPath, type LoadedConfig } from './loader.ts'
import { describeRoutes, dispatch, pluginCommands, mountRoutes, usage, type MountedRoute } from './plugins.ts'
import { createAuth, sameSite } from './auth.ts'
import { accept, refuse } from './ws.ts'
import { FROM_SOURCE, PACKAGE_DIR, VERSION } from './package.ts'
import { awaiting, projectStatus, type ProjectStatus } from './status.ts'
import { titleOf } from './pages/render.ts'
import { createRegistry, holdStream, listenerOf } from './listeners.ts'
import { inPublic } from './public.ts'
import type {
  Listener,
  PageSource,
  PageStatus,
  Plugin,
  PluginHooks,
  Rendered,
  StoredPage,
  PagesSource,
  BuildConfig,
  WbEvent,
} from './define.ts'

const ENGINE_DIR = PACKAGE_DIR
// the browser runtime, built by build.ts
const RUNTIME = path.join(ENGINE_DIR, 'dist', 'client', 'runtime.js')
// the page in the browser (markdown live: morphing, blocks' islands, forms' marks), built by build.ts
const PAGE_CLIENT = path.join(ENGINE_DIR, 'dist', 'src', 'client', 'page', 'main.js')
const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}
// files in .whiteboard/ that are the server's own bookkeeping, not content
const OWN_FILES = new Set(['events.ndjson', 'server.json', 'server.log', 'server.lock', 'token'])
const SKIP_DIRS = new Set(['node_modules', '.git'])
// a page's frontmatter: YAML between `---` lines, at the very start
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/** A project's server: its request handler, and what it knows. */
export interface WhiteboardServer {
  /** answer one request */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** answer one upgrade request (the HTTP server's 'upgrade' event): the page's live channel */
  upgrade(req: IncomingMessage, conn: Duplex, head: Buffer): void
  /** what is open on each page (or on `page` and below), as /api/status gives it */
  status(page?: string | null): Promise<PageStatus[]>
  /** the project's config, loaded */
  config(): Promise<LoadedConfig>
  /** a static site of some pages (`whiteboard build`); options over the config's `build` */
  build(options?: BuildConfig): Promise<BuildResult>
  /**
   * Hold a listener that is not a connection to this server: the shared server's fallback for a
   * whole entry, which covers every page of each of its projects. Pages are told, as for any
   * listener. @returns what removes it; null when refused (the project has a fallback already)
   */
  addListener(l: Listener): (() => void) | null
  /** call `fn` whenever a listener comes or goes; returns what stops it */
  onListeners(fn: () => void): () => void
  /** who listens now: the running waits and watches, and a fallback held for it */
  listeners(): Listener[]
  /** the project's pages as its overview lists them, newest first, with what waits on each; whether it serves its files */
  overview(): Promise<{ pages: PagesSource['pages']; files: boolean }>
  /** tell the open overviews (`/`) that what they list changed */
  touch(): void
  /** tell the open pages that what waits in another project of the shared server changed */
  elsewhere(): void
  /** stop watching and end the live connections; the server answers nothing after */
  close(): void
}

export interface BuildResult {
  /** the folder the site is in */
  out: string
  /** each page, and the file it became */
  pages: { file: string; to: string }[]
  /** what didn't fit: a link to a page outside the build, no index.html */
  warnings: string[]
}

/** How a server is mounted: on a port of its own (the default), or under a path of a shared server. */
export interface ServerOptions {
  /** the path every URL it makes starts with, without a trailing slash: '' (its own port) or `/rg/develop` */
  base?: string
  /** the entry of a shared server the project is in */
  entry?: string
  /** how the project is known in its entry: `worktrees › cmux` (default: its name) */
  label?: string
  /** what the project is called, over its folder's or config's name (the shared server's own: whiteboard) */
  name?: string
  /** serve and watch the project's files, over the config's `files` */
  files?: boolean
  /** the overview at / lists these instead of the project's pages (the shared server's own project) */
  overview?: () => Promise<Pick<PagesSource, 'groups' | 'empty' | 'note'>>
  /** a page of the project changed, or its log grew: the shared server's overview follows it */
  onChange?: () => void
}

export function createServer(
  project: Project,
  { base = '', entry, label, name, files: filesOption, overview, onChange }: ServerOptions = {},
): WhiteboardServer {
  const projectName = () => name ?? project.name
  const loader = createConfigLoader(project)
  const auth = createAuth(project.wb, base)
  // what close() stops: watchers, and the live connections' pings and responses
  const watchers = new Set<fs.FSWatcher>()
  const streams = new Set<() => void>()
  const watch = (dir: string, options: fs.WatchOptions, fn: (name: string) => void) => {
    try {
      watchers.add(
        fs.watch(dir, options, (_evt, name) => {
          if (name) fn(String(name))
        }),
      )
    } catch {
      /* gone, or not built */
    }
  }

  // ---- plugins --------------------------------------------------------------------------------
  // Behaviour on every page: each one's setup runs once per loaded config.

  /** A plugin once set up: what its setup returned, its mounted routes, or why it failed. */
  interface SetUp extends PluginHooks {
    name: string
    table: MountedRoute[]
    plugin: Plugin
    error?: Error
  }

  const setups = new WeakMap<LoadedConfig, Promise<SetUp[]>>()
  // the plugins' own folders in .whiteboard/: changes in them reload nothing
  const pluginDirs = new Set<string>()

  /** The hooks of the loaded config's plugins, set up once per config. */
  async function pluginHooks(): Promise<SetUp[]> {
    const c = await config()
    if (!setups.has(c)) {
      setups.set(
        c,
        Promise.all(
          c.plugins.map(async (e): Promise<SetUp> => {
            try {
              pluginDirs.add(e.name)
              const dataDir = pluginDir(project.wb, e.name)
              // what it serves is in its public folder: its client, and what it asks ctx.asset for
              const dir = c.publicDirs.get(e.name)!
              const own = (ref: URL | string) => asset(inPublic(dir, ref, `plugin ${e.name}`))
              const hooks =
                (await e.setup?.({
                  project: { name: project.name, dir: project.dir, wb: project.wb },
                  dataDir,
                  authorized: auth.authorized,
                  asset: own,
                })) ?? {}
              const client = hooks.client != null ? inPublic(dir, hooks.client, `plugin ${e.name}: client`) : undefined
              return { name: e.name, ...hooks, client, table: mountRoutes(e.name, hooks.routes), plugin: e }
            } catch (err) {
              console.error(`plugin ${e.name}:`, err)
              return { name: e.name, table: [], plugin: e, error: err as Error }
            }
          }),
        ),
      )
    }
    return setups.get(c)!
  }

  /**
   * What the plugins add to the page shell for this request, and the notices of those that failed:
   * a failing plugin shows on the page, as a failing config does, instead of quietly leaving its
   * part out.
   */
  /** What the plugins add to a page: markup for its head and body, their browser modules, and notices. */
  interface Extras {
    head: Html[]
    body: Html[]
    clients: { name: string; client: string }[]
    /** the event types that, from the agent, are messages for the reader (EventSpec.forReader) */
    messages?: string[]
    notices?: string[]
  }

  async function shellExtras(req: IncomingMessage): Promise<Extras & { notices: string[] }> {
    const hooks = await pluginHooks()
    const notices = hooks.filter(h => h.error).map(h => `plugin "${h.name}" failed to start: ${h.error!.message}`)
    const parts = await Promise.all(
      hooks.map(async h => {
        try {
          return (await h.shell?.(req)) ?? null
        } catch (err) {
          console.error(`plugin ${h.name}:`, err)
          notices.push(`plugin "${h.name}" failed on this page: ${(err as Error).message}`)
          return null
        }
      }),
    )
    // their browser modules, which the runtime imports after the page's
    const clients = hooks.filter(h => h.client && !h.error).map(h => ({ name: h.name, client: asset(h.client!) }))
    const messages = [...(await config()).forReader]
    return {
      head: parts.map(x => raw(String(x?.head ?? ''))),
      body: parts.map(x => raw(String(x?.body ?? ''))),
      clients,
      messages,
      notices,
    }
  }

  /** A page with what the plugins add, their notices among the page's. */
  async function page(req: IncomingMessage, stored: StoredPage, rendered: Render): Promise<string> {
    const extras = await shellExtras(req)
    return shell(stored, { ...rendered, notices: [...rendered.notices, ...extras.notices] }, extras)
  }

  /** The loaded config. Also applies its `files` setting to what is served and watched. */
  async function config(): Promise<LoadedConfig> {
    const c = await loader.config()
    setFiles(filesOption ?? c.files)
    publicDirs = [...c.publicDirs.values()]
    return c
  }

  // ---- assets: the browser's files ----------------------------------------------------------------
  // Served at /_/file/<absolute path>, and only these: the files the core names (its page module and
  // styles, the project's stylesheet), and what is inside a plugin's public folder (public.ts): its
  // client modules, styles, images, fonts. Nothing else of a plugin, and nothing beside its public
  // folder: not its server code, not the project's token, log or config. TypeScript there is
  // served with its types stripped (Node's own type stripping, as for server code: erasable syntax
  // only, positions kept). The folders of what is served are watched from then on.

  const assets = new Set<string>()
  const assetDirs = new Set<string>()
  const TYPESCRIPT = /\.m?ts$/i
  const typeScriptModule = (file: string): string => stripTypeScriptTypes(fs.readFileSync(file, 'utf8'))
  // the plugins' public folders, as the config last loaded them
  let publicDirs: string[] = []
  const servable = (file: string) => assets.has(file) || publicDirs.some(dir => within(file, dir) && file !== dir)

  function asset(ref: string | URL): string {
    const file = toPath(ref)
    if (!assets.has(file)) {
      assets.add(file)
      const dir = path.dirname(file)
      if (!assetDirs.has(dir)) {
        assetDirs.add(dir)
        // .whiteboard/ itself is watched already (setFiles), and so are the engine's own files
        if (!within(dir, project.wb) && !ENGINE_WATCHED.some(d => within(dir, d))) {
          watch(dir, {}, name => onSourceChange(path.join(dir, name)))
        }
      }
    }
    return `${base}/_/file${file.split(path.sep).map(encodeURIComponent).join('/')}`
  }

  const within = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep)

  // ---- stored pages ------------------------------------------------------------------------------

  /** Resolve a path inside a base folder, refusing anything that escapes it. */
  function inside(base: string, rel: string): string | null {
    const p = path.resolve(base, '.' + path.posix.normalize('/' + rel))
    return within(p, base) ? p : null
  }

  const isRepoId = (id: string) => id === '-' || id.startsWith('-/')

  /** A page's frontmatter, parsed as YAML; empty, with the reason, when it isn't fields. */
  function frontmatter(source: string): { data: Record<string, unknown>; error: string | null } {
    const m = FRONTMATTER.exec(source)
    if (!m) return { data: {}, error: null }
    let data: unknown
    try {
      data = parseYaml(m[1]!)
    } catch (err) {
      return { data: {}, error: (err as Error).message }
    }
    if (data == null) return { data: {}, error: null }
    if (typeof data !== 'object' || Array.isArray(data))
      return { data: {}, error: 'it must be fields (`key: value` lines), not a single value or a list' }
    return { data: data as Record<string, unknown>, error: null }
  }

  function pageSource(id: string, file: string): PageSource {
    const source = fs.readFileSync(file, 'utf8')
    return {
      kind: 'page',
      id,
      file,
      mtime: fs.statSync(file).mtimeMs,
      source,
      body: source.replace(FRONTMATTER, ''),
      ...(({ data, error }) => ({ frontmatter: data, frontmatterError: error }))(frontmatter(source)),
    }
  }

  /**
   * The pages in a folder of the pages folder, newest first. When each was last answered and what
   * waits on it are the status's to say (withStatus).
   */
  function pagesIn(dir: string): PagesSource['pages'] {
    const out: PagesSource['pages'] = []
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const full = path.join(d, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (ent.name.endsWith('.md')) {
          const id = path.relative(project.pagesDir, full).split(path.sep).join('/').replace(/\.md$/, '')
          out.push({ id, file: full, mtime: fs.statSync(full).mtimeMs, lastEvent: null, awaiting: 0 })
        }
      }
    }
    walk(dir)
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  /** Text files show as files; anything with a NUL byte near the start is binary. */
  function isText(file: string): boolean {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(8192)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    return !buf.subarray(0, n).includes(0)
  }

  /**
   * A page id → the stored page, or one of: { redirect } (a folder asked for without its slash),
   * { raw: file } (serve the bytes), null (nothing there).
   */
  function stored(id: string): StoredPage | { raw: string } | null {
    if (!id) return { kind: 'pages', id: '', file: project.pagesDir, mtime: null, pages: pagesIn(project.pagesDir) }
    if (isRepoId(id)) {
      const rel = id.slice(2)
      const target = inside(project.dir, rel)
      if (!target || path.relative(project.dir, target).split(path.sep).includes('.git') || !fs.existsSync(target))
        return null
      const stat = fs.statSync(target)
      if (stat.isDirectory()) {
        const entries = fs
          .readdirSync(target, { withFileTypes: true })
          .filter(e => !SKIP_DIRS.has(e.name) && e.name !== '.DS_Store')
          .map(e => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        return { kind: 'folder', id, file: target, mtime: stat.mtimeMs, entries }
      }
      if (/\.(md|markdown)$/i.test(target)) return pageSource(id, target)
      if (stat.size > 1e6 || !isText(target)) return { raw: target }
      return { kind: 'file', id, file: target, mtime: stat.mtimeMs, source: fs.readFileSync(target, 'utf8') }
    }
    const target = inside(project.pagesDir, id)
    if (!target) return null
    if (path.extname(id) && fs.existsSync(target) && fs.statSync(target).isFile()) return { raw: target }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      const index = path.join(target, 'index.md')
      if (fs.existsSync(index)) return pageSource(id, index)
      return { kind: 'pages', id, file: target, mtime: null, pages: pagesIn(target) }
    }
    const file = target + '.md'
    return fs.existsSync(file) ? pageSource(id, file) : null
  }

  /** The URL that serves a file or folder on disk, or null when nothing here serves it. */
  function urlOf(abs: string): string | null {
    const rel = (dir: string) => path.relative(dir, abs).split(path.sep).map(encodeURIComponent).join('/')
    if (within(abs, project.pagesDir)) return `${base}/${rel(project.pagesDir).replace(/\.md$/, '')}`
    if (FILES && within(abs, project.dir)) {
      if (
        rel(project.dir)
          .split('/')
          .some(part => SKIP_DIRS.has(part))
      )
        return null
      return `${base}/-/${rel(project.dir)}`
    }
    return null
  }

  /** For links: the target if it exists (also with .md added), mapped to its URL. */
  function urlFor(abs: string): string | null {
    for (const candidate of [abs, abs + '.md']) {
      if (fs.existsSync(candidate)) {
        const url = urlOf(candidate)
        if (url) return url + (fs.statSync(candidate).isDirectory() && !url.endsWith('/') ? '/' : '')
      }
    }
    return null
  }

  // ---- rendering ---------------------------------------------------------------------------------

  /** A config that failed to load: the page as stored, as text, under the error. */
  function rawRender(page: StoredPage): Rendered {
    const list = (items: [string, string][]) =>
      html`<ul>
        ${items.map(([href, text]) => html`<li><a href="${href}">${text}</a></li>`)}
      </ul>`
    if (page.kind === 'pages') return { html: list(page.pages.map(p => [`${base}/${p.id}`, p.id])) }
    if (page.kind === 'folder') {
      return {
        html: list(
          page.entries.map(
            e => [encodeURIComponent(e.name) + (e.dir ? '/' : ''), e.name + (e.dir ? '/' : '')] as [string, string],
          ),
        ),
      }
    }
    return { html: html`<pre>${page.source}</pre>` }
  }

  const context = () => ({
    project: { name: projectName(), dir: project.dir, files: !!FILES },
    asset,
    urlFor,
    base,
    ...(entry && { entry: { name: entry, label } }),
  })

  /** A render as the shell takes it. `page`: whether the page's browser part runs (not on raw text). */
  interface Render {
    page: boolean
    out: Rendered
    notices: string[]
  }

  /** A stored page's frontmatter, for the browser (PageHandle.frontmatter): a markdown page's, else none. */
  const frontmatterOf = (page: StoredPage): Record<string, unknown> => (page.kind === 'page' ? page.frontmatter : {})

  /** Render a stored page as markdown, with the plugins' blocks, and anything the reader should be told. */
  async function render(page: StoredPage): Promise<Render> {
    const { pages, errors } = await config()
    const notices = errors.map(e => `config: ${(e as Error).message}`)
    if (page.kind === 'page' && page.frontmatterError) notices.push(`frontmatter: ${page.frontmatterError}`)
    let out: Rendered
    let rendered = !!pages
    try {
      out = pages ? await pages.render(page, context()) : rawRender(page)
    } catch (err) {
      console.error('render:', err)
      notices.push(`the page failed to render: ${(err as Error).message}`)
      out = rawRender(page)
      rendered = false
    }
    // HTML built with `html`: from here on it is a string, for the shell and for /api/render's JSON alike
    const strings = { ...out, html: String(out.html ?? ''), ...(out.head != null ? { head: String(out.head) } : {}) }
    return { page: rendered, out: strings, notices }
  }

  /**
   * The project's status (status.ts): the pages, below `only` when given, with their questions, the
   * log read once, and who listens. What `whiteboard status`, the hooks, the page lists and the log's
   * picked-up marks take.
   */
  async function snapshot(listed: PagesSource['pages']): Promise<ProjectStatus> {
    const { pages: renderer, handedOut, forReader } = await config()
    const pages = listed.map(p => {
      let asks: string[] = []
      try {
        asks = renderer?.questions(pageSource(p.id, p.file)) ?? []
      } catch (err) {
        console.error('questions:', err)
      }
      return { id: p.id, file: p.file, title: titleOf(p.file, path.basename(p.id)), asks }
    })
    return projectStatus({
      pages,
      events: readEvents(project.eventsFile),
      listeners: listenersFor,
      forAgent: forAgent(handedOut),
      forReader: type => forReader.has(type),
    })
  }

  /** Per page, below `only` when given: what `whiteboard status` and the hooks report (see snapshot). */
  const status = async (only: string | null): Promise<PageStatus[]> =>
    (await snapshot(pagesIn(project.pagesDir).filter(p => !only || p.id === only || p.id.startsWith(only + '/')))).pages

  /** A list of pages, with when each was last answered and how much waits on it, from one status. */
  async function withStatus(pages: PagesSource['pages']): Promise<PagesSource['pages']> {
    const s = await snapshot(pages)
    pages.forEach((p, i) => {
      p.awaiting = awaiting(s.pages[i]!)
      p.lastEvent = s.lastAnswered(p.id)
    })
    return pages
  }

  /** How to write pages here, as markdown: the pages' own docs, then each plugin's. */
  async function docs() {
    const { pages, errors } = await config()
    // what each plugin declares: its routes (for an agent that wants to call them) and commands
    const plugins = await Promise.all(
      (await pluginHooks()).map(async h => ({
        name: h.name,
        error: h.error?.message ?? null,
        docs: h.plugin.docs ? await h.plugin.docs() : null,
        routes: describeRoutes(h.table),
        commands: pluginCommands(h.plugin).map(c => ({
          name: c.name,
          usage: usage(c.command),
          description: c.command.description,
        })),
        events: Object.entries(h.plugin.events ?? {}).map(([type, spec]) => ({
          type,
          handOut: !!spec?.handOut,
          description: spec?.description ?? '',
        })),
      })),
    )
    return { errors: errors.map(e => (e as Error).message), pages: pages?.docs(context()) ?? null, plugins }
  }

  const json = (s: unknown) => JSON.stringify(s).replace(/</g, '\\u003c')

  // the page's corner (api.corner()): the one thing the core puts on every page, empty, for the
  // page's and the plugins' floating buttons and toasts; above what covers the bottom of the window.
  // Above the page and what floats on it (comment threads: 20), under what fills the window (a
  // maximized frame: 40, a lightbox or the terminal drawer: 50)
  const DOCK_STYLE =
    '#wb-dock{position:fixed;right:16px;bottom:calc(16px + var(--wb-inset-bottom,0px));z-index:30;display:flex;flex-direction:column;align-items:flex-end;gap:6px}#wb-dock:empty{display:none}' +
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

  /** `extras`: what plugins add to <head> and <body> (see shellExtras). */
  function shell(
    page: StoredPage,
    { page: rendered, out, notices }: Render,
    extras: Extras = { head: [], body: [], clients: [] },
    /** a built page (`whiteboard build`): its files as the build names them, and no server behind it */
    built?: { asset(ref: string | URL): string },
  ): string {
    const handoff = {
      id: page.id,
      kind: page.kind,
      live: !built,
      // what the page's own requests start with (see ServerOptions.base)
      base: built ? '' : base,
      client: rendered ? (built ?? { asset }).asset(PAGE_CLIENT) : null,
      data: out.data ?? null,
      frontmatter: frontmatterOf(page),
      plugins: extras.clients,
      messages: extras.messages ?? [],
    }
    // the page's head and html are HTML already; the handoff is JSON made safe for a script tag
    return String(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>${out.title || page.id || projectName()}</title>
            <style>
              ${DOCK_STYLE}
            </style>
            ${raw(out.head ?? '')}${extras.head}
          </head>
          <body data-page="${page.id}" data-kind="${page.kind}">
            ${notices.map(n => html`<pre class="wb-error" role="alert">${n}</pre>`)}
            <div id="wb-root">${raw(String(out.html))}</div>
            <div id="wb-dock"></div>
            <script type="application/json" id="wb-page">
              ${raw(json(handoff))}
            </script>
            <script type="module" src="${built ? built.asset(RUNTIME) : `${base}/_/runtime.js`}"></script>
            ${extras.body}
          </body>
        </html>`,
    )
  }

  // ---- listeners ---------------------------------------------------------------------------------
  // An agent waiting for answers holds a connection to /api/listen (listeners.ts). Pages show what an
  // agent is waiting for from these, so nothing depends on the agent marking it.
  const registry = createRegistry()
  const listenersFor = (page: string | null): Listener[] => registry.list(page)

  // ---- live changes ------------------------------------------------------------------------------
  // The browser listens on a WebSocket at /api/live, each message `{ event, data }`. `change`: its
  // page changed; `events`: the log grew; `listeners`: an agent started or stopped waiting; `style`:
  // a stylesheet changed; `reload`: browser code changed; `scroll`: an agent shows the reader a place
  // on the page ({ to }); `elsewhere`: under a shared server, what waits in another project changed.
  // /api/watch says the same as server-sent events, for a tab opened before
  // /api/live: it tells it to reload first, so it moves to the WebSocket (see ws.ts for why).

  /** A browser following its page; `pending`: what it will be told in a moment. */
  interface WatchClient {
    send(event: string, data?: unknown): void
    page: string
    isDir: boolean
    pending?: Set<string>
  }

  const clients = new Set<WatchClient>()
  /** what the browser appended lately, by id: a send it retries is answered with what it got */
  const appended = new Map<string, WbEvent>()
  function notify(client: WatchClient, kind: string) {
    client.pending ??= new Set()
    if (client.pending.size === 0)
      setTimeout(() => {
        for (const k of client.pending!) client.send(k)
        client.pending!.clear()
      }, 60)
    client.pending.add(kind)
  }
  const notifyAll = (kind: string) => {
    for (const c of clients) notify(c, kind)
  }
  // who listens shows on this project's pages, and, under a shared server, on the others' (onChange)
  registry.onChange(() => {
    notifyAll('listeners')
    onChange?.()
  })

  function pageChanged(id: string) {
    onChange?.()
    for (const c of clients) {
      if (c.isDir ? !c.page || id.startsWith(c.page + '/') : c.page === id || c.page + '/index' === id)
        notify(c, 'change')
    }
    // the overview lists every page
    for (const c of clients) if (c.isDir && !c.page) notify(c, 'change')
  }

  /** A file in the project changed; `f` is its path relative to the project folder, with / separators. */
  function fileChanged(f: string) {
    if (f.split('/').some(part => SKIP_DIRS.has(part))) return
    if (f.startsWith('.whiteboard/')) {
      const inner = f.slice('.whiteboard/'.length)
      if (inner === 'events.ndjson') {
        onChange?.()
        return notifyAll('events')
      }
      if (inner.startsWith('pages/')) {
        if (inner.endsWith('.md')) pageChanged(inner.slice('pages/'.length).replace(/\.md$/, ''))
        return
      }
      if (OWN_FILES.has(inner) || pluginDirs.has(inner.split('/')[0]!)) return
      // the config, or something it imports
      return onSourceChange(path.join(project.dir, f))
    }
    if (!FILES) return
    // a repository file; its folder's listing shows it too
    pageChanged(`-/${f}`)
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
    pageChanged(`-${parent ? '/' + parent : ''}`)
  }

  // With files on, the whole project folder is watched (repository views stay live); with files off,
  // only .whiteboard/, so a project in a large folder such as the home folder stays cheap.
  let FILES: boolean | null = null
  let watcher: fs.FSWatcher | null = null
  function setFiles(files: boolean) {
    if (files === FILES) return
    FILES = files
    if (watcher) {
      watcher.close()
      watchers.delete(watcher)
    }
    const base = files ? project.dir : project.wb
    const prefix = files ? '' : '.whiteboard/'
    watcher = fs.watch(base, { recursive: true }, (_evt, filename) => {
      if (filename) fileChanged(prefix + filename.replace(/\\/g, '/'))
    })
    watchers.add(watcher)
  }

  // What a plugin or the config is made of changed. A stylesheet reloads in place; a browser module
  // reloads the pages; anything else loads the config afresh and re-renders open pages.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  async function onSourceChange(file: string) {
    if (within(file, project.pagesDir)) return
    if (path.dirname(file) === project.wb && OWN_FILES.has(path.basename(file))) return
    if ([...pluginDirs].some(name => within(file, path.join(project.wb, name)))) return
    if (file.endsWith('.css')) return notifyAll('style')
    if (file.endsWith('.md')) return notifyAll('change')
    if (file === RUNTIME || assets.has(file)) return notifyAll('reload')
    // a build writes several files at once: load the config once they are all there
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      loader.invalidate()
      config().then(() => notifyAll('change'))
    }, 80)
  }

  // The engine's own files, when it runs from source: what a config loads from it runs from source
  // too (the plugins), and the browser code from its build (npm run dev). A change to
  // either reloads what it is made of, like a project's own files.
  const ENGINE_BUILD = path.join(ENGINE_DIR, 'dist')
  const ENGINE_WATCHED = !FROM_SOURCE ? [] : [ENGINE_BUILD, ...['plugins'].map(d => path.join(ENGINE_DIR, d))]
  for (const dir of ENGINE_WATCHED) watch(dir, { recursive: true }, name => onSourceChange(path.join(dir, name)))

  // ---- http --------------------------------------------------------------------------------------

  function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  const sendJson = (res: ServerResponse, status: number, data: unknown) =>
    send(res, status, JSON.stringify(data), 'application/json')
  const sendFile = (res: ServerResponse, file: string) =>
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 1e6) {
          reject(new Error('body too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** What a page id resolves to, or why it does not: the response to send instead. */
  type Resolved = { page: StoredPage } | { raw: string } | { redirect: string } | { notFound: string }

  async function resolve(id: string, requested: string): Promise<Resolved> {
    await config()
    if (isRepoId(id) && !FILES)
      return { notFound: 'This project does not serve its files: its config sets files: false.' }
    if (id === '_/docs') {
      // how pages are written, then each plugin's own docs, with their examples rendered live
      const { pages, plugins } = await docs()
      const source = [
        pages ?? '',
        ...plugins.filter(p => p.docs).map(p => `<a id="plugin-${p.name}"></a>\n\n${p.docs}`),
      ].join('\n\n---\n\n')
      return {
        page: {
          kind: 'page',
          id,
          file: path.join(project.pagesDir, '_docs.md'),
          mtime: null,
          source,
          body: source,
          frontmatter: {},
        },
      }
    }
    const found = stored(id)
    if (!found)
      return {
        notFound: `${isRepoId(id) ? id.slice(2) : id} does not exist${isRepoId(id) ? '' : ' yet. This page loads as soon as it does'}.`,
      }
    if ('raw' in found) return found
    // a folder is served at /dir/, so relative links resolve inside it
    if ((found.kind === 'folder' || (found.kind === 'pages' && id)) && !requested.endsWith('/'))
      return { redirect: `${base}/${id}/` }
    // a list of pages says which await the reader: where their questions stand takes the config
    if (found.kind === 'pages') {
      await withStatus(found.pages)
      if (!found.id && overview) Object.assign(found, await overview())
    }
    return { page: found }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // a path like //x would otherwise read as a host
      const url = new URL((req.url ?? '/').replace(/^\/+/, '/'), 'http://localhost')
      const p = decodeURIComponent(url.pathname)
      const q = Object.fromEntries(url.searchParams)

      if (p === '/favicon.ico') {
        res.writeHead(204)
        res.end()
        return
      }
      if (p === '/_/runtime.js') return sendFile(res, RUNTIME)
      if (auth.handle(req, res, p, q)) return
      if (p.startsWith('/api/')) {
        const hooks = await pluginHooks()
        for (const h of hooks) if (await dispatch(h.table, req, res, url, auth.authorized)) return
        // under a plugin's name, but none of its routes
        const owner = hooks.find(h => p.startsWith(`/api/${h.name}/`) || p === `/api/${h.name}`)
        if (owner) return sendJson(res, 404, { error: `plugin ${owner.name} has no route ${req.method} ${p}` })
      }
      if (p.startsWith('/_/file/')) {
        await config()
        const file = path.resolve(p.slice('/_/file'.length))
        if (!servable(file) || !fs.existsSync(file) || !fs.statSync(file).isFile())
          return send(res, 404, 'not found', 'text/plain')
        // watched from now on, so a change to it reloads the pages that use it
        asset(file)
        if (TYPESCRIPT.test(file)) {
          try {
            return send(res, 200, typeScriptModule(file), 'text/javascript; charset=utf-8')
          } catch (err) {
            // syntax only types can't express (an enum, a namespace) or a mistake: the browser says why
            return send(
              res,
              200,
              `throw new SyntaxError(${JSON.stringify(`${path.basename(file)}: ${(err as Error).message}`)})`,
              'text/javascript; charset=utf-8',
            )
          }
        }
        return sendFile(res, file)
      }
      if (p === '/api/health')
        return sendJson(res, 200, { ok: true, dir: project.dir, pid: process.pid, version: VERSION, base })
      if (p === '/api/events' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        if (!body.type) return sendJson(res, 400, { error: 'event type required' })
        // the browser sends it again when it heard nothing back: appended once, the same answer twice
        const again = isEventId(body.id) ? appended.get(body.id) : undefined
        if (again) return sendJson(res, 200, again)
        const event = appendEvent(project.eventsFile, body)
        appended.set(event.id, event)
        if (appended.size > 1000) appended.delete(appended.keys().next().value!)
        return sendJson(res, 200, event)
      }
      // an agent shows the reader a place on a page: every tab with it open scrolls there
      // ({ page, to }: a heading's text, a form's name or any text) → { tabs }
      if (p === '/api/scroll' && req.method === 'POST') {
        const { page: id, to } = JSON.parse(await readBody(req)) as { page?: unknown; to?: unknown }
        if (typeof id !== 'string' || typeof to !== 'string' || !to.trim())
          return sendJson(res, 400, { error: 'page and to required' })
        let tabs = 0
        for (const c of clients) {
          if (c.isDir || (c.page !== id && c.page + '/index' !== id)) continue
          c.send('scroll', { to })
          tabs++
        }
        return sendJson(res, 200, { tabs })
      }
      // messages (comments, chat) written in markdown, as HTML: { texts } → { html, styles }
      if (p === '/api/markdown' && req.method === 'POST') {
        const { texts } = JSON.parse(await readBody(req)) as { texts?: unknown }
        if (!Array.isArray(texts)) return sendJson(res, 400, { error: 'texts: an array of strings' })
        const { pages } = await config()
        const out = await Promise.all(
          texts.map(t =>
            pages
              ? pages.message(String(t ?? ''), context())
              : Promise.resolve({ html: String(html`${String(t ?? '')}`), styles: [] }),
          ),
        )
        return sendJson(res, 200, { html: out.map(o => o.html), styles: [...new Set(out.flatMap(o => o.styles))] })
      }
      if (p === '/api/events') {
        const all = readEvents(project.eventsFile)
        const picked = pickedUp(all)
        return sendJson(
          res,
          200,
          all.filter(e => matches(e, q)).map(e => (picked.has(e.id) ? { ...e, pickedUp: true } : e)),
        )
      }
      if (p === '/api/docs') return sendJson(res, 200, await docs())
      if (p === '/api/status') return sendJson(res, 200, await status(q.page || null))
      if (p === '/api/listeners') return sendJson(res, 200, listenersFor(q.page ?? null))
      if (p === '/api/listen') {
        const remove = registry.add(listenerOf(url.searchParams))
        if (!remove) return sendJson(res, 409, { error: 'another agent is the fallback already' })
        // a fallback is told who else listens, at once and on every change
        const off = 'fallback' in q ? registry.onChange(() => tell()) : () => {}
        const stream = holdStream(req, res, () => {
          off()
          remove()
          streams.delete(stream.end)
        })
        const tell = () =>
          stream.send('listeners', { projects: [{ dir: project.dir, base, listeners: registry.list() }] })
        if ('fallback' in q) tell()
        streams.add(stream.end)
        return
      }
      if (p === '/api/page' || p === '/api/render') {
        const r = await resolve(q.page ?? '', '/')
        if (!('page' in r)) return sendJson(res, 404, { error: 'notFound' in r ? r.notFound : 'not a page' })
        if (p === '/api/page') return sendJson(res, 200, r.page)
        const { out, notices } = await render(r.page)
        return sendJson(res, 200, { ...out, notices, mtime: r.page.mtime, frontmatter: frontmatterOf(r.page) })
      }
      if (p === '/api/watch') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        const client: WatchClient = {
          send: (event, data = {}) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          page: q.page || '',
          isDir: 'dir' in q,
        }
        clients.add(client)
        // a tab from before /api/live: onto the WebSocket, which leaves its connection free
        client.send('reload')
        const ping = setInterval(() => res.write(': ping\n\n'), 25000)
        const end = () => {
          clearInterval(ping)
          clients.delete(client)
          streams.delete(end)
        }
        streams.add(() => {
          end()
          res.end()
        })
        req.on('close', end)
        return
      }

      const path_ = p.replace(/^\/+/, '').replace(/\/+$/, '')
      // a page is named without .md; a repository path is the file's own
      const id = isRepoId(path_) ? path_ : path_.replace(/\.md$/, '')
      const r = await resolve(id, p)
      if ('redirect' in r) {
        res.writeHead(302, { location: r.redirect + url.search })
        res.end()
        return
      }
      if ('raw' in r) return sendFile(res, r.raw)
      if ('notFound' in r) {
        // rendered as a page, with the page's styles and the plugins', and live: it becomes the page
        // once the page is there. The message holds the path from the URL: escaped, so it shows as
        // written and makes no markup or block
        const said = r.notFound.replace(/[\\`*_[\]{}()<>#!:|~&-]/g, '\\$&')
        const md = `# Not found\n\n${said}\n`
        const missing: PageSource = { kind: 'page', id, file: '', mtime: null, source: md, body: md, frontmatter: {} }
        return send(res, 404, await page(req, missing, await render(missing)))
      }
      return send(res, 200, await page(req, r.page, await render(r.page)))
    } catch (err) {
      console.error(err)
      send(res, 500, String((err as Error)?.stack || err), 'text/plain')
    }
  }

  // ---- build: a static site ---------------------------------------------------------------------
  // Pages rendered once (`whiteboard build`), as files: each page's HTML with its links relative, and
  // what it loads copied beside it. See BuildConfig.

  /** What a build leaves out unless told otherwise: what is for writing a page, not for reading it. */
  const BUILD_SKIP = ['form', 'chat', 'comments', 'draft']
  /** In the folder a build writes, so that a next build knows it may replace it. */
  const BUILD_MARK = '.whiteboard-build'

  async function build(options: BuildConfig = {}): Promise<BuildResult> {
    const cfg = await config()
    if (cfg.errors.length) throw new Error(`the config failed to load: ${(cfg.errors[0] as Error).message}`)
    if (!cfg.pages) throw new Error('the config has no pages renderer')
    const pages = cfg.pages
    const defined = <T>(...xs: (T | undefined)[]) => xs.find(x => x !== undefined)
    const patterns = defined(options.pages, cfg.build.pages) ?? []
    const skip = new Set(defined(options.skip, cfg.build.skip) ?? BUILD_SKIP)
    const outDir = path.resolve(project.dir, defined(options.out, cfg.build.out) ?? 'site')
    if (!patterns.length)
      throw new Error(
        "nothing to build: name the pages, as globs from the project's folder (whiteboard build 'docs/**/*.md'), or set build.pages in the config",
      )
    const warnings: string[] = []

    // the pages: markdown files the globs match, but those a `!` glob leaves out
    const include = patterns.filter(p => !p.startsWith('!'))
    const exclude = patterns.filter(p => p.startsWith('!')).map(p => p.slice(1))
    const files = [
      ...new Set(include.flatMap(p => fs.globSync(p, { cwd: project.dir }).map(f => path.resolve(project.dir, f)))),
    ]
      .filter(f => /\.(md|markdown)$/i.test(f) && fs.statSync(f).isFile())
      .filter(f => !exclude.some(g => path.matchesGlob(path.relative(project.dir, f), g)))
      .sort()
    if (!files.length) throw new Error(`no markdown files match ${patterns.join(' ')}`)
    // each at its place below the folder they share; a README or index is its folder's index.html
    const base = files.map(path.dirname).reduce((a, b) => {
      while (!within(b, a)) a = path.dirname(a)
      return a
    })
    const outOf = (file: string) => {
      const rel = path.relative(base, file)
      return path.join(
        outDir,
        /^(readme|index)\.(md|markdown)$/i.test(path.basename(rel))
          ? path.join(path.dirname(rel), 'index.html')
          : rel.replace(/\.(md|markdown)$/i, '.html'),
      )
    }
    const built = new Map(files.map(f => [f, outOf(f)]))

    // the folder it writes: new, empty, or what an earlier build wrote
    if (fs.existsSync(outDir)) {
      if (fs.readdirSync(outDir).length && !fs.existsSync(path.join(outDir, BUILD_MARK)))
        throw new Error(`${outDir} has files a build didn't write: give another folder (--out), or empty it`)
      fs.rmSync(outDir, { recursive: true })
    }
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(
      path.join(outDir, BUILD_MARK),
      'written by whiteboard build; the next build replaces this folder\n',
    )

    // what a page loads, copied once: the package's files under _/whiteboard/, the project's under
    // _/project/, at their places there (so a stylesheet's url()s still hold); TypeScript as JavaScript
    const copied = new Map<string, string>()
    function copyAsset(file: string): string {
      const known = copied.get(file)
      if (known) return known
      const rel = within(file, ENGINE_DIR)
        ? path.join('_', 'whiteboard', path.relative(ENGINE_DIR, file))
        : within(file, project.dir)
          ? path.join('_', 'project', path.relative(project.dir, file))
          : path.join('_', 'files', path.basename(path.dirname(file)), path.basename(file))
      const dest = path.join(outDir, TYPESCRIPT.test(rel) ? rel.replace(/\.m?ts$/i, '.js') : rel)
      copied.set(file, dest)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (TYPESCRIPT.test(file)) fs.writeFileSync(dest, typeScriptModule(file))
      else fs.copyFileSync(file, dest)
      // a stylesheet's own files (fonts, images), at the same places beside it
      if (/\.css$/i.test(file)) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
          const ref = m[1]!
          if (/^(data:|[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) continue
          const target = path.resolve(path.dirname(file), ref.replace(/[?#].*$/, ''))
          if (fs.existsSync(target) && fs.statSync(target).isFile()) copyAsset(target)
        }
      }
      return dest
    }
    /** a file beside the pages (an image), copied to its place below the site */
    function copyBeside(file: string): string | null {
      if (!within(file, base)) return null
      const dest = path.join(outDir, path.relative(base, file))
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(file, dest)
      }
      return dest
    }

    const hooks = await pluginHooks()
    const result: BuildResult = { out: outDir, pages: [], warnings }
    for (const [file, dest] of built) {
      const here = path.dirname(dest)
      const relTo = (target: string) =>
        path.relative(here, target).split(path.sep).map(encodeURIComponent).join('/') || '.'
      const assetHere = (ref: string | URL) => relTo(copyAsset(toPath(ref)))
      const urlFor = (abs: string): string | null => {
        for (const candidate of [abs, abs + '.md']) {
          if (!fs.existsSync(candidate)) continue
          if (fs.statSync(candidate).isDirectory()) {
            const index = [...built.keys()].find(
              f => path.dirname(f) === candidate && /^(readme|index)\.(md|markdown)$/i.test(path.basename(f)),
            )
            if (index) return relTo(built.get(index)!)
            continue
          }
          if (built.has(candidate)) return relTo(built.get(candidate)!)
          if (/\.(md|markdown)$/i.test(candidate)) {
            warnings.push(
              `${path.relative(project.dir, file)} links to ${path.relative(project.dir, candidate)}, which is not in the build`,
            )
            return null
          }
          const copy = copyBeside(candidate)
          if (copy) return relTo(copy)
          warnings.push(
            `${path.relative(project.dir, file)} links to ${path.relative(project.dir, candidate)}, outside the built pages' folder`,
          )
          return null
        }
        return null
      }
      const id = within(file, project.pagesDir)
        ? path
            .relative(project.pagesDir, file)
            .split(path.sep)
            .join('/')
            .replace(/\.(md|markdown)$/i, '')
        : '-/' + path.relative(project.dir, file).split(path.sep).join('/')
      const stored = pageSource(id, file)
      if (stored.frontmatterError)
        warnings.push(`${path.relative(project.dir, file)}: frontmatter: ${stored.frontmatterError}`)
      const context = {
        project: { name: project.name, dir: project.dir, files: !!FILES },
        asset: assetHere,
        urlFor,
        live: false,
        skip,
      }
      const rendered = await pages.render(stored, context)
      // a page without a heading of its own is named by its file (a README by its folder), not by
      // the id the server knows it by
      const named = /^(readme|index)\.(md|markdown)$/i.test(path.basename(file))
        ? path.basename(path.dirname(file))
        : path.basename(file).replace(/\.(md|markdown)$/i, '')
      const title = !rendered.title || rendered.title === id ? named : rendered.title
      const out = { ...rendered, title, html: String(rendered.html ?? ''), head: String(rendered.head ?? '') }
      // the plugins' browser modules, but those the build leaves out; not what they add to a live
      // page's shell (the terminal's drawer): that is the server's
      const included = hooks.filter(h => !h.error && !skip.has(h.name))
      const clients = included.filter(h => h.client).map(h => ({ name: h.name, client: assetHere(h.client!) }))
      // what the plugins add to the shell, asked with no request: no browser asked for this page
      const parts = await Promise.all(
        included.map(async h => {
          try {
            return (await h.shell?.(null)) ?? null
          } catch (err) {
            warnings.push(`plugin ${h.name} failed on ${path.relative(project.dir, file)}: ${(err as Error).message}`)
            return null
          }
        }),
      )
      const extras = {
        head: parts.map(x => raw(String(x?.head ?? ''))),
        body: parts.map(x => raw(String(x?.body ?? ''))),
        clients,
      }
      let doc = shell(stored, { page: true, out, notices: [] }, extras, { asset: assetHere })
      // a file a plugin named the server's way (its asset URL, /_/file/<path>): its copy
      doc = doc.replace(/\/_\/file(\/[^"'\s)<>]+)/g, (all, served: string) => {
        let file: string
        try {
          file = path.resolve(served.split('/').map(decodeURIComponent).join(path.sep))
        } catch {
          return all
        }
        return fs.existsSync(file) && fs.statSync(file).isFile() ? assetHere(file) : all
      })
      // what the blocks name relative to the page (an ::image's src, an iframe's page): copied too
      doc = doc.replace(/\b(src|href|poster)="([^"#?:]+)([^"]*)"/g, (all, _attr, ref: string) => {
        if (ref.startsWith('/') || ref.startsWith('_/') || ref.startsWith('../')) return all
        let decoded = ref
        try {
          decoded = decodeURIComponent(ref)
        } catch {
          /* as written */
        }
        const source = path.resolve(path.dirname(file), decoded)
        if (fs.existsSync(source) && fs.statSync(source).isFile() && !/\.(md|markdown)$/i.test(source)) {
          const target = path.resolve(here, decoded)
          if (within(target, outDir) && !fs.existsSync(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.copyFileSync(source, target)
          }
        }
        return all
      })
      fs.mkdirSync(here, { recursive: true })
      fs.writeFileSync(dest, doc)
      result.pages.push({ file, to: dest })
    }
    if (![...built.values()].includes(path.join(outDir, 'index.html')))
      warnings.push('no README.md or index.md in the top folder: the site has no index.html')
    return result
  }

  /** The live channel: /api/live, a WebSocket from a page of this server's (see ws.ts). */
  function upgrade(req: IncomingMessage, conn: Duplex, _head: Buffer) {
    const url = new URL((req.url ?? '/').replace(/^\/+/, '/'), 'http://localhost')
    if (decodeURIComponent(url.pathname) !== '/api/live') return refuse(conn, 404, 'Not Found')
    // no CORS for a WebSocket: any site could open one to localhost, so the origin is checked here
    if (!sameSite(req)) return refuse(conn, 403, 'Forbidden')
    const socket = accept(req, conn)
    if (!socket) return
    const client: WatchClient = {
      send: (event, data = {}) => socket.send(JSON.stringify({ event, data })),
      page: url.searchParams.get('page') ?? '',
      isDir: url.searchParams.has('dir'),
    }
    clients.add(client)
    const stop = () => socket.close()
    streams.add(stop)
    socket.onClose(() => {
      clients.delete(client)
      streams.delete(stop)
    })
  }

  return {
    handle,
    upgrade,
    listeners: () => listenersFor(null),
    async overview() {
      await config()
      const pages = await withStatus(pagesIn(project.pagesDir))
      return { pages, files: !!FILES }
    },
    touch() {
      for (const c of clients) if (c.isDir && !c.page) notify(c, 'change')
    },
    elsewhere: () => notifyAll('elsewhere'),
    addListener: l => registry.add(l),
    onListeners: fn => registry.onChange(fn),
    status: (page = null) => status(page),
    config,
    build,
    close() {
      for (const w of watchers) w.close()
      watchers.clear()
      for (const stop of [...streams]) stop()
      clearTimeout(reloadTimer)
    },
  }
}
