import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createVite } from 'vite'
import solid from '@solidjs/vite-plugin'
import { ROOT, PORT, EVENTS_FILE, REGISTRY_FILE, globalConfigFile, projects, projectByName } from './config.js'
import { appendEvent, readEvents, matches } from './events.js'
import { createTemplateLoader } from './templates.js'
import { renderMarkdown, esc } from './markdown.js'

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = path.join(ENGINE_DIR, 'src', 'client')
const DEFINE = path.join(ENGINE_DIR, 'src', 'define.ts')
const USER_CSS = path.join(ROOT, 'style.css')
const MIME = {
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
}

const httpServer = http.createServer()

// Vite compiles template client modules (and loads configs). The Solid plugin is the default
// toolchain for local .tsx templates; pre-built template packages need no compiler at all.
const vite = await createVite({
  configFile: false,
  root: CLIENT_DIR,
  appType: 'custom',
  plugins: [solid()],
  resolve: {
    // templates and configs live anywhere on disk; give them the engine's single copies
    dedupe: ['solid-js', '@solidjs/web'],
    alias: {
      '@visualize/engine/config': DEFINE,
      '@visualize/engine/template': DEFINE,
      '@visualize/engine/client': path.join(CLIENT_DIR, 'api.ts'),
    },
  },
  optimizeDeps: { include: ['morphdom'] },
  server: {
    middlewareMode: true,
    hmr: { server: httpServer },
    fs: { strict: true, allow: [ENGINE_DIR, ROOT] },
  },
})
const templates = createTemplateLoader(vite)

/** Vite serves only allowed folders; template folders are allowed and watched as pages use them. */
function allow(dir) {
  const list = vite.config.server.fs.allow
  if (!list.some(a => dir === a || dir.startsWith(a + path.sep))) {
    list.push(dir)
    vite.watcher.add(dir)
  }
}

// ---- locating pages ----------------------------------------------------------------------------

/** Resolve a path inside a base folder, refusing anything that escapes it. */
function inside(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel))
  return p === base || p.startsWith(base + path.sep) ? p : null
}

/**
 * A URL path → where it lives. "/<project>/<rest>" is in that project's pages folder; anything
 * else is in the root folder.
 */
function locate(id) {
  const [first, ...rest] = id.split('/')
  const project = first ? projectByName(first) : null
  if (project) {
    watchProject(project)
    if (rest[0] === '-') return { project, repo: true, base: project.dir, rel: rest.slice(1).join('/'), prefix: `${project.name}/-` }
    return { project, base: project.pagesDir, rel: rest.join('/'), prefix: project.name }
  }
  return { project: null, base: ROOT, rel: id, prefix: '' }
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
  for (const e of readEvents()) last.set(e.page, e)
  return `<ul class="vz-index">${pages.map(p => {
    const ev = last.get(p.id)
    return `<li><a href="/${esc(p.id)}">${esc(p.title)}</a> <span class="vz-meta"><code>${esc(p.id)}</code> · edited <time data-ts="${p.mtime}"></time>${
      ev ? ` · last submit <time data-ts="${Date.parse(ev.ts)}"></time>` : ''}</span></li>`
  }).join('')}</ul>`
}

/** The overview at "/": every project, then pages kept in the root folder. */
function homeHtml() {
  const parts = ['<h1>Pages</h1>']
  for (const p of projects()) {
    watchProject(p)
    const pages = listPages(p.pagesDir, p.name)
    parts.push(`<h2><a href="/${esc(p.name)}/">${esc(p.name)}</a></h2><p class="vz-meta"><code>${esc(p.dir)}</code> · <a href="/_/docs?project=${esc(p.name)}">templates</a></p>`)
    parts.push(pages.length ? pageList(pages.slice(0, 8)) : '<p class="vz-meta">No pages yet.</p>')
  }
  const loose = listPages(ROOT, '').filter(p => !projectByName(p.id.split('/')[0]))
  if (loose.length) parts.push('<h2>Other pages</h2>', pageList(loose))
  if (parts.length === 1) parts.push(`<p>No projects yet. Run <code>visualize init</code> in a repo.</p>`)
  return parts.join('')
}

function folderHtml(loc) {
  const id = [loc.prefix, loc.rel].filter(Boolean).join('/')
  const pages = listPages(path.join(loc.base, loc.rel), id)
  const docs = loc.project && !loc.rel ? ` · <a href="/_/docs?project=${esc(loc.project.name)}">templates</a>` : ''
  return `<h1>${esc(id)}</h1>${pages.length ? pageList(pages) : '<p class="vz-meta">No pages yet.</p>'}<p class="vz-meta">${esc(path.join(loc.base, loc.rel))}${docs}</p>`
}

const SKIP_DIRS = new Set(['node_modules', '.git'])

/** The URL that serves a file or folder on disk, or null when nothing here serves it. */
function urlFor(abs) {
  const within = (dir) => abs === dir || abs.startsWith(dir + path.sep)
  const rel = dir => path.relative(dir, abs).split(path.sep).map(encodeURIComponent).join('/')
  for (const p of projects()) {
    if (within(p.pagesDir)) return `/${p.name}/${rel(p.pagesDir).replace(/\.md$/, '')}`
  }
  for (const p of projects()) {
    if (within(p.dir)) {
      if (rel(p.dir).split('/').some(part => SKIP_DIRS.has(part))) return null
      return `/${p.name}/-/${rel(p.dir)}`
    }
  }
  if (within(ROOT)) return `/${rel(ROOT).replace(/\.md$/, '')}`
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
  return `<h1>${esc(loc.rel || loc.project.name)}</h1><ul class="vz-files">${up}${rows}</ul><p class="vz-meta">${esc(dir)} · <code>${esc(id)}</code></p>`
}

/** A repository path: markdown renders as a page, folders list their files (and README), other text shows as code. */
async function renderRepo(id, loc) {
  const target = inside(loc.base, loc.rel)
  if (!target || !fs.existsSync(target) || target.split(path.sep).includes('.git')) return null
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    const listing = repoDirHtml(loc, target)
    const readme = ['README.md', 'readme.md', 'Readme.md'].map(n => path.join(target, n)).find(f => fs.existsSync(f))
    if (!readme) return { id, title: loc.rel || loc.project.name, isDir: true, html: listing, islands: {}, styles: [] }
    const r = await renderFile(readme, id, loc.project)
    return { id, ...r, html: `${r.html}<hr>${listing}`, mtime: fs.statSync(readme).mtimeMs }
  }
  if (/\.(md|markdown)$/i.test(target)) return { id, ...(await renderFile(target, id, loc.project)), mtime: stat.mtimeMs }
  if (stat.size > 1e6 || !isText(target)) return null
  const lang = CODE_LANG[path.extname(target).slice(1).toLowerCase()] ?? ''
  const code = fs.readFileSync(target, 'utf8')
  const html = `<h1 class="vz-code-title">${esc(loc.rel)}</h1><pre class="vz-code"><code${lang ? ` class="language-${lang}"` : ''}>${esc(code)}</code></pre>`
  return { id, title: path.basename(target), html, islands: {}, styles: [], mtime: stat.mtimeMs }
}

async function renderFile(file, page, project) {
  const { templates: set, errors } = await templates.forProject(project)
  for (const t of set.values()) for (const f of [t.client, t.style, t.readme]) if (f) allow(path.dirname(f))
  const rendered = await renderMarkdown(fs.readFileSync(file, 'utf8'), { page, file, resolve: name => set.get(name) ?? null, linkFor })
  const notice = errors.map(e => `<pre class="vz-error">config: ${esc(e.message)}</pre>`).join('')
  return { ...rendered, html: notice + rendered.html }
}

/** @returns page data, or null when nothing exists at `id` */
async function renderPage(id) {
  const loc = locate(id)
  const target = inside(loc.base, loc.rel)
  if (!target) return null
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, 'index.md')
    if (fs.existsSync(index) && id) return { id, ...(await renderFile(index, id, loc.project)), mtime: fs.statSync(index).mtimeMs }
    return { id, title: id || 'visualize', isDir: true, html: id ? folderHtml(loc) : homeHtml(), islands: {}, styles: [] }
  }
  if (!id && !fs.existsSync(target)) return { id, title: 'visualize', isDir: true, html: homeHtml(), islands: {}, styles: [] }
  const file = inside(loc.base, loc.rel + '.md')
  if (!file || !fs.existsSync(file)) return null
  return { id, ...(await renderFile(file, id, loc.project)), mtime: fs.statSync(file).mtimeMs }
}

async function templateInfo(project) {
  const { templates: set, errors } = await templates.forProject(project)
  return {
    errors: errors.map(e => e.message),
    templates: [...set.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
      name: t.name, source: t.source, client: !!t.client, html: !!t.html, props: !!t.props,
      readme: t.readme ? fs.readFileSync(t.readme, 'utf8') : null,
    })),
  }
}

async function renderDocs(projectName) {
  const project = projectName ? projectByName(projectName) : null
  const { templates: list, errors } = await templateInfo(project)
  const parts = list.map(t => {
    const where = `<p class="vz-meta">from <code>${esc(t.source)}</code>${t.client ? ' · client' : ''}${t.html ? ' · html' : ''}${t.props ? ' · props' : ''}</p>`
    const readme = t.readme ?? `# ${t.name}\n\n_No readme._\n`
    return readme.replace(/^(#\s.*)$/m, `$1\n\n${where}\n`)
  })
  const scope = project ? `for **${project.name}**` : 'from the global config'
  const intro = list.length
    ? `# Templates\n\nAvailable ${scope}: ${list.map(t => `[${t.name}](#${t.name})`).join(' · ')}\n\n`
    : `# Templates\n\nNo templates ${scope}. Add them to the \`templates\` array in ${project ? `\`${project.configFile}\`` : `\`${ROOT}/config.ts\``}.\n`
  // docs are not a file; this path only serves as the render's location for relative references
  const file = project ? path.join(project.pagesDir, '_docs.md') : path.join(ROOT, '_docs.md')
  const { templates: set } = await templates.forProject(project)
  const out = await renderMarkdown(intro + parts.join('\n\n---\n\n'), { page: '_/docs', file, resolve: name => set.get(name) ?? null, linkFor })
  const notice = errors.map(e => `<pre class="vz-error">config: ${esc(e)}</pre>`).join('')
  return { id: '_/docs', ...out, html: notice + out.html, title: 'Templates' }
}

function crumbs(id) {
  let acc = ''
  return `<a href="/">~</a>` + (id ? id.split('/') : []).map(p => { acc += '/' + p; return ` / <a href="${esc(acc)}">${esc(p)}</a>` }).join('')
}

const json = s => JSON.stringify(s).replace(/</g, '\\u003c')

function shell(page) {
  const styles = page.styles.map(s => `<link rel="stylesheet" href="/@fs${esc(s)}" data-vz-style>`).join('')
  const projectCss = page.project && fs.existsSync(path.join(page.project.dir, '.visualize', 'style.css'))
    ? `<link rel="stylesheet" href="/_/project.css?p=${esc(page.project.name)}" data-vz-style>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title || page.id || 'visualize')}</title>
<script>try{const t=localStorage.getItem('vz-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}</script>
<link rel="stylesheet" href="/_/base.css" data-vz-style>${fs.existsSync(USER_CSS) ? '<link rel="stylesheet" href="/_/user.css" data-vz-style>' : ''}${projectCss}${styles}
<script type="module" src="/@vite/client"></script></head>
<body data-page="${esc(page.id)}"${page.isDir ? ' data-dir' : ''}>
<nav class="vz-nav"><span>${crumbs(page.id)}</span>${page.mtime ? `<span class="vz-meta">updated <time id="vz-updated" data-ts="${page.mtime}"></time></span>` : ''}<button type="button" class="vz-theme" title="Theme: follow the system, light or dark">auto</button><span class="vz-live" title="live reload"></span></nav>
<main id="vz-main">${page.html}</main>
<script type="application/json" id="vz-islands">${json(page.islands)}</script>
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

// root folder: loose pages, the event log, the registry, the global config
fs.watch(ROOT, { recursive: true }, (_evt, filename) => {
  if (!filename) return
  const f = filename.replace(/\\/g, '/')
  if (f === path.basename(EVENTS_FILE)) return notifyAll('events')
  if (f === path.basename(REGISTRY_FILE)) return notifyAll('change')
  if (f === 'style.css') return notifyAll('style')
  if (/^config\.[mc]?[jt]s$/.test(f)) { templates.invalidate(); return notifyAll('change') }
  if (f.endsWith('.md')) pageChanged(f.replace(/\.md$/, ''))
})

// each project: its pages folder (fs.watch) and its .visualize folder (config, local templates; via Vite)
const watched = new Set()
function watchProject(project) {
  if (watched.has(project.dir)) return
  watched.add(project.dir)
  fs.mkdirSync(project.pagesDir, { recursive: true })
  fs.watch(project.dir, { recursive: true }, (_evt, filename) => {
    if (!filename) return
    const f = filename.replace(/\\/g, '/')
    if (f.split('/').some(part => SKIP_DIRS.has(part))) return
    if (f.startsWith('.visualize/pages/')) {
      if (f.endsWith('.md')) pageChanged(`${project.name}/${f.slice('.visualize/pages/'.length).replace(/\.md$/, '')}`)
      return
    }
    // a repository file; its folder's listing shows it too
    pageChanged(`${project.name}/-/${f}`)
    const parent = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
    pageChanged(`${project.name}/-${parent ? '/' + parent : ''}`)
  })
  allow(path.join(project.dir, '.visualize'))
}
for (const p of projects()) watchProject(p)

// Components hot-reload through Vite. Styles reload in place. Anything else a template or config
// is made of changes the server render: reload configs and re-render open pages.
function onSourceChange(file) {
  if (file.includes(`${path.sep}.visualize${path.sep}pages${path.sep}`)) return
  if (/\.[mc]?[jt]sx$/.test(file)) return
  if (file.endsWith('.css')) return notifyAll('style')
  templates.invalidate()
  vite.moduleGraph.invalidateAll()
  notifyAll('change')
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

httpServer.on('request', async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    const p = decodeURIComponent(url.pathname)
    const q = Object.fromEntries(url.searchParams)

    if (isViteRequest(p)) return vite.middlewares(req, res, () => send(res, 404, 'not found', 'text/plain'))

    if (p === '/favicon.ico') { res.writeHead(204); return res.end() }
    if (p === '/api/health') return sendJson(res, 200, { ok: true, root: ROOT, pid: process.pid })
    if (p === '/api/events' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!body.form) return sendJson(res, 400, { error: 'form name required' })
      return sendJson(res, 200, appendEvent(body))
    }
    if (p === '/api/events') return sendJson(res, 200, readEvents().filter(e => matches(e, q)))
    if (p === '/api/templates') {
      const project = q.project ? projectByName(q.project) : null
      if (q.project && !project) return sendJson(res, 404, { error: `no project named ${q.project}` })
      return sendJson(res, 200, await templateInfo(project))
    }
    if (p === '/api/projects') return sendJson(res, 200, projects())
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
    if (p === '/_/user.css') return send(res, 200, fs.existsSync(USER_CSS) ? fs.readFileSync(USER_CSS) : '', 'text/css')
    if (p === '/_/project.css') {
      const project = projectByName(q.p ?? '')
      const f = project && path.join(project.dir, '.visualize', 'style.css')
      return send(res, 200, f && fs.existsSync(f) ? fs.readFileSync(f) : '', 'text/css')
    }

    let page
    if (p === '/_/docs') page = await renderDocs(q.project)
    else if (locate(p.replace(/^\/+/, '').replace(/\/+$/, '')).repo) {
      const id = p.replace(/^\/+/, '').replace(/\/+$/, '')
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
      if (page) page.project = loc.project
      else if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
        return send(res, 200, fs.readFileSync(target), MIME[ext] || 'application/octet-stream')
      } else {
        return send(res, 404, shell({ id, title: 'Not found', islands: {}, styles: [], html: `<h1>Not found</h1><p><code>${esc(target ?? id)}</code> does not exist.</p>` }))
      }
    }
    else {
      const id = p.replace(/^\/+|\/+$/g, '').replace(/\.md$/, '')
      const loc = locate(id)
      const ext = path.extname(id)
      if (ext) {
        const f = inside(loc.base, loc.rel)
        if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return send(res, 200, fs.readFileSync(f), MIME[ext.toLowerCase()] || 'application/octet-stream')
        return send(res, 404, 'not found', 'text/plain')
      }
      // a folder (with an index.md, or a project root): serve at /dir/ so relative links resolve inside it
      const dir = inside(loc.base, loc.rel)
      if (id && !p.endsWith('/') && dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        res.writeHead(302, { location: `/${id}/${url.search}` })
        return res.end()
      }
      page = await renderPage(id)
      if (page) page.project = loc.project
      if (!page) {
        const where = inside(loc.base, loc.rel + '.md') ?? id
        return send(res, 404, shell({ id, title: 'Not found', islands: {}, styles: [],
          html: `<h1>Not found</h1><p><code>${esc(where)}</code> does not exist yet. This page loads as soon as it does.</p>` }))
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

export function start() {
  httpServer.on('error', err => {
    if (err.code === 'EADDRINUSE') { console.error(`port ${PORT} is already in use (is visualize already running?)`); process.exit(1) }
    throw err
  })
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`visualize: http://localhost:${PORT}`)
    const list = projects()
    console.log(list.length ? `projects: ${list.map(p => `${p.name} (${p.dir})`).join(', ')}` : 'projects: none yet (run `visualize init` in a repo)')
    if (globalConfigFile()) console.log(`global config: ${globalConfigFile()}`)
  })
}
