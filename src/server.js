// The server of one project: the project in the folder it starts in (or above it).
//
//   /                the overview: the project's pages
//   /<page>          a page from .whiteboard/pages/<page>.md
//   /-/<path>        a file of the project, shown from the repository (unless the config sets files: false)
//   /_/docs          the syntax of the project's templates
//   /api/…           events, templates, live reload
//
// It records its port in .whiteboard/server.json so the command line finds it.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import solid from '@solidjs/vite-plugin'
import { DEFAULT_PORT, findProjectDir, project as projectAt } from './config.js'
import { appendEvent, readEvents, matches } from './events.js'
import { createTemplateLoader } from './templates.js'
import { renderMarkdown, esc } from './markdown.js'

const PROJECT = projectAt(findProjectDir())
if (!PROJECT) throw new Error(`not inside a whiteboard project: no .whiteboard/config.ts in ${process.cwd()} or above it`)

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = path.join(ENGINE_DIR, 'src', 'client')
const DEFINE = path.join(ENGINE_DIR, 'src', 'define.ts')
const MIME = {
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
}
// files in .whiteboard/ that are the server's own bookkeeping, not content
const OWN_FILES = new Set(['events.ndjson', 'delivered.json', 'server.json', 'server.log'])

const httpServer = http.createServer()

// Vite compiles template client modules (and loads the config). The Solid plugin is the default
// toolchain for local .tsx templates; pre-built template packages need no compiler at all.
const vite = await createVite({
  configFile: false,
  root: CLIENT_DIR,
  appType: 'custom',
  plugins: [solid()],
  resolve: {
    // templates and configs live anywhere on disk; give them the engine's single copies, and this
    // package's own exports, so a project needs no node_modules to use them (ezno is Rust, say)
    dedupe: ['solid-js', '@solidjs/web'],
    alias: {
      '@bigmistqke/whiteboard/config': DEFINE,
      '@bigmistqke/whiteboard/template': DEFINE,
      '@bigmistqke/whiteboard/client': path.join(CLIENT_DIR, 'api.ts'),
      '@bigmistqke/whiteboard/basic': path.join(ENGINE_DIR, 'basic', 'index.ts'),
      '@bigmistqke/whiteboard/solid': path.join(ENGINE_DIR, 'solid', 'index.tsx'),
    },
  },
  optimizeDeps: { include: ['morphdom'] },
  server: {
    middlewareMode: true,
    hmr: { server: httpServer },
    fs: { strict: true, allow: [ENGINE_DIR, PROJECT.wb] },
  },
})
const templates = createTemplateLoader(vite, PROJECT.configFile)

/** Vite serves only allowed folders; template folders are allowed and watched as pages use them. */
function allow(dir) {
  const list = vite.config.server.fs.allow
  if (!list.some(a => dir === a || dir.startsWith(a + path.sep))) {
    list.push(dir)
    vite.watcher.add(dir)
  }
}

/** Let the server hand out a template's client, style and readme files. */
function allowTemplate(t) {
  if (t) for (const f of [t.client, t.style, t.readme]) if (f) allow(path.dirname(f))
}

/** The loaded config. Also applies its `files` setting to what is served and watched. */
async function config() {
  const c = await templates.config()
  setFiles(c.files)
  return c
}

// ---- locating pages ----------------------------------------------------------------------------

/** Resolve a path inside a base folder, refusing anything that escapes it. */
function inside(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel))
  return p === base || p.startsWith(base + path.sep) ? p : null
}

const isRepoId = id => id === '-' || id.startsWith('-/')

/** A page id → where it lives: "-/<path>" in the project folder, anything else in the pages folder. */
function locate(id) {
  if (isRepoId(id)) return { repo: true, base: PROJECT.dir, rel: id.slice(2), prefix: '-' }
  return { repo: false, base: PROJECT.pagesDir, rel: id, prefix: '' }
}

function listPages(base, prefix) {
  const out = []
  if (!fs.existsSync(base)) return out
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.name.endsWith('.md')) {
        const rel = path.relative(base, full).replace(/\\/g, '/').replace(/\.md$/, '')
        const h1 = /^#\s+(.+)$/m.exec(fs.readFileSync(full, 'utf8'))
        out.push({ id: prefix ? `${prefix}/${rel}` : rel, title: h1 ? h1[1].replace(/[*_`]/g, '') : path.basename(rel), mtime: fs.statSync(full).mtimeMs })
      }
    }
  }
  walk(base)
  return out.sort((a, b) => b.mtime - a.mtime)
}

function pageList(pages) {
  const last = new Map()
  for (const e of readEvents(PROJECT.eventsFile)) last.set(e.page, e)
  return `<ul class="wb-index">${pages.map(p => {
    const ev = last.get(p.id)
    return `<li><a href="/${esc(p.id)}">${esc(p.title)}</a> <span class="wb-meta"><code>${esc(p.id)}</code> · edited <time data-ts="${p.mtime}"></time>${
      ev ? ` · last submit <time data-ts="${Date.parse(ev.ts)}"></time>` : ''}</span></li>`
  }).join('')}</ul>`
}

/** The overview at "/": the project's pages. */
function homeHtml() {
  const pages = listPages(PROJECT.pagesDir, '')
  const links = [FILES && '<a href="/-/">files</a>', '<a href="/_/docs">templates</a>'].filter(Boolean).join(' · ')
  return `<h1>${esc(PROJECT.name)}</h1>${pages.length ? pageList(pages) : '<p class="wb-meta">No pages yet.</p>'}<p class="wb-meta"><code>${esc(PROJECT.dir)}</code> · ${links}</p>`
}

function folderHtml(loc) {
  const pages = listPages(path.join(loc.base, loc.rel), loc.rel)
  return `<h1>${esc(loc.rel)}</h1>${pages.length ? pageList(pages) : '<p class="wb-meta">No pages yet.</p>'}<p class="wb-meta">${esc(path.join(loc.base, loc.rel))}</p>`
}

const SKIP_DIRS = new Set(['node_modules', '.git'])

/** The URL that serves a file or folder on disk, or null when nothing here serves it. */
function urlFor(abs) {
  const within = dir => abs === dir || abs.startsWith(dir + path.sep)
  const rel = dir => path.relative(dir, abs).split(path.sep).map(encodeURIComponent).join('/')
  if (within(PROJECT.pagesDir)) return `/${rel(PROJECT.pagesDir).replace(/\.md$/, '')}`
  if (FILES && within(PROJECT.dir)) {
    if (rel(PROJECT.dir).split('/').some(part => SKIP_DIRS.has(part))) return null
    return `/-/${rel(PROJECT.dir)}`
  }
  return null
}

/** For relative links: the target if it exists (also with .md added), mapped to its URL. */
function linkFor(abs) {
  for (const candidate of [abs, abs + '.md']) {
    if (fs.existsSync(candidate)) {
      const url = urlFor(candidate)
      if (url) return url + (fs.statSync(candidate).isDirectory() && !url.endsWith('/') ? '/' : '')
    }
  }
  return null
}

const CODE_LANG = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', json: 'json', css: 'css', html: 'html', sh: 'bash', zsh: 'bash', py: 'python', rs: 'rust', go: 'go', toml: 'toml', yml: 'yaml', yaml: 'yaml' }
const RAW = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.pdf', '.mp4', '.webm', '.ico', '.woff', '.woff2'])

/** Text files are shown as code; anything with a NUL byte near the start is binary. */
function isText(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(8192)
  const n = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  return !buf.subarray(0, n).includes(0)
}

function repoDirHtml(loc, dir) {
  const id = [loc.prefix, loc.rel].filter(Boolean).join('/')
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !SKIP_DIRS.has(e.name) && e.name !== '.DS_Store')
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
  const up = loc.rel ? `<li><a href="../">../</a></li>` : ''
  const rows = entries.map(e => {
    const name = e.name + (e.isDirectory() ? '/' : '')
    return `<li><a href="${esc(encodeURIComponent(e.name) + (e.isDirectory() ? '/' : ''))}">${esc(name)}</a></li>`
  }).join('')
  return `<h1>${esc(loc.rel || PROJECT.name)}</h1><ul class="wb-files">${up}${rows}</ul><p class="wb-meta">${esc(dir)} · <code>${esc(id)}</code></p>`
}

/** A repository path: markdown renders as a page, folders list their files (and README), other text shows as code. */
async function renderRepo(id, loc) {
  const target = inside(loc.base, loc.rel)
  if (!target || !fs.existsSync(target) || target.split(path.sep).includes('.git')) return null
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    const listing = repoDirHtml(loc, target)
    const readme = ['README.md', 'readme.md', 'Readme.md'].map(n => path.join(target, n)).find(f => fs.existsSync(f))
    if (!readme) return { id, title: loc.rel || PROJECT.name, isDir: true, html: listing, islands: {}, styles: [] }
    const r = await renderFile(readme, id)
    return { id, ...r, html: `${r.html}<hr>${listing}`, mtime: fs.statSync(readme).mtimeMs }
  }
  if (/\.(md|markdown)$/i.test(target)) return { id, ...(await renderFile(target, id)), mtime: stat.mtimeMs }
  if (stat.size > 1e6 || !isText(target)) return null
  const ext = path.extname(target).slice(1).toLowerCase()
  const value = fs.readFileSync(target, 'utf8')
  // the file as one code block, rendered by the config's code template (or as plain code); no template claims it by name
  const { code, errors } = await config()
  allowTemplate(code)
  const tree = { type: 'root', children: [{ type: 'code', lang: CODE_LANG[ext] ?? (ext || null), meta: null, value }] }
  const out = await renderMarkdown(tree, { page: id, file: target, resolve: () => null, code, linkFor })
  const notice = errors.map(e => `<pre class="wb-error">config: ${esc(e.message)}</pre>`).join('')
  const html = `${notice}<h1 class="wb-code-title wb-wide">${esc(loc.rel)}</h1><div class="wb-code wb-wide">${out.html}</div>`
  return { id, title: path.basename(target), html, islands: out.islands, styles: out.styles, mtime: stat.mtimeMs }
}

async function renderFile(file, page) {
  const { templates: set, code, errors } = await config()
  for (const t of set.values()) allowTemplate(t)
  const rendered = await renderMarkdown(fs.readFileSync(file, 'utf8'), { page, file, resolve: name => set.get(name) ?? null, code, linkFor })
  const notice = errors.map(e => `<pre class="wb-error">config: ${esc(e.message)}</pre>`).join('')
  return { ...rendered, html: notice + rendered.html }
}

/** @returns page data, or null when nothing exists at `id` */
async function renderPage(id) {
  if (!id) {
    await config()
    return { id, title: PROJECT.name, isDir: true, html: homeHtml(), islands: {}, styles: [] }
  }
  const loc = locate(id)
  const target = inside(loc.base, loc.rel)
  if (!target) return null
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, 'index.md')
    if (fs.existsSync(index)) return { id, ...(await renderFile(index, id)), mtime: fs.statSync(index).mtimeMs }
    return { id, title: id, isDir: true, html: folderHtml(loc), islands: {}, styles: [] }
  }
  const file = inside(loc.base, loc.rel + '.md')
  if (!file || !fs.existsSync(file)) return null
  return { id, ...(await renderFile(file, id)), mtime: fs.statSync(file).mtimeMs }
}

async function templateInfo() {
  const { templates: set, errors } = await config()
  return {
    errors: errors.map(e => e.message),
    templates: [...set.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
      name: t.name, source: t.source, code: t.code, client: !!t.client, html: !!t.html, props: !!t.props,
      readme: t.readme ? fs.readFileSync(t.readme, 'utf8') : null,
    })),
  }
}

async function renderDocs() {
  const { templates: list, errors } = await templateInfo()
  const parts = list.map(t => {
    const where = `<p class="wb-meta">from <code>${esc(t.source)}</code>${t.code ? ' · code blocks' : ''}${t.client ? ' · client' : ''}${t.html ? ' · html' : ''}${t.props ? ' · props' : ''}</p>`
    const readme = t.readme ?? `# ${t.name}\n\n_No readme._\n`
    return readme.replace(/^(#\s.*)$/m, `$1\n\n${where}\n`)
  })
  const intro = list.length
    ? `# Templates\n\nAvailable in **${PROJECT.name}**: ${list.map(t => `[${t.name}](#${t.name})`).join(' · ')}\n\n`
    : `# Templates\n\nNo templates yet. Add them to the \`templates\` array in \`${PROJECT.configFile}\`.\n`
  // docs are not a file; this path only serves as the render's location for relative references
  const file = path.join(PROJECT.pagesDir, '_docs.md')
  const { templates: set, code } = await config()
  const out = await renderMarkdown(intro + parts.join('\n\n---\n\n'), { page: '_/docs', file, resolve: name => set.get(name) ?? null, code, linkFor })
  const notice = errors.map(e => `<pre class="wb-error">config: ${esc(e)}</pre>`).join('')
  return { id: '_/docs', ...out, html: notice + out.html, title: 'Templates' }
}

function crumbs(id) {
  let acc = ''
  return `<a href="/">${esc(PROJECT.name)}</a>` + (id ? id.split('/') : []).map(p => { acc += '/' + p; return ` / <a href="${esc(acc)}">${esc(p)}</a>` }).join('')
}

const json = s => JSON.stringify(s).replace(/</g, '\\u003c')

function shell(page) {
  const styles = page.styles.map(s => `<link rel="stylesheet" href="/@fs${esc(s)}" data-wb-style>`).join('')
  const projectCss = fs.existsSync(PROJECT.styleFile) ? '<link rel="stylesheet" href="/_/project.css" data-wb-style>' : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title || page.id || PROJECT.name)}</title>
<script>try{const t=localStorage.getItem('wb-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/_/base.css" data-wb-style>${projectCss}${styles}
<script type="module" src="/@vite/client"></script></head>
<body data-page="${esc(page.id)}"${page.isDir ? ' data-dir' : ''}>
<nav class="wb-nav"><span>${crumbs(page.id)}</span>${page.mtime ? `<span class="wb-meta">updated <time id="wb-updated" data-ts="${page.mtime}"></time></span>` : ''}<button type="button" class="wb-theme" title="Theme: follow the system, light or dark">auto</button><span class="wb-live" title="live reload"></span></nav>
<main id="wb-main">${page.html}</main>
<script type="application/json" id="wb-islands">${json(page.islands)}</script>
<script type="module" src="/main.ts"></script></body></html>`
}

// ---- live reload -------------------------------------------------------------------------------

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
  // folder listings and the overview show every page
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
    if (OWN_FILES.has(inner)) return
    // the config and local templates reload through Vite (onSourceChange)
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

// Components hot-reload through Vite. Styles reload in place. Anything else a template or config
// is made of changes the server render: reload the config and re-render open pages.
function onSourceChange(file) {
  if (file.startsWith(PROJECT.pagesDir + path.sep)) return
  if (path.dirname(file) === PROJECT.wb && OWN_FILES.has(path.basename(file))) return
  if (/\.[mc]?[jt]sx$/.test(file)) return
  if (file.endsWith('.css')) return notifyAll('style')
  templates.invalidate()
  vite.moduleGraph.invalidateAll()
  notifyAll('change')
  config()
}
vite.watcher.on('change', onSourceChange)
vite.watcher.on('add', onSourceChange)
vite.watcher.on('unlink', onSourceChange)

// ---- http --------------------------------------------------------------------------------------

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json')

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new Error('body too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const isViteRequest = p =>
  p.startsWith('/@') || p.startsWith('/__') || p.startsWith('/node_modules/') ||
  (/\.(tsx?|jsx?|css|map)$/.test(p) && fs.existsSync(path.join(CLIENT_DIR, p)))

const notFound = (res, id, html) => send(res, 404, shell({ id, title: 'Not found', islands: {}, styles: [], html }))

httpServer.on('request', async (req, res) => {
  try {
    // a path like //x would otherwise read as a host
    const url = new URL(req.url.replace(/^\/+/, '/'), 'http://localhost')
    const p = decodeURIComponent(url.pathname)
    const q = Object.fromEntries(url.searchParams)

    if (isViteRequest(p)) return vite.middlewares(req, res, () => send(res, 404, 'not found', 'text/plain'))

    if (p === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (p === '/api/health') return sendJson(res, 200, { ok: true, dir: PROJECT.dir, pid: process.pid })
    if (p === '/api/events' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.form) return sendJson(res, 400, { error: 'form name required' })
      return sendJson(res, 200, appendEvent(PROJECT.eventsFile, body))
    }
    if (p === '/api/events') return sendJson(res, 200, readEvents(PROJECT.eventsFile).filter(e => matches(e, q)))
    if (p === '/api/templates') return sendJson(res, 200, await templateInfo())
    if (p === '/api/watch') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': connected\n\n')
      const client = { res, page: q.page || '', isDir: 'dir' in q }
      clients.add(client)
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => { clearInterval(ping); clients.delete(client) })
      return
    }
    if (p === '/_/base.css') return send(res, 200, fs.readFileSync(path.join(CLIENT_DIR, 'base.css')), 'text/css')
    if (p === '/_/project.css') return send(res, 200, fs.existsSync(PROJECT.styleFile) ? fs.readFileSync(PROJECT.styleFile) : '', 'text/css')

    let page
    const id = p.replace(/^\/+/, '').replace(/\/+$/, '')
    if (p === '/_/docs') page = await renderDocs()
    else if (isRepoId(id)) {
      await config()
      if (!FILES) return notFound(res, id, `<h1>Not found</h1><p>This project does not serve its files: its config sets <code>files: false</code>.</p>`)
      const loc = locate(id)
      const target = inside(loc.base, loc.rel)
      // repository internals are never served
      if (!target || path.relative(loc.base, target).split(path.sep).includes('.git')) return send(res, 404, 'not found', 'text/plain')
      if (fs.existsSync(target) && fs.statSync(target).isDirectory() && !p.endsWith('/')) {
        res.writeHead(302, { location: `/${id}/${url.search}` })
        return res.end()
      }
      const ext = path.extname(target ?? '').toLowerCase()
      if (target && fs.existsSync(target) && fs.statSync(target).isFile() && (RAW.has(ext) || 'raw' in q)) {
        return send(res, 200, fs.readFileSync(target), MIME[ext] || 'application/octet-stream')
      }
      page = await renderRepo(id, loc)
      if (!page) {
        if (target && fs.existsSync(target) && fs.statSync(target).isFile()) return send(res, 200, fs.readFileSync(target), MIME[ext] || 'application/octet-stream')
        return notFound(res, id, `<h1>Not found</h1><p><code>${esc(target ?? id)}</code> does not exist.</p>`)
      }
    }
    else {
      const pageIdOf = id.replace(/\.md$/, '')
      const loc = locate(pageIdOf)
      const ext = path.extname(pageIdOf)
      if (ext) {
        const f = inside(loc.base, loc.rel)
        if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, fs.readFileSync(f), MIME[ext.toLowerCase()] || 'application/octet-stream')
        return send(res, 404, 'not found', 'text/plain')
      }
      // a folder (with an index.md, or a listing): serve at /dir/ so relative links resolve inside it
      const dir = inside(loc.base, loc.rel)
      if (pageIdOf && !p.endsWith('/') && dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        res.writeHead(302, { location: `/${pageIdOf}/${url.search}` })
        return res.end()
      }
      page = await renderPage(pageIdOf)
      if (!page) {
        const where = inside(loc.base, loc.rel + '.md') ?? pageIdOf
        return notFound(res, pageIdOf, `<h1>Not found</h1><p><code>${esc(where)}</code> does not exist yet. This page loads as soon as it does.</p>`)
      }
    }
    if ('fragment' in q) {
      const { html, title, islands, styles, mtime } = page
      return sendJson(res, 200, { html, title, islands, styles: styles.map(s => `/@fs${s}`), mtime: mtime ?? null })
    }
    return send(res, 200, shell(page))
  } catch (err) {
    console.error(err)
    send(res, 500, String(err?.stack || err), 'text/plain')
  }
})

// ---- start -------------------------------------------------------------------------------------

/** The port the last server of this project used, so open tabs reconnect after a restart. */
function previousPort() {
  try { return Number(JSON.parse(fs.readFileSync(PROJECT.serverFile, 'utf8')).port) || null } catch { return null }
}

/** Listen on the previous port, else the default, else the next free one; then record it in server.json. */
export async function start() {
  fs.mkdirSync(PROJECT.pagesDir, { recursive: true })
  await config()
  const candidates = [...new Set([previousPort(), DEFAULT_PORT, ...Array.from({ length: 50 }, (_, i) => DEFAULT_PORT + 1 + i)].filter(Boolean))]
  for (const port of candidates) {
    const ok = await new Promise((resolve, reject) => {
      const onError = err => { httpServer.off('listening', onListening); err.code === 'EADDRINUSE' ? resolve(false) : reject(err) }
      const onListening = () => { httpServer.off('error', onError); resolve(true) }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(port, '127.0.0.1')
    })
    if (!ok) continue
    fs.writeFileSync(PROJECT.serverFile, JSON.stringify({ port, pid: process.pid }, null, 2) + '\n')
    const cleanup = () => {
      try { if (JSON.parse(fs.readFileSync(PROJECT.serverFile, 'utf8')).pid === process.pid) fs.unlinkSync(PROJECT.serverFile) } catch {}
    }
    process.on('exit', cleanup)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0))
    console.log(`whiteboard: ${PROJECT.name} (${PROJECT.dir}) at http://localhost:${port}`)
    return port
  }
  throw new Error(`no free port from ${DEFAULT_PORT} to ${DEFAULT_PORT + 50}`)
}
