// The server of one project: the project in the folder it starts in (or above it).
//
//   /                the overview: the project's pages
//   /<page>          a page from .whiteboard/pages/<page>.md
//   /-/<path>        a file of the project, from the repository (unless the config sets files: false)
//   /_/docs          the documentation of the project's renderers
//   /_/file/<path>   a file a renderer asked to serve (its client, a stylesheet)
//   /api/…           the stored page, its render, events, live changes
//
// The core reads pages as they are stored and hands them to a renderer, which decides what they
// become. It draws nothing itself, except for a page no renderer takes: that shows as its raw
// text. It records its port in .whiteboard/server.json so the command line finds it.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, findProjectDir, project as projectAt } from './config.js'
import { appendEvent, readEvents, matches, pickedUp } from './events.js'
import { createConfigLoader, toPath } from './renderers.js'

const PROJECT = projectAt(findProjectDir())
if (!PROJECT) throw new Error(`not inside a whiteboard project: no .whiteboard/config.ts in ${process.cwd()} or above it`)

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// the browser runtime, built by build.js
const RUNTIME = path.join(ENGINE_DIR, 'dist', 'client', 'runtime.js')
const MIME = {
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
}
// files in .whiteboard/ that are the server's own bookkeeping, not content
const OWN_FILES = new Set(['events.ndjson', 'delivered', 'server.json', 'server.log', 'server.lock'])
const SKIP_DIRS = new Set(['node_modules', '.git'])

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const loader = createConfigLoader(PROJECT.configFile)

/** The loaded config. Also applies its `files` setting to what is served and watched. */
async function config() {
  const c = await loader.config()
  setFiles(c.files)
  return c
}

// ---- assets: files a renderer asks to serve ----------------------------------------------------
// Served at /_/file/<absolute path>, only once asked for, and only files in the folders of files
// asked for (a client module may import its neighbours). Those folders are watched from then on.

const assets = new Set()
const assetDirs = new Set()

function asset(ref) {
  const file = toPath(ref)
  if (!assets.has(file)) {
    assets.add(file)
    const dir = path.dirname(file)
    if (!assetDirs.has(dir)) {
      assetDirs.add(dir)
      // .whiteboard/ itself is watched already (setFiles), and so is the engine's own build
      if (!within(dir, PROJECT.wb) && !within(dir, ENGINE_BUILD)) {
        try { fs.watch(dir, (_evt, name) => { if (name) onSourceChange(path.join(dir, name)) }) } catch { /* gone */ }
      }
    }
  }
  return `/_/file${file.split(path.sep).map(encodeURIComponent).join('/')}`
}

const within = (file, dir) => file === dir || file.startsWith(dir + path.sep)

// ---- stored pages ------------------------------------------------------------------------------

/** Resolve a path inside a base folder, refusing anything that escapes it. */
function inside(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel))
  return within(p, base) ? p : null
}

const isRepoId = id => id === '-' || id.startsWith('-/')

function frontmatter(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source)
  const out = {}
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function pageSource(id, file) {
  const source = fs.readFileSync(file, 'utf8')
  return { kind: 'page', id, file, mtime: fs.statSync(file).mtimeMs, source, frontmatter: frontmatter(source) }
}

/** The pages in a folder of the pages folder, newest first, with when each was last answered. */
function pagesIn(dir) {
  const last = new Map()
  for (const e of readEvents(PROJECT.eventsFile)) last.set(e.page, e.ts)
  const out = []
  const walk = d => {
    if (!fs.existsSync(d)) return
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.name.endsWith('.md')) {
        const id = path.relative(PROJECT.pagesDir, full).split(path.sep).join('/').replace(/\.md$/, '')
        out.push({ id, file: full, mtime: fs.statSync(full).mtimeMs, lastEvent: last.get(id) ?? null, listeners: listenersFor(id).length })
      }
    }
  }
  walk(dir)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Text files show as files; anything with a NUL byte near the start is binary. */
function isText(file) {
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
function stored(id) {
  if (!id) return { kind: 'pages', id: '', file: PROJECT.pagesDir, mtime: null, pages: pagesIn(PROJECT.pagesDir) }
  if (isRepoId(id)) {
    const rel = id.slice(2)
    const target = inside(PROJECT.dir, rel)
    if (!target || path.relative(PROJECT.dir, target).split(path.sep).includes('.git') || !fs.existsSync(target)) return null
    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter(e => !SKIP_DIRS.has(e.name) && e.name !== '.DS_Store')
        .map(e => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
      const readme = ['README.md', 'readme.md', 'Readme.md'].map(n => path.join(target, n)).find(f => fs.existsSync(f))
      return { kind: 'folder', id, file: target, mtime: stat.mtimeMs, entries, readme: readme ? pageSource(id, readme) : null }
    }
    if (/\.(md|markdown)$/i.test(target)) return pageSource(id, target)
    if (stat.size > 1e6 || !isText(target)) return { raw: target }
    return { kind: 'file', id, file: target, mtime: stat.mtimeMs, source: fs.readFileSync(target, 'utf8') }
  }
  const target = inside(PROJECT.pagesDir, id)
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
function urlOf(abs) {
  const rel = dir => path.relative(dir, abs).split(path.sep).map(encodeURIComponent).join('/')
  if (within(abs, PROJECT.pagesDir)) return `/${rel(PROJECT.pagesDir).replace(/\.md$/, '')}`
  if (FILES && within(abs, PROJECT.dir)) {
    if (rel(PROJECT.dir).split('/').some(part => SKIP_DIRS.has(part))) return null
    return `/-/${rel(PROJECT.dir)}`
  }
  return null
}

/** For links: the target if it exists (also with .md added), mapped to its URL. */
function urlFor(abs) {
  for (const candidate of [abs, abs + '.md']) {
    if (fs.existsSync(candidate)) {
      const url = urlOf(candidate)
      if (url) return url + (fs.statSync(candidate).isDirectory() && !url.endsWith('/') ? '/' : '')
    }
  }
  return null
}

// ---- rendering ---------------------------------------------------------------------------------

/** The renderer for a page: the one its frontmatter names, else the config's first. */
function pick(page, renderers, notices) {
  const wanted = page.kind === 'page' ? page.frontmatter.renderer : undefined
  if (wanted) {
    const r = renderers.find(x => x.name === wanted)
    if (r) return r
    notices.push(`this page asks for the renderer "${wanted}", which the config does not list`)
  }
  return renderers[0] ?? null
}

/** No renderer: the page as stored, as text. */
function rawRender(page) {
  const list = items => `<ul>${items.map(([href, text]) => `<li><a href="${esc(href)}">${esc(text)}</a></li>`).join('')}</ul>`
  if (page.kind === 'pages') return { html: list(page.pages.map(p => [`/${p.id}`, p.id])) }
  if (page.kind === 'folder') {
    const entries = list(page.entries.map(e => [encodeURIComponent(e.name) + (e.dir ? '/' : ''), e.name + (e.dir ? '/' : '')]))
    return { html: entries + (page.readme ? `<pre>${esc(page.readme.source)}</pre>` : '') }
  }
  return { html: `<pre>${esc(page.source)}</pre>` }
}

const context = () => ({ project: { name: PROJECT.name, dir: PROJECT.dir, files: FILES }, asset, urlFor })

/** Render a stored page: its renderer, its render, and anything the reader should be told. */
async function render(page) {
  const { renderers, errors } = await config()
  const notices = errors.map(e => `config: ${e.message}`)
  const renderer = pick(page, renderers, notices)
  let out
  try {
    out = renderer?.render ? await renderer.render(page, context()) : renderer ? { html: '' } : rawRender(page)
  } catch (err) {
    console.error(`renderer ${renderer.name}:`, err)
    notices.push(`renderer "${renderer.name}" failed: ${err.message}`)
    out = rawRender(page)
  }
  return { renderer, out, notices }
}

/** The documentation of every renderer, as markdown. */
async function docs() {
  const { renderers, errors } = await config()
  const list = []
  for (const r of renderers) list.push({ name: r.name, docs: r.docs ? await r.docs(context()) : null })
  return { errors: errors.map(e => e.message), renderers: list }
}

const json = s => JSON.stringify(s).replace(/</g, '\\u003c')

function shell(page, { renderer, out, notices }) {
  const projectCss = fs.existsSync(PROJECT.styleFile) ? '<link rel="stylesheet" href="/_/project.css" data-wb-style>' : ''
  const handoff = { id: page.id, kind: page.kind, renderer: renderer?.name ?? null, client: renderer?.client ? asset(renderer.client) : null, data: out.data ?? null }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(out.title || page.id || PROJECT.name)}</title>
${out.head ?? ''}${projectCss}</head>
<body data-page="${esc(page.id)}" data-kind="${esc(page.kind)}">
${notices.map(n => `<pre class="wb-error" role="alert">${esc(n)}</pre>`).join('')}
<div id="wb-root">${out.html}</div>
<script type="application/json" id="wb-page">${json(handoff)}</script>
<script type="module" src="/_/runtime.js"></script></body></html>`
}

// ---- listeners ---------------------------------------------------------------------------------
// An agent waiting for answers (`whiteboard wait` or `watch`) holds a connection to /api/listen for
// as long as it runs: that connection is the listener, gone when the command is. Pages show what an
// agent is waiting for from these, so nothing depends on the agent marking it.

const listeners = new Set()

/** Does a listener's page filter cover `page`? An empty filter covers every page. */
const covers = (l, page) => !l.page || page === l.page || page.startsWith(l.page + '/')

const listenersFor = page => [...listeners].filter(l => page == null || covers(l, page)).map(({ page, type, command }) => ({ page, type, command }))

// ---- live changes ------------------------------------------------------------------------------
// The browser listens at /api/watch. `change`: its page changed; `events`: the log grew;
// `listeners`: an agent started or stopped waiting; `style`: a stylesheet changed; `reload`:
// browser code changed.

const clients = new Set()
function notify(client, kind) {
  client.pending ??= new Set()
  if (client.pending.size === 0) setTimeout(() => {
    for (const k of client.pending) client.res.write(`event: ${k}\ndata: {}\n\n`)
    client.pending.clear()
  }, 60)
  client.pending.add(kind)
}
const notifyAll = kind => { for (const c of clients) notify(c, kind) }

function pageChanged(id) {
  for (const c of clients) {
    if (c.isDir ? (!c.page || id.startsWith(c.page + '/')) : (c.page === id || c.page + '/index' === id)) notify(c, 'change')
  }
  // the overview lists every page
  for (const c of clients) if (c.isDir && !c.page) notify(c, 'change')
}

/** A file in the project changed; `f` is its path relative to the project folder, with / separators. */
function fileChanged(f) {
  if (f.split('/').some(part => SKIP_DIRS.has(part))) return
  if (f.startsWith('.whiteboard/')) {
    const inner = f.slice('.whiteboard/'.length)
    if (inner === 'events.ndjson') return notifyAll('events')
    if (inner === 'style.css') return notifyAll('style')
    if (inner.startsWith('pages/')) {
      if (inner.endsWith('.md')) pageChanged(inner.slice('pages/'.length).replace(/\.md$/, ''))
      return
    }
    // an agent picked an event up: pages show it
    if (inner.startsWith('delivered/')) return notifyAll('events')
    if (OWN_FILES.has(inner)) return
    // the config, or something it imports
    return onSourceChange(path.join(PROJECT.dir, f))
  }
  if (!FILES) return
  // a repository file; its folder's listing shows it too
  pageChanged(`-/${f}`)
  const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
  pageChanged(`-${parent ? '/' + parent : ''}`)
}

// With files on, the whole project folder is watched (repository views stay live); with files off,
// only .whiteboard/, so a project in a large folder such as the home folder stays cheap.
let FILES = null
let watcher = null
function setFiles(files) {
  if (files === FILES) return
  FILES = files
  watcher?.close()
  const base = files ? PROJECT.dir : PROJECT.wb
  const prefix = files ? '' : '.whiteboard/'
  watcher = fs.watch(base, { recursive: true }, (_evt, filename) => {
    if (filename) fileChanged(prefix + filename.replace(/\\/g, '/'))
  })
}

// What a renderer or the config is made of changed. A stylesheet reloads in place; a browser module
// reloads the pages; anything else loads the config afresh and re-renders open pages.
let reloadTimer = null
async function onSourceChange(file) {
  if (within(file, PROJECT.pagesDir)) return
  if (path.dirname(file) === PROJECT.wb && OWN_FILES.has(path.basename(file))) return
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

// The engine's own build, when it is not an installed package: rebuilding it (npm run dev) reloads
// what it is made of, like a project's own files.
const ENGINE_BUILD = path.join(ENGINE_DIR, 'dist')
if (!ENGINE_DIR.split(path.sep).includes('node_modules')) {
  try {
    fs.watch(ENGINE_BUILD, { recursive: true }, (_evt, name) => { if (name) onSourceChange(path.join(ENGINE_BUILD, name)) })
  } catch { /* not built */ }
}

// ---- http --------------------------------------------------------------------------------------

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json')
const sendFile = (res, file) => send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** What a page id resolves to, or why it does not: the response to send instead. */
async function resolve(id, requested) {
  await config()
  if (isRepoId(id) && !FILES) return { notFound: 'This project does not serve its files: its config sets files: false.' }
  if (id === '_/docs') {
    const { renderers } = await docs()
    const source = renderers.length
      ? renderers.map(r => r.docs ?? `# ${r.name}\n\n_No documentation._\n`).join('\n\n---\n\n')
      : `# Renderers\n\nThis project has none: add them to \`renderers\` in \`${PROJECT.configFile}\`. Pages show as their raw text until then.\n`
    return { page: { kind: 'page', id, file: path.join(PROJECT.pagesDir, '_docs.md'), mtime: null, source, frontmatter: {} } }
  }
  const found = stored(id)
  if (!found) return { notFound: `${isRepoId(id) ? id.slice(2) : id} does not exist${isRepoId(id) ? '' : ' yet. This page loads as soon as it does'}.` }
  if (found.raw) return found
  // a folder is served at /dir/, so relative links resolve inside it
  if ((found.kind === 'folder' || (found.kind === 'pages' && id)) && !requested.endsWith('/')) return { redirect: `/${id}/` }
  return { page: found }
}

httpServer().on('request', async (req, res) => {
  try {
    // a path like //x would otherwise read as a host
    const url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost')
    const p = decodeURIComponent(url.pathname)
    const q = Object.fromEntries(url.searchParams)

    if (p === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (p === '/_/runtime.js') return sendFile(res, RUNTIME)
    if (p === '/_/project.css') return send(res, 200, fs.existsSync(PROJECT.styleFile) ? fs.readFileSync(PROJECT.styleFile) : '', 'text/css')
    if (p.startsWith('/_/file/')) {
      const file = path.resolve(p.slice('/_/file'.length))
      if (!assetDirs.has(path.dirname(file)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain')
      return sendFile(res, file)
    }
    if (p === '/api/health') return sendJson(res, 200, { ok: true, dir: PROJECT.dir, pid: process.pid })
    if (p === '/api/events' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.type) return sendJson(res, 400, { error: 'event type required' })
      return sendJson(res, 200, appendEvent(PROJECT.eventsFile, body))
    }
    if (p === '/api/events') {
      const all = readEvents(PROJECT.eventsFile)
      const picked = pickedUp(PROJECT, all)
      return sendJson(res, 200, all.filter(e => matches(e, q)).map(e => (picked.has(e.id) ? { ...e, pickedUp: true } : e)))
    }
    if (p === '/api/docs') return sendJson(res, 200, await docs())
    if (p === '/api/listeners') return sendJson(res, 200, listenersFor(q.page ?? null))
    if (p === '/api/listen') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': listening\n\n')
      const l = { page: q.page || '', type: q.type || null, command: q.command === 'wait' ? 'wait' : 'watch' }
      listeners.add(l)
      notifyAll('listeners')
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => { clearInterval(ping); listeners.delete(l); notifyAll('listeners') })
      return
    }
    if (p === '/api/page' || p === '/api/render') {
      const r = await resolve(q.page ?? '', '/')
      if (!r.page) return sendJson(res, 404, { error: r.notFound ?? 'not a page' })
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
      req.on('close', () => { clearInterval(ping); clients.delete(client) })
      return
    }

    const path_ = p.replace(/^\/+/, '').replace(/\/+$/, '')
    // a page is named without .md; a repository path is the file's own
    const id = isRepoId(path_) ? path_ : path_.replace(/\.md$/, '')
    const r = await resolve(id, p)
    if (r.redirect) { res.writeHead(302, { location: r.redirect + url.search }); return res.end() }
    if (r.raw) return sendFile(res, r.raw)
    if (r.notFound) {
      const page = { kind: 'page', id, file: '', mtime: null, source: r.notFound, frontmatter: {} }
      return send(res, 404, shell(page, { renderer: null, out: { title: 'Not found', html: `<h1>Not found</h1><p>${esc(r.notFound)}</p>` }, notices: [] }))
    }
    return send(res, 200, shell(r.page, await render(r.page)))
  } catch (err) {
    console.error(err)
    send(res, 500, String(err?.stack || err), 'text/plain')
  }
})

// ---- start -------------------------------------------------------------------------------------

function httpServer() {
  httpServer.instance ??= http.createServer()
  return httpServer.instance
}

/** The URL of a server of this project that is up already, or null. */
async function runningServer() {
  const port = previousPort()
  if (!port) return null
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(800) })
    const health = res.ok ? await res.json() : null
    return health?.dir === PROJECT.dir && health.pid !== process.pid ? `http://localhost:${port}` : null
  } catch { return null }
}

/** The port the last server of this project used, so open tabs reconnect after a restart. */
function previousPort() {
  try { return Number(JSON.parse(fs.readFileSync(PROJECT.serverFile, 'utf8')).port) || null } catch { return null }
}

/** Listen on the previous port, else the default, else the next free one; then record it in server.json. */
export async function start() {
  const server = httpServer()
  // one server per project: another may have started a moment ago
  const other = await runningServer()
  if (other) {
    console.log(`whiteboard: ${PROJECT.name} is already served at ${other}`)
    process.exit(0)
  }
  fs.mkdirSync(PROJECT.pagesDir, { recursive: true })
  await config()
  const candidates = [...new Set([previousPort(), DEFAULT_PORT, ...Array.from({ length: 50 }, (_, i) => DEFAULT_PORT + 1 + i)].filter(Boolean))]
  for (const port of candidates) {
    const ok = await new Promise((resolve, reject) => {
      const onError = err => { server.off('listening', onListening); err.code === 'EADDRINUSE' ? resolve(false) : reject(err) }
      const onListening = () => { server.off('error', onError); resolve(true) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
    if (!ok) continue
    fs.writeFileSync(PROJECT.serverFile, JSON.stringify({ port, pid: process.pid }, null, 2) + '\n')
    // the command that started this server waits for it; others can now find it
    try { fs.unlinkSync(path.join(PROJECT.wb, 'server.lock')) } catch {}
    const cleanup = () => {
      try { if (JSON.parse(fs.readFileSync(PROJECT.serverFile, 'utf8')).pid === process.pid) fs.unlinkSync(PROJECT.serverFile) } catch {}
    }
    process.on('exit', cleanup)
    // one server per project: should another have started at the same moment, whichever one
    // server.json names last stays, and the others leave (their clients reconnect to it)
    const yieldToOther = async () => { if (await runningServer()) { console.log('whiteboard: another server of this project took over'); process.exit(0) } }
    setTimeout(yieldToOther, 1500).unref()
    setInterval(yieldToOther, 30000).unref()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0))
    console.log(`whiteboard: ${PROJECT.name} (${PROJECT.dir}) at http://localhost:${port}`)
    return port
  }
  throw new Error(`no free port from ${DEFAULT_PORT} to ${DEFAULT_PORT + 50}`)
}
