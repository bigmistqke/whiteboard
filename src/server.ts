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
import crypto from 'node:crypto'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import type { Project } from './config.ts'
import { appendEvent, isEventId, readEvents, matches, takenIds, handledIds, forAgent } from './events.ts'
import { html, raw } from './html.ts'
import { createConfigLoader, pluginDir, toPath, type LoadedConfig } from './loader.ts'
import { describeRoutes, dispatch, pluginCommands, mountRoutes, usage } from './plugins.ts'
import { createAuth, sameSite } from './auth.ts'
import { accept, refuse } from './ws.ts'
import { FROM_SOURCE, PACKAGE_DIR, VERSION } from './package.ts'
import { SCROLL, awaiting, projectStatus, type ProjectStatus } from './status.ts'
import { titleOf } from './pages/render.ts'
import { createRegistry, holdStream, listenerOf } from './listeners.ts'
import { inPublic } from './public.ts'
import { build, type BuildResult } from './build.ts'
import { PAGE_CLIENT, RUNTIME, frontmatterOf, pageDocument, pluginParts, type Render, type SetUp } from './document.ts'
import { SKIP_DIRS, isRepoId, pageSource, servedSite, within } from './site.ts'
import type {
  Listener,
  PageSource,
  PageStatus,
  Rendered,
  StoredPage,
  PagesSource,
  BuildConfig,
  WbEvent,
} from './define.ts'

const ENGINE_DIR = PACKAGE_DIR
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

export type { BuildResult }

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
              // what it serves is in its public folder: its client, named in its hooks
              const dir = c.publicDirs.get(e.name)!
              const hooks =
                (await e.setup?.({
                  project: { name: project.name, dir: project.dir, wb: project.wb },
                  dataDir,
                  authorized: auth.authorized,
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

  /** A page as the server serves it: the render with what the plugins add, their failures among its notices. */
  async function page(req: IncomingMessage, stored: StoredPage, rendered: Render): Promise<string> {
    const notices = [...rendered.notices]
    const parts = await pluginParts(await pluginHooks(), req, {
      asset,
      messages: [...(await config()).forReader],
      failed: message => {
        console.error(message)
        notices.push(message)
      },
    })
    return pageDocument(stored, { ...rendered, notices }, parts, {
      live: true,
      base,
      asset,
      runtime: `${base}/_/runtime.js`,
      title: projectName(),
      stamps: stamps(),
    })
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

  // ---- stored pages: the site (site.ts) --------------------------------------------------------------
  const site = servedSite(project, { base, files: () => !!FILES })
  const stored = site.page
  const pagesIn = site.pagesIn
  const urlFor = site.urlFor

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
  // Each page's questions and title, kept while its file and the config stay as they are: parsing
  // every page's markdown on each ask was most of what a status cost.
  const asked = new Map<
    string,
    { file: string; mtime: number; size: number; renderer: unknown; title: string; asks: string[] }
  >()
  function questionsOf(renderer: LoadedConfig['pages'], id: string, file: string): { title: string; asks: string[] } {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return { title: path.basename(id), asks: [] }
    }
    const kept = asked.get(id)
    if (
      kept &&
      kept.file === file &&
      kept.mtime === stat.mtimeMs &&
      kept.size === stat.size &&
      kept.renderer === renderer
    )
      return kept
    let asks: string[] = []
    try {
      asks = renderer?.questions(pageSource(id, file)) ?? []
    } catch (err) {
      console.error('questions:', err)
    }
    const now = { file, mtime: stat.mtimeMs, size: stat.size, renderer, title: titleOf(file, path.basename(id)), asks }
    asked.set(id, now)
    return now
  }

  async function snapshot(listed: PagesSource['pages']): Promise<ProjectStatus> {
    const { pages: renderer, handedOut, forReader } = await config()
    const pages = listed.map(p => ({ id: p.id, file: p.file, ...questionsOf(renderer, p.id, p.file) }))
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

  /**
   * What the browser runs and how it looks, as two stamps: one over its code (the runtime, the page's
   * module, the plugins' scripts), one over its stylesheets (the engine's, the plugins', the
   * project's in .whiteboard/). A page gets them with its HTML and asks again when its live channel
   * is back: what changed while it was away (a restart, a background tab whose browser held its
   * timers), it would otherwise never hear of. Made from the files themselves, not from what was
   * served since the server started, so a fresh server gives the same stamps for the same files.
   */
  function stamps(): { code: string; style: string } {
    const files: string[] = [RUNTIME]
    const add = (dir: string, deep: boolean) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (deep) add(full, deep)
        } else files.push(full)
      }
    }
    add(path.dirname(PAGE_CLIENT), false)
    for (const dir of publicDirs) add(dir, true)
    for (const f of fs.readdirSync(project.wb).filter(f => f.endsWith('.css'))) files.push(path.join(project.wb, f))
    const of = (list: string[]) => {
      const hash = crypto.createHash('sha1')
      for (const f of [...new Set(list)].toSorted()) {
        try {
          const st = fs.statSync(f)
          hash.update(`${f}\0${st.mtimeMs}\0${st.size}\n`)
        } catch {
          /* gone */
        }
      }
      return hash.digest('hex').slice(0, 16)
    }
    return { code: of(files.filter(f => !f.endsWith('.css'))), style: of(files.filter(f => f.endsWith('.css'))) }
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
        // in the log, so a tab that isn't connected now (a server restarting, a background tab
        // whose browser holds its timers) still scrolls there once it is back; a page loaded later
        // doesn't (see the runtime)
        appendEvent(project.eventsFile, { page: id, type: SCROLL, data: { to } }, 'cli')
        let tabs = 0
        for (const c of clients) if (!c.isDir && (c.page === id || c.page + '/index' === id)) tabs++
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
        // what became of each: taken by a wait, handled by the agent (status.ts)
        const taken = takenIds(all)
        const handled = handledIds(all)
        return sendJson(
          res,
          200,
          all
            .filter(e => matches(e, q))
            .map(e => ({ ...e, ...(taken.has(e.id) && { taken: true }), ...(handled.has(e.id) && { handled: true }) })),
        )
      }
      if (p === '/api/docs') return sendJson(res, 200, await docs())
      if (p === '/api/status') return sendJson(res, 200, await status(q.page || null))
      if (p === '/api/listeners') return sendJson(res, 200, listenersFor(q.page ?? null))
      if (p === '/api/stamps') return sendJson(res, 200, stamps())
      if (p === '/api/listen') {
        const l = listenerOf(url.searchParams)
        // one wait or watch a page: a second is refused, unless it takes the page over (--force)
        const holder = registry.holder(l)
        if (holder && !('force' in q)) {
          const since = new Date(holder.since).toTimeString().slice(0, 5)
          return sendJson(res, 409, {
            error: `another ${holder.listener.command} has waited on ${l.page}${holder.listener.type ? ` for ${holder.listener.type}` : ''} since ${since}; --force takes it over (that one then stops)`,
          })
        }
        if (holder) registry.evict(l)
        const remove = registry.add(l, () => {
          stream.send('replaced', { page: l.page })
          stream.end()
        })
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
    build: options => build({ project, config, hooks: pluginHooks, files: () => !!FILES }, options),
    close() {
      for (const w of watchers) w.close()
      watchers.clear()
      for (const stop of [...streams]) stop()
      clearTimeout(reloadTimer)
    },
  }
}
