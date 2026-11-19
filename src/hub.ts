// The shared server: one per machine, serving every project of the machine config's entries, each
// under its own path (see entries.ts). A request handler like a project's server, so tests make one
// for a throwaway machine folder and send it requests; listening and its record are serve.ts.
//
//   /                  the index: each entry, its projects, their pages and what is open on them
//   /<entry>/<path>/…  a project, as its own server serves it at / (createServer with a base)
//   /api/health        { hub: true, pid, version, projects }; `?rescan` looks for projects first
//   /api/index         what the index shows, as JSON
//   /api/shutdown      POST { version }: a newer whiteboard takes over; an older one is refused
//
// A project's server is made when the project is found and closed when it goes, so a project
// appears and disappears without a restart. Each keeps its own state, config and log, as it would
// on a port of its own: the shared server only routes.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { project as projectAt, type Project } from './config.ts'
import { followEntries, machineDir, readMachineConfig, type EntryProject } from './entries.ts'
import { html, raw } from './html.ts'
import { compareVersions, VERSION } from './package.ts'
import { createServer, type WhiteboardServer } from './server.ts'
import { awaiting } from './status.ts'
import type { PageStatus } from './define.ts'

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
}

/** What the index shows of one project. */
export interface IndexProject {
  entry: string
  dir: string
  base: string
  name: string
  pages: { page: string; title: string; url: string; open: string[]; unread: number; unpicked: number }[]
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
      served.set(key, { ...p, project, server: createServer(project, { base: p.base, entry: p.entry }) })
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
        const at = { entry: s.entry, dir: s.dir, base: s.base, name: s.project.name }
        let pages: PageStatus[]
        try {
          pages = await s.server.status()
        } catch (err) {
          return { ...at, pages: [], error: (err as Error).message }
        }
        return {
          ...at,
          pages: pages.map(p => ({
            page: p.page,
            title: p.title,
            url: `${s.base}/${p.page.split('/').map(encodeURIComponent).join('/')}`,
            open: p.open,
            unread: p.unread.length,
            unpicked: p.unpicked.length,
          })),
        }
      }),
    )
  }

  function indexPage(projects: IndexProject[]): string {
    const byEntry = new Map<string, IndexProject[]>()
    for (const p of projects) byEntry.set(p.entry, [...(byEntry.get(p.entry) ?? []), p])
    const pageRow = (p: IndexProject['pages'][number]) => {
      const n = awaiting({ open: p.open, unread: Array(p.unread) })
      return html`<li>
        <a href="${p.url}${n > 0 ? '#wb-waiting' : ''}">${p.title}</a>
        <code>${p.page}</code>
        ${p.open.length > 0 && html`<span class="open">unanswered: ${p.open.join(', ')}</span>`}
        ${p.unread > 0 && html`<span class="open">${p.unread} unread</span>`}
        ${p.unpicked > 0 && html`<span class="unpicked">${p.unpicked} answer${p.unpicked === 1 ? '' : 's'} no agent picked up</span>`}
      </li>`
    }
    const projectBlock = (p: IndexProject) => {
      const open = p.pages.filter(x => x.open.length || x.unread || x.unpicked)
      return html`<section class="project">
        <h3>
          <a href="${p.base}/">${p.base.split('/').slice(2).join('/')}</a>
          <span class="meta">${p.name} · <code>${p.dir}</code></span>
        </h3>
        ${p.error && html`<pre class="error">${p.error}</pre>`}
        ${
          p.pages.length
            ? html`<ul>
                ${[...open, ...p.pages.filter(x => !open.includes(x))].map(pageRow)}
              </ul>`
            : html`<p class="meta">No pages.</p>`
        }
      </section>`
    }
    const total = projects.reduce((n, p) => n + p.pages.reduce((m, x) => m + x.open.length + x.unread, 0), 0)
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
              <h1>whiteboard</h1>
              ${
                projects.length
                  ? [...byEntry].map(
                      ([entry, list]) =>
                        html`<section class="entry">
                          <h2>${entry}</h2>
                          ${list.map(projectBlock)}
                        </section>`,
                    )
                  : html`<p>
                      No projects: no folder an include of <code>${dir}/config.json</code> matches has a
                      <code>.whiteboard/</code> folder.
                    </p>`
              }
              <p class="meta">whiteboard ${version} · pid ${process.pid} · <code>${dir}/config.json</code></p>
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
  const list = () => [...served.values()].map(({ entry, dir, base }) => ({ entry, dir, base }))

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
      if (p === '/api/index') return sendJson(res, 200, await index())
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

  return {
    handle,
    projects: list,
    rescan() {
      entries.rescan()
      return list()
    },
    close() {
      entries.stop()
      for (const s of served.values()) s.server.close()
      served.clear()
    },
  }
}

const INDEX_STYLE = `
:root{color-scheme:light dark;--fg:#1d2128;--muted:#6b7280;--bg:#fbfbfa;--line:#e3e3e0;--accent:#1d5bbf;--bad:#c4352b}
@media (prefers-color-scheme:dark){:root{--fg:#e3e5e8;--muted:#9aa1ab;--bg:#15171b;--line:#2b2f36;--accent:#6ea0ff;--bad:#ff7a6e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:1.4rem;margin:0 0 16px}h2{font-size:1.15rem;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:1rem;margin:16px 0 4px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
ul{margin:0;padding-left:18px}li{margin:2px 0}code{font-size:.85em;color:var(--muted)}
.meta{color:var(--muted);font-weight:400;font-size:.85rem}.open{color:var(--bad);font-size:.85rem;margin-left:6px}
.unpicked{color:var(--muted);font-size:.85rem;margin-left:6px}.error{color:var(--bad);white-space:pre-wrap}
`

// the index stays current: it asks for itself again every few seconds, and swaps in what changed
const INDEX_SCRIPT = `
setInterval(async () => {
  try {
    const text = await (await fetch(location.pathname, { cache: 'no-store' })).text()
    const doc = new DOMParser().parseFromString(text, 'text/html')
    const next = doc.getElementById('wb-index')
    const now = document.getElementById('wb-index')
    if (next && now && next.innerHTML !== now.innerHTML) now.replaceWith(next)
    document.title = doc.title
  } catch {}
}, 3000)
`
