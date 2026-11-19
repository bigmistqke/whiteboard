// The shared server: one per machine, serving every project of the machine config's entries, each
// under its own path (see entries.ts). A request handler like a project's server, so tests make one
// for a throwaway machine folder and send it requests; listening and its record are serve.ts.
//
//   /                  the index: each entry, its projects, their pages and what is open on them
//   /<entry>/<path>/…  a project, as its own server serves it at / (createServer with a base)
//   /api/health        { hub: true, pid, version, projects }; `?rescan` looks for projects first
//   /api/index         what the index shows, as JSON
//   /api/shutdown      POST { version }: a newer whiteboard takes over; an older one is refused
//   /api/listen?entry=<name>&command=wait|watch
//                      the fallback of a whole entry, for as long as the connection is open: one per
//                      entry, held on every page of its projects, also those that appear meanwhile
//
// A project's server is made when the project is found and closed when it goes, so a project
// appears and disappears without a restart. Each keeps its own state, config and log, as it would
// on a port of its own: the shared server only routes.
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { project as projectAt, type Project } from './config.ts'
import { followEntries, machineDir, readMachineConfig, type EntryProject } from './entries.ts'
import { html, raw } from './html.ts'
import { compareVersions, VERSION } from './package.ts'
import { createServer, type WhiteboardServer } from './server.ts'
import { awaiting } from './status.ts'
import type { Listener, PageStatus } from './define.ts'

export interface HubOptions {
  /** the machine folder (its config.json); default machineDir() */
  dir?: string
  /** what `~` means in the globs (tests) */
  home?: string
  /** how often to look for projects coming and going, in ms */
  interval?: number
  /** a newer whiteboard asked this one to make way (POST /api/shutdown) */
  onShutdown?: () => void
  /** the version this server says it is (tests); default the package's */
  version?: string
}

/** A project the shared server serves: where, and its own server. */
interface Served extends EntryProject {
  project: Project
  server: WhiteboardServer
  /** removes the entry's fallback from this project, while it holds one */
  fallback?: () => void
}

/** What the index shows of one page. */
export interface IndexPage {
  page: string
  title: string
  url: string
  /** when its file last changed, in ms */
  mtime: number
  /** its questions waiting for the reader */
  open: string[]
  /** the agent's messages on it the reader hasn't read */
  unread: number
  /** the reader's answers no agent picked up */
  unpicked: number
}

/** What the index shows of one project. */
export interface IndexProject {
  entry: string
  group: string
  name: string
  /** how the reader knows it: `develop`, `worktrees › cmux` */
  label: string
  dir: string
  base: string
  /** its pages, the latest changed first */
  pages: IndexPage[]
  /** when one of its pages last changed; 0 without pages */
  active: number
  error?: string
}

export interface Hub {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** the projects it serves now */
  projects(): EntryProject[]
  /** look for projects coming and going now */
  rescan(): EntryProject[]
  close(): void
}

export function createHub({ dir = machineDir(), home, interval, onShutdown, version = VERSION }: HubOptions = {}): Hub {
  const served = new Map<string, Served>()
  // each entry's fallback, while one runs: the listener its projects hold
  const fallbacks = new Map<string, Listener>()

  function sync(projects: EntryProject[]) {
    const wanted = new Map(projects.map(p => [`${p.base}\n${p.dir}`, p]))
    for (const [key, s] of served)
      if (!wanted.has(key)) {
        s.server.close()
        served.delete(key)
        console.log(`whiteboard: ${s.base} is gone (${s.dir})`)
      }
    for (const [key, p] of wanted) {
      if (served.has(key)) continue
      const project = projectAt(p.dir)
      if (!project) continue
      const server = createServer(project, {
        base: p.base,
        entry: p.entry,
        label: [p.group, p.name].filter(Boolean).join(' › '),
      })
      const fallback = fallbacks.get(p.entry)
      served.set(key, { ...p, project, server, ...(fallback && { fallback: server.addListener(fallback) }) })
      console.log(`whiteboard: ${p.base} → ${p.dir}`)
    }
  }

  const entries = followEntries(() => readMachineConfig(dir), sync, { interval, home })

  /** The project a path is under: the longest base that is the path or a folder above it. */
  const owner = (p: string): Served | null => {
    let best: Served | null = null
    for (const s of served.values())
      if ((p === s.base || p.startsWith(s.base + '/')) && (!best || s.base.length > best.base.length)) best = s
    return best
  }

  async function index(): Promise<IndexProject[]> {
    return Promise.all(
      [...served.values()].map(async (s): Promise<IndexProject> => {
        const at = {
          entry: s.entry,
          group: s.group,
          name: s.name,
          label: [s.group, s.name].filter(Boolean).join(' › '),
          dir: s.dir,
          base: s.base,
        }
        let statuses: PageStatus[]
        try {
          statuses = await s.server.status()
        } catch (err) {
          return { ...at, pages: [], active: 0, error: (err as Error).message }
        }
        const pages = statuses
          .map((p): IndexPage => ({
            page: p.page,
            title: p.title,
            url: `${s.base}/${p.page.split('/').map(encodeURIComponent).join('/')}`,
            mtime: mtimeOf(p.file),
            open: p.open,
            unread: p.unread.length,
            unpicked: p.unpicked.length,
          }))
          .toSorted((a, b) => b.mtime - a.mtime)
        return { ...at, pages, active: pages[0]?.mtime ?? 0 }
      }),
    )
  }

  function indexPage(projects: IndexProject[]): string {
    const now = Date.now()
    const waits = (p: IndexPage) => p.open.length + p.unread
    // what waits for the reader, wherever it is: their to-do, the latest first
    const needs = projects
      .flatMap(project => project.pages.filter(p => waits(p) > 0).map(page => ({ project, page })))
      .toSorted((a, b) => b.page.mtime - a.page.mtime)
    const total = needs.reduce((n, x) => n + waits(x.page), 0)
    const what = (p: IndexPage) =>
      [
        p.open.length > 0 && html`<span class="open">${p.open.join(', ')} unanswered</span>`,
        p.unread > 0 && html`<span class="open">${p.unread} unread</span>`,
        p.unpicked > 0 &&
          html`<span class="unpicked">${p.unpicked} answer${p.unpicked === 1 ? '' : 's'} no agent picked up</span>`,
      ].filter(Boolean)
    const pageLink = (p: IndexPage) =>
      html`<a href="${p.url}${waits(p) > 0 ? '#wb-waiting' : ''}" title="${p.page}"
        >${p.title}${waits(p) > 0 && html` <b class="count">${waits(p)}</b>`}</a
      >`
    const projectRow = (p: IndexProject) =>
      html`<li class="project">
        <a class="name" href="${p.base}/" title="${p.dir}">${p.name || p.group}</a>
        <span class="pages">${p.pages.map((x, i) => html`${i > 0 ? ' · ' : ''}${pageLink(x)}`)}</span>
        ${p.error && html`<span class="open">${p.error}</span>`}
        <span class="when">${ago(now, p.active)}</span>
      </li>`
    const entryBlock = (entry: string, list: IndexProject[]) => {
      const groups = new Map<string, IndexProject[]>()
      for (const p of list) groups.set(p.group, [...(groups.get(p.group) ?? []), p])
      const empty = list.filter(p => !p.pages.length && !p.error)
      return html`<section class="entry">
        <h2>${entry}</h2>
        ${[...groups].map(([group, members]) => {
          const shown = members.filter(p => p.pages.length || p.error).toSorted((a, b) => b.active - a.active)
          if (!shown.length) return ''
          // a group of one (develop) is its project; a group of many is listed under its name
          return members.length === 1 && !members[0]!.name
            ? html`<ul class="projects">
                ${projectRow({ ...shown[0]!, name: group })}
              </ul>`
            : html`<h3>${group} <span class="meta">${shown.length} with pages</span></h3>
                <ul class="projects">
                  ${shown.map(projectRow)}
                </ul>`
        })}
        ${
          empty.length > 0 &&
          html`<details class="empty">
            <summary>${empty.length} without pages</summary>
            <ul>
              ${empty.map(p => html`<li><a href="${p.base}/" title="${p.dir}">${p.label}</a></li>`)}
            </ul>
          </details>`
        }
      </section>`
    }
    const byEntry = new Map<string, IndexProject[]>()
    for (const p of projects) byEntry.set(p.entry, [...(byEntry.get(p.entry) ?? []), p])
    // the folders the server is boxed to, as whoever started it says (see DESIGN.md, Entries)
    const boxed = (process.env.WHITEBOARD_SANDBOX ?? '').split(':').filter(Boolean)
    return String(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>${total > 0 ? `(!${total}) ` : ''}whiteboard</title>
            <style>
              ${raw(INDEX_STYLE)}
            </style>
          </head>
          <body>
            <main id="wb-index">
              <header>
                <h1>whiteboard</h1>
                <span class="meta"
                  >${version} ·
                  ${
                    boxed.length
                      ? html`boxed: ${boxed.map((d, i) => html`${i > 0 ? ', ' : ''}<code>${d}</code>`)}`
                      : html`<span title="WHITEBOARD_SANDBOX names no folders">not boxed</span>`
                  }</span
                >
              </header>
              ${
                needs.length > 0 &&
                html`<section class="needs">
                  <h2>Needs you <span class="meta">${total}</span></h2>
                  <ul>
                    ${needs.map(
                      ({ project, page }) =>
                        html`<li>
                          <span class="where">${project.label} ›</span> ${pageLink(page)} ${what(page)}
                          <span class="when">${ago(now, page.mtime)}</span>
                        </li>`,
                    )}
                  </ul>
                </section>`
              }
              ${
                projects.length
                  ? [...byEntry].map(([entry, list]) => entryBlock(entry, list))
                  : html`<p>
                      No projects: no folder an include of <code>${dir}/config.json</code> matches has a
                      <code>.whiteboard/</code> folder.
                    </p>`
              }
              <p class="meta">pid ${process.pid} · <code>${dir}/config.json</code></p>
            </main>
            <script>
              ${raw(INDEX_SCRIPT)}
            </script>
          </body>
        </html>`,
    )
  }

  const send = (res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  const sendJson = (res: ServerResponse, status: number, data: unknown) =>
    send(res, status, JSON.stringify(data), 'application/json')
  const list = () =>
    [...served.values()].map(({ entry, group, name, dir, base }) => ({ entry, group, name, dir, base }))

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', c => {
        body += c
        if (body.length > 1e4) req.destroy()
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL((req.url ?? '/').replace(/^\/+/, '/'), 'http://localhost')
      const p = decodeURIComponent(url.pathname)
      if (p === '/api/health') {
        if (url.searchParams.has('rescan')) entries.rescan()
        return sendJson(res, 200, { ok: true, hub: true, pid: process.pid, version, dir, projects: list() })
      }
      if (p === '/api/index') {
        const entry = url.searchParams.get('entry')
        return sendJson(
          res,
          200,
          (await index()).filter(x => !entry || x.entry === entry),
        )
      }
      if (p === '/api/shutdown' && req.method === 'POST') {
        // only from the command line: a page of a project has an Origin
        if (req.headers.origin) return sendJson(res, 403, { error: 'not from a browser' })
        let asker = ''
        try {
          asker = String(JSON.parse(await readBody(req)).version ?? '')
        } catch {}
        // an older whiteboard never replaces a newer one, nor one as new
        if (!asker || compareVersions(asker, version) <= 0)
          return sendJson(res, 409, { error: `whiteboard ${version} runs here; ${asker || 'that'} is not newer` })
        sendJson(res, 200, { ok: true, version })
        setImmediate(() => onShutdown?.())
        return
      }
      if (p === '/api/listen' && url.searchParams.has('entry')) return listenEntry(req, res, url.searchParams)
      if (p === '/' || p === '') return send(res, 200, indexPage(await index()))
      if (p === '/favicon.ico') {
        res.writeHead(204)
        return void res.end()
      }
      let s = owner(p)
      let rest: string
      if (s) {
        // the project's overview is at its folder: /rg/develop/
        if (p === s.base) {
          res.writeHead(302, { location: `${s.base}/${url.search}` })
          return void res.end()
        }
        // the path less the project's part, encoded again for the project's server to decode
        rest = p.slice(s.base.length).split('/').map(encodeURIComponent).join('/') + url.search
      } else {
        // A plugin's browser module that writes `/api/<name>/…` itself, from before api.url: the page
        // that asked is in the Referer, and the request is that project's.
        const from = req.headers.referer ? new URL(req.headers.referer).pathname : null
        s = /^\/(api|_)\//.test(p) && from ? owner(decodeURIComponent(from)) : null
        if (!s) return send(res, 404, String(html`<p>Nothing here. <a href="/">The index</a> lists what is.</p>`))
        rest = (req.url ?? '/').replace(/^\/+/, '/')
      }
      req.url = rest
      return s.server.handle(req, res)
    } catch (err) {
      console.error(err)
      send(res, 500, String((err as Error)?.stack || err), 'text/plain')
    }
  }

  /**
   * The fallback of a whole entry (a `wait` or `watch` without --page in one of its projects): one
   * per entry, refused (409) while another runs, or while a project of it has a fallback of its own
   * (from a whiteboard before entries). Each project holds it as a listener, so its pages say an
   * agent listens; the command itself reads the projects' logs.
   */
  function listenEntry(req: IncomingMessage, res: ServerResponse, q: URLSearchParams) {
    const entry = q.get('entry')!
    const projects = [...served.values()].filter(s => s.entry === entry)
    if (fallbacks.has(entry)) return sendJson(res, 409, { error: `another agent is the fallback of ${entry} already` })
    const own = projects.find(s => s.server.listeners().some(x => x.fallback))
    if (own)
      return sendJson(res, 409, {
        error: `${own.base} has a fallback of its own already (a wait or watch without --page)`,
      })
    const l: Listener = {
      page: '',
      type: q.get('type') || null,
      command: q.get('command') === 'wait' ? 'wait' : 'watch',
      fallback: true,
    }
    fallbacks.set(entry, l)
    for (const s of projects) s.fallback = s.server.addListener(l)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': listening\n\n')
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    const end = () => {
      clearInterval(ping)
      if (fallbacks.get(entry) !== l) return
      fallbacks.delete(entry)
      for (const s of served.values()) {
        s.fallback?.()
        delete s.fallback
      }
    }
    closers.add(() => {
      end()
      res.end()
    })
    req.on('close', end)
  }
  const closers = new Set<() => void>()

  return {
    handle,
    projects: list,
    rescan() {
      entries.rescan()
      return list()
    },
    close() {
      for (const c of closers) c()
      entries.stop()
      for (const s of served.values()) s.server.close()
      served.clear()
    },
  }
}

const mtimeOf = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** How long ago, in a word or two: "2m ago", "3 days ago". */
function ago(now: number, then: number): string {
  if (!then) return ''
  const s = Math.max(0, (now - then) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

const INDEX_STYLE = `
:root{color-scheme:light dark;--fg:#1d2128;--muted:#6b7280;--bg:#fbfbfa;--line:#e3e3e0;--accent:#1d5bbf;--bad:#c4352b;--soft:#f1f0ec}
@media (prefers-color-scheme:dark){:root{--fg:#e3e5e8;--muted:#9aa1ab;--bg:#15171b;--line:#2b2f36;--accent:#6ea0ff;--bad:#ff7a6e;--soft:#1d2025}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 48px}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-size:1.4rem;margin:0}h2{font-size:1.1rem;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:.9rem;margin:14px 0 2px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul{margin:0;padding:0;list-style:none}li{margin:0}code{font-size:.85em;color:var(--muted)}
.meta{color:var(--muted);font-weight:400;font-size:.85rem;text-transform:none;letter-spacing:0}
.open{color:var(--bad);font-size:.85rem;margin-left:6px}.unpicked{color:var(--muted);font-size:.85rem;margin-left:6px}
.count{display:inline-block;min-width:1.3em;padding:0 5px;border-radius:99px;background:var(--bad);color:#fff;font-size:.75rem;text-align:center}
.needs ul li{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;padding:5px 8px;border-radius:6px;background:var(--soft);margin:4px 0}
.where{color:var(--muted)}.when{margin-left:auto;color:var(--muted);font-size:.8rem;white-space:nowrap}
.projects li{display:flex;gap:12px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line)}
.projects .name{min-width:11em;font-weight:600}.projects .pages{flex:1;min-width:0}
.empty{margin-top:14px;color:var(--muted);font-size:.9rem}.empty summary{cursor:pointer}.empty ul{padding:6px 0 0 16px;columns:3 14em}
@media (max-width:600px){.projects li{flex-wrap:wrap}.projects .name{min-width:0}}
`

// the index stays current: it asks for itself again every few seconds, and swaps in what changed
const INDEX_SCRIPT = `
setInterval(async () => {
  try {
    const text = await (await fetch(location.pathname, { cache: 'no-store' })).text()
    const doc = new DOMParser().parseFromString(text, 'text/html')
    const next = doc.getElementById('wb-index')
    const now = document.getElementById('wb-index')
    if (next && now && next.innerHTML !== now.innerHTML) {
      // a fold the reader opened stays open
      const opened = [...now.querySelectorAll('details[open]')].map(d => d.closest('section')?.querySelector('h2')?.textContent)
      for (const d of next.querySelectorAll('details'))
        if (opened.includes(d.closest('section')?.querySelector('h2')?.textContent)) d.open = true
      now.replaceWith(next)
    }
    document.title = doc.title
  } catch {}
}, 3000)
`
