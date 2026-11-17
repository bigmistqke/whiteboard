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
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from './config.ts'
import { appendEvent, readEvents, matches, pickedUp, fromReader, CLAIM } from './events.ts'
import { html, raw, type Html } from './html.ts'
import { createConfigLoader, pluginDir, toPath, type LoadedConfig } from './loader.ts'
import { describeRoutes, dispatch, pluginCommands, mountRoutes, usage, type MountedRoute } from './plugins.ts'
import { createAuth } from './auth.ts'
import { FROM_SOURCE, PACKAGE_DIR } from './package.ts'
import { questionState } from './status.ts'
import type { Listener, PageSource, PageStatus, Plugin, PluginHooks, Rendered, StoredPage, PagesSource } from './define.ts'

const ENGINE_DIR = PACKAGE_DIR
// the browser runtime, built by build.ts
const RUNTIME = path.join(ENGINE_DIR, 'dist', 'client', 'runtime.js')
// the page in the browser (markdown live: morphing, blocks' islands, forms' marks), built by build.ts
const PAGE_CLIENT = path.join(ENGINE_DIR, 'dist', 'src', 'client', 'page', 'main.js')
const MIME: Record<string, string> = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
}
// files in .whiteboard/ that are the server's own bookkeeping, not content
const OWN_FILES = new Set(['events.ndjson', 'server.json', 'server.log', 'server.lock', 'token'])
const SKIP_DIRS = new Set(['node_modules', '.git'])
// a page's frontmatter: `---` lines around `key: value` lines, at the very start
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/


/** A project's server: its request handler, and what it knows. */
export interface WhiteboardServer {
  /** answer one request */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** what is open on each page (or on `page` and below), as /api/status gives it */
  status(page?: string | null): Promise<PageStatus[]>
  /** the project's config, loaded */
  config(): Promise<LoadedConfig>
  /** stop watching and end the live connections; the server answers nothing after */
  close(): void
}

export function createServer(project: Project): WhiteboardServer {
  const loader = createConfigLoader(project)
  const auth = createAuth(project.wb)
  // what close() stops: watchers, and the live connections' pings and responses
  const watchers = new Set<fs.FSWatcher>()
  const streams = new Set<() => void>()
  const watch = (dir: string, options: fs.WatchOptions, fn: (name: string) => void) => {
    try { watchers.add(fs.watch(dir, options, (_evt, name) => { if (name) fn(String(name)) })) } catch { /* gone, or not built */ }
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
      setups.set(c, Promise.all(c.plugins.map(async (e): Promise<SetUp> => {
        try {
          pluginDirs.add(e.name)
          const dataDir = pluginDir(project.wb, e.name)
          const hooks = (await e.setup?.({ project: { name: project.name, dir: project.dir, wb: project.wb }, dataDir, authorized: auth.authorized, asset })) ?? {}
          return { name: e.name, ...hooks, table: mountRoutes(e.name, hooks.routes), plugin: e }
        } catch (err) {
          console.error(`plugin ${e.name}:`, err)
          return { name: e.name, table: [], plugin: e, error: err as Error }
        }
      })))
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
    notices?: string[]
  }

  async function shellExtras(req: IncomingMessage): Promise<Extras & { notices: string[] }> {
    const hooks = await pluginHooks()
    const notices = hooks.filter(h => h.error).map(h => `plugin "${h.name}" failed to start: ${h.error!.message}`)
    const parts = await Promise.all(hooks.map(async h => {
      try { return (await h.shell?.(req)) ?? null } catch (err) {
        console.error(`plugin ${h.name}:`, err)
        notices.push(`plugin "${h.name}" failed on this page: ${(err as Error).message}`)
        return null
      }
    }))
    // their browser modules, which the runtime imports after the page's
    const clients = hooks.filter(h => h.client && !h.error).map(h => ({ name: h.name, client: asset(h.client!) }))
    return { head: parts.map(x => raw(String(x?.head ?? ''))), body: parts.map(x => raw(String(x?.body ?? ''))), clients, notices }
  }

  /** A page with what the plugins add, their notices among the page's. */
  async function page(req: IncomingMessage, stored: StoredPage, rendered: Render): Promise<string> {
    const extras = await shellExtras(req)
    return shell(stored, { ...rendered, notices: [...rendered.notices, ...extras.notices] }, extras)
  }

  /** The loaded config. Also applies its `files` setting to what is served and watched. */
  async function config(): Promise<LoadedConfig> {
    const c = await loader.config()
    setFiles(c.files)
    return c
  }

  // ---- assets: files a plugin asks to serve -------------------------------------------------------
  // Served at /_/file/<absolute path>, only once asked for. Beside a file asked for, its neighbours
  // too, since a client module may import them, but only browser assets (scripts, styles, images,
  // fonts): a plugin's module in .whiteboard/ must not open up the project's token, log or config.
  // Those folders are watched from then on.

  const assets = new Set<string>()
  const assetDirs = new Set<string>()
  const BROWSER_ASSET = /\.(m?js|css|map|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)$/i
  const servable = (file: string) => assets.has(file) || (assetDirs.has(path.dirname(file)) && BROWSER_ASSET.test(file))

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
    return `/_/file${file.split(path.sep).map(encodeURIComponent).join('/')}`
  }

  const within = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep)

  // ---- stored pages ------------------------------------------------------------------------------

  /** Resolve a path inside a base folder, refusing anything that escapes it. */
  function inside(base: string, rel: string): string | null {
    const p = path.resolve(base, '.' + path.posix.normalize('/' + rel))
    return within(p, base) ? p : null
  }

  const isRepoId = (id: string) => id === '-' || id.startsWith('-/')

  function frontmatter(source: string): Record<string, string> {
    const m = FRONTMATTER.exec(source)
    const out: Record<string, string> = {}
    if (m) for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line)
      if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, '')
    }
    return out
  }

  function pageSource(id: string, file: string): PageSource {
    const source = fs.readFileSync(file, 'utf8')
    return { kind: 'page', id, file, mtime: fs.statSync(file).mtimeMs, source, body: source.replace(FRONTMATTER, ''), frontmatter: frontmatter(source) }
  }

  /** The pages in a folder of the pages folder, newest first, with when each was last answered. */
  function pagesIn(dir: string): PagesSource['pages'] {
    const last = new Map<string, string>()
    // the last time the reader sent something: what the agent appended doesn't count
    for (const e of readEvents(project.eventsFile)) if (fromReader(e)) last.set(e.page, e.ts)
    const out: PagesSource['pages'] = []
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const full = path.join(d, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (ent.name.endsWith('.md')) {
          const id = path.relative(project.pagesDir, full).split(path.sep).join('/').replace(/\.md$/, '')
          out.push({ id, file: full, mtime: fs.statSync(full).mtimeMs, lastEvent: last.get(id) ?? null, listeners: listenersFor(id).length })
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
      if (!target || path.relative(project.dir, target).split(path.sep).includes('.git') || !fs.existsSync(target)) return null
      const stat = fs.statSync(target)
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(target, { withFileTypes: true })
          .filter(e => !SKIP_DIRS.has(e.name) && e.name !== '.DS_Store')
          .map(e => ({ name: e.name, dir: e.isDirectory() }))
          .sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name))
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
    if (within(abs, project.pagesDir)) return `/${rel(project.pagesDir).replace(/\.md$/, '')}`
    if (FILES && within(abs, project.dir)) {
      if (rel(project.dir).split('/').some(part => SKIP_DIRS.has(part))) return null
      return `/-/${rel(project.dir)}`
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
    const list = (items: [string, string][]) => html`<ul>${items.map(([href, text]) => html`<li><a href="${href}">${text}</a></li>`)}</ul>`
    if (page.kind === 'pages') return { html: list(page.pages.map(p => [`/${p.id}`, p.id])) }
    if (page.kind === 'folder') {
      return { html: list(page.entries.map(e => [encodeURIComponent(e.name) + (e.dir ? '/' : ''), e.name + (e.dir ? '/' : '')] as [string, string])) }
    }
    return { html: html`<pre>${page.source}</pre>` }
  }

  const context = () => ({ project: { name: project.name, dir: project.dir, files: !!FILES }, asset, urlFor })

  /** A render as the shell takes it. `page`: whether the page's browser part runs (not on raw text). */
  interface Render {
    page: boolean
    out: Rendered
    notices: string[]
  }

  /** Render a stored page as markdown, with the plugins' blocks, and anything the reader should be told. */
  async function render(page: StoredPage): Promise<Render> {
    const { pages, errors } = await config()
    const notices = errors.map(e => `config: ${(e as Error).message}`)
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
   * Per page: the questions it asks that have no answer yet, the reader's events no wait or watch
   * picked up, who is listening, and the session that claimed it. What `whiteboard status` and the
   * hooks report. The questions are a page's named forms.
   */
  async function status(only: string | null): Promise<PageStatus[]> {
    const { pages } = await config()
    const all = readEvents(project.eventsFile)
    const picked = pickedUp(all)
    const owner = new Map<string, string | null>()
    for (const e of all) if (e.type === CLAIM && !fromReader(e)) owner.set(e.page, (e.data?.session as string | undefined) ?? null)
    const out: PageStatus[] = []
    for (const p of pagesIn(project.pagesDir)) {
      if (only && p.id !== only && !p.id.startsWith(only + '/')) continue
      const page = pageSource(p.id, p.file)
      let asks: string[] = []
      try { asks = pages?.questions(page) ?? [] } catch (err) { console.error('questions:', err) }
      const events = all.filter(e => e.page === p.id)
      const listening = listenersFor(p.id)
      // where each question stands, as the page shows it (see status.ts)
      const questions = asks.map(name => ({ name, state: questionState(name, events, listening, id => picked.has(id)).state }))
      const named = (...states: string[]) => questions.filter(q => states.includes(q.state)).map(q => q.name)
      out.push({
        page: p.id, file: p.file, owner: owner.get(p.id) ?? null, asks, questions,
        open: named('waiting', 'unheard'),
        unheard: named('unheard'),
        unpicked: events.filter(e => fromReader(e) && !picked.has(e.id)),
        listeners: listening,
      })
    }
    return out
  }

  /** How to write pages here, as markdown: the pages' own docs, then each plugin's. */
  async function docs() {
    const { pages, errors } = await config()
    // what each plugin declares: its routes (for an agent that wants to call them) and commands
    const plugins = await Promise.all((await pluginHooks()).map(async h => ({
      name: h.name,
      error: h.error?.message ?? null,
      docs: h.plugin.docs ? await h.plugin.docs() : null,
      routes: describeRoutes(h.table),
      commands: pluginCommands(h.plugin).map(c => ({ name: c.name, usage: usage(c.command), description: c.command.description })),
    })))
    return { errors: errors.map(e => (e as Error).message), pages: pages?.docs(context()) ?? null, plugins }
  }

  const json = (s: unknown) => JSON.stringify(s).replace(/</g, '\\u003c')

  // the page's corner (api.corner()): the one thing the core puts on every page, empty, for the
  // page's and the plugins' floating buttons; above what covers the bottom of the window
  const DOCK_STYLE = '#wb-dock{position:fixed;right:16px;bottom:calc(16px + var(--wb-inset-bottom,0px));z-index:10;display:flex;flex-direction:column;align-items:flex-end;gap:6px}#wb-dock:empty{display:none}'

  /** `extras`: what plugins add to <head> and <body> (see shellExtras). */
  function shell(page: StoredPage, { page: rendered, out, notices }: Render, extras: Extras = { head: [], body: [], clients: [] }): string {
    const handoff = { id: page.id, kind: page.kind, client: rendered ? asset(PAGE_CLIENT) : null, data: out.data ?? null, plugins: extras.clients }
    // the page's head and html are HTML already; the handoff is JSON made safe for a script tag
    return String(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${out.title || page.id || project.name}</title>
<style>${DOCK_STYLE}</style>
${raw(out.head ?? '')}${extras.head}</head>
<body data-page="${page.id}" data-kind="${page.kind}">
${notices.map(n => html`<pre class="wb-error" role="alert">${n}</pre>`)}
<div id="wb-root">${raw(String(out.html))}</div>
<div id="wb-dock"></div>
<script type="application/json" id="wb-page">${raw(json(handoff))}</script>
<script type="module" src="/_/runtime.js"></script>${extras.body}</body></html>`)
  }

  // ---- listeners ---------------------------------------------------------------------------------
  // An agent waiting for answers (`whiteboard wait` or `watch`) holds a connection to /api/listen for
  // as long as it runs: that connection is the listener, gone when the command is. Pages show what an
  // agent is waiting for from these, so nothing depends on the agent marking it.

  /** A listener as the server holds it. */
  const listeners = new Set<Listener>()

  /** Does a listener's page filter cover `page`? An empty filter covers every page. */
  const covers = (l: Listener, page: string) => !l.page || page === l.page || page.startsWith(l.page + '/')

  const listenersFor = (page: string | null): Listener[] => [...listeners].filter(l => page == null || covers(l, page)).map(({ page, type, command }) => ({ page, type, command }))

  // ---- live changes ------------------------------------------------------------------------------
  // The browser listens at /api/watch. `change`: its page changed; `events`: the log grew;
  // `listeners`: an agent started or stopped waiting; `style`: a stylesheet changed; `reload`:
  // browser code changed.

  /** A browser following its page at /api/watch; `pending`: what it will be told in a moment. */
  interface WatchClient {
    res: ServerResponse
    page: string
    isDir: boolean
    pending?: Set<string>
  }

  const clients = new Set<WatchClient>()
  function notify(client: WatchClient, kind: string) {
    client.pending ??= new Set()
    if (client.pending.size === 0) setTimeout(() => {
      for (const k of client.pending!) client.res.write(`event: ${k}\ndata: {}\n\n`)
      client.pending!.clear()
    }, 60)
    client.pending.add(kind)
  }
  const notifyAll = (kind: string) => { for (const c of clients) notify(c, kind) }

  function pageChanged(id: string) {
    for (const c of clients) {
      if (c.isDir ? (!c.page || id.startsWith(c.page + '/')) : (c.page === id || c.page + '/index' === id)) notify(c, 'change')
    }
    // the overview lists every page
    for (const c of clients) if (c.isDir && !c.page) notify(c, 'change')
  }

  /** A file in the project changed; `f` is its path relative to the project folder, with / separators. */
  function fileChanged(f: string) {
    if (f.split('/').some(part => SKIP_DIRS.has(part))) return
    if (f.startsWith('.whiteboard/')) {
      const inner = f.slice('.whiteboard/'.length)
      if (inner === 'events.ndjson') return notifyAll('events')
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
    if (watcher) { watcher.close(); watchers.delete(watcher) }
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
  const sendJson = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), 'application/json')
  const sendFile = (res: ServerResponse, file: string) => send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** What a page id resolves to, or why it does not: the response to send instead. */
  type Resolved = { page: StoredPage } | { raw: string } | { redirect: string } | { notFound: string }

  async function resolve(id: string, requested: string): Promise<Resolved> {
    await config()
    if (isRepoId(id) && !FILES) return { notFound: 'This project does not serve its files: its config sets files: false.' }
    if (id === '_/docs') {
      // how pages are written, then each plugin's own docs, with their examples rendered live
      const { pages, plugins } = await docs()
      const source = [
        pages ?? '',
        ...plugins.filter(p => p.docs).map(p => `<a id="plugin-${p.name}"></a>\n\n${p.docs}`),
      ].join('\n\n---\n\n')
      return { page: { kind: 'page', id, file: path.join(project.pagesDir, '_docs.md'), mtime: null, source, body: source, frontmatter: {} } }
    }
    const found = stored(id)
    if (!found) return { notFound: `${isRepoId(id) ? id.slice(2) : id} does not exist${isRepoId(id) ? '' : ' yet. This page loads as soon as it does'}.` }
    if ('raw' in found) return found
    // a folder is served at /dir/, so relative links resolve inside it
    if ((found.kind === 'folder' || (found.kind === 'pages' && id)) && !requested.endsWith('/')) return { redirect: `/${id}/` }
    return { page: found }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // a path like //x would otherwise read as a host
      const url = new URL((req.url ?? '/').replace(/^\/+/, '/'), 'http://localhost')
      const p = decodeURIComponent(url.pathname)
      const q = Object.fromEntries(url.searchParams)

      if (p === '/favicon.ico') { res.writeHead(204); res.end(); return }
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
        const file = path.resolve(p.slice('/_/file'.length))
        if (!servable(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain')
        return sendFile(res, file)
      }
      if (p === '/api/health') return sendJson(res, 200, { ok: true, dir: project.dir, pid: process.pid })
      if (p === '/api/events' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        if (!body.type) return sendJson(res, 400, { error: 'event type required' })
        return sendJson(res, 200, appendEvent(project.eventsFile, body))
      }
      if (p === '/api/events') {
        const all = readEvents(project.eventsFile)
        const picked = pickedUp(all)
        return sendJson(res, 200, all.filter(e => matches(e, q)).map(e => (picked.has(e.id) ? { ...e, pickedUp: true } : e)))
      }
      if (p === '/api/docs') return sendJson(res, 200, await docs())
      if (p === '/api/status') return sendJson(res, 200, await status(q.page || null))
      if (p === '/api/listeners') return sendJson(res, 200, listenersFor(q.page ?? null))
      if (p === '/api/listen') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': listening\n\n')
        const l: Listener = { page: q.page || '', type: q.type || null, command: q.command === 'wait' ? 'wait' : 'watch' }
        listeners.add(l)
        notifyAll('listeners')
        const ping = setInterval(() => res.write(': ping\n\n'), 25000)
        const end = () => { clearInterval(ping); listeners.delete(l); streams.delete(end) }
        streams.add(() => { end(); res.end() })
        req.on('close', () => { end(); notifyAll('listeners') })
        return
      }
      if (p === '/api/page' || p === '/api/render') {
        const r = await resolve(q.page ?? '', '/')
        if (!('page' in r)) return sendJson(res, 404, { error: 'notFound' in r ? r.notFound : 'not a page' })
        if (p === '/api/page') return sendJson(res, 200, r.page)
        const { out, notices } = await render(r.page)
        return sendJson(res, 200, { ...out, notices, mtime: r.page.mtime })
      }
      if (p === '/api/watch') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': connected\n\n')
        const client = { res, page: q.page || '', isDir: 'dir' in q }
        clients.add(client)
        const ping = setInterval(() => res.write(': ping\n\n'), 25000)
        const end = () => { clearInterval(ping); clients.delete(client); streams.delete(end) }
        streams.add(() => { end(); res.end() })
        req.on('close', end)
        return
      }

      const path_ = p.replace(/^\/+/, '').replace(/\/+$/, '')
      // a page is named without .md; a repository path is the file's own
      const id = isRepoId(path_) ? path_ : path_.replace(/\.md$/, '')
      const r = await resolve(id, p)
      if ('redirect' in r) { res.writeHead(302, { location: r.redirect + url.search }); res.end(); return }
      if ('raw' in r) return sendFile(res, r.raw)
      if ('notFound' in r) {
        const missing: PageSource = { kind: 'page', id, file: '', mtime: null, source: r.notFound, body: r.notFound, frontmatter: {} }
        return send(res, 404, await page(req, missing, { page: false, out: { title: 'Not found', html: html`<h1>Not found</h1><p>${r.notFound}</p>` }, notices: [] }))
      }
      return send(res, 200, await page(req, r.page, await render(r.page)))
    } catch (err) {
      console.error(err)
      send(res, 500, String((err as Error)?.stack || err), 'text/plain')
    }
  }

  return {
    handle,
    status: (page = null) => status(page),
    config,
    close() {
      for (const w of watchers) w.close()
      watchers.clear()
      for (const stop of [...streams]) stop()
      clearTimeout(reloadTimer)
    },
  }
}
