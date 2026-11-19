// The shared server: one per machine, serving every project of the machine config's entries, each
// under its own path (see entries.ts). A request handler like a project's server, so tests make one
// for a throwaway machine folder and send it requests; listening and its record are serve.ts.
//
//   /                  the overview: every project's pages, by project, what waits for the reader first;
//                      a project of the server's own (overview/ in the machine folder), rendered and
//                      live like any project's overview
//   /<entry>/<path>/…  a project, as its own server serves it at / (createServer with a base)
//   /api/health        { hub: true, pid, version, projects }; `?rescan` looks for projects first
//   /api/index         every project's pages and what is open on them, as JSON (?entry=: one entry's),
//                      for a page's menu of what waits elsewhere
//   /api/shutdown      POST { version }: a newer whiteboard takes over; an older one is refused
//   /api/listen?entry=<name>&command=wait|watch
//                      the fallback of a whole entry, for as long as the connection is open: one per
//                      entry, held on every page of its projects, also those that appear meanwhile
//
// A project's server is made when the project is found and closed when it goes, so a project
// appears and disappears without a restart. Each keeps its own state, config and log, as it would
// on a port of its own: the shared server only routes.
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { project as projectAt, type Project } from './config.ts'
import { followEntries, machineDir, readMachineConfig, stateDir, type EntryProject } from './entries.ts'
import { compareVersions, VERSION } from './package.ts'
import { createServer, type WhiteboardServer } from './server.ts'
import type { Listener, PageStatus } from './define.ts'

export interface HubOptions {
  /** the machine folder (its config.json), which the server only reads; default machineDir() */
  dir?: string
  /** the server's own folder, which it writes (the overview's project); default stateDir() */
  state?: string
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

/** A page, as /api/index gives it. */
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

/** A project, as /api/index gives it. */
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

export function createHub({
  dir = machineDir(),
  state = stateDir(),
  home,
  interval,
  onShutdown,
  version = VERSION,
}: HubOptions = {}): Hub {
  const served = new Map<string, Served>()
  // each entry's fallback, while one runs: the listener its projects hold
  const fallbacks = new Map<string, Listener>()

  function sync(projects: EntryProject[]) {
    // projects come and go: the overview lists them
    setImmediate(() => touch())
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
        onChange: () => touch(),
      })
      const fallback = fallbacks.get(p.entry)
      served.set(key, { ...p, project, server, ...(fallback && { fallback: server.addListener(fallback) }) })
      console.log(`whiteboard: ${p.base} → ${p.dir}`)
    }
  }

  // the overview at /: a project of the shared server's own, in the machine folder, whose overview
  // lists every project's pages; rendered and live like any project's, so it looks like one
  const overviewDir = path.join(state, 'overview')
  fs.mkdirSync(path.join(overviewDir, '.whiteboard', 'pages'), { recursive: true })
  const root = createServer(projectAt(overviewDir)!, {
    name: 'whiteboard',
    files: false,
    overview: async () => {
      const all = await Promise.all(
        [...served.values()].map(async s => ({
          title: [s.group, s.name].filter(Boolean).join(' › '),
          base: s.base,
          dir: s.dir,
          ...(await s.server.overview().catch(() => ({ pages: [], files: false }))),
        })),
      )
      const boxed = (process.env.WHITEBOARD_SANDBOX ?? '').split(':').filter(Boolean)
      return {
        groups: all.filter(g => g.pages.length).toSorted((a, b) => (b.pages[0]?.mtime ?? 0) - (a.pages[0]?.mtime ?? 0)),
        empty: all.filter(g => !g.pages.length).map(({ title, base }) => ({ title, base })),
        note: `whiteboard ${version} · ${boxed.length ? `boxed: ${boxed.join(', ')}` : 'not boxed'} · ${dir}/config.json`,
      }
    },
  })
  // what the overview lists changed: told a moment later, once for several changes
  let touching: ReturnType<typeof setTimeout> | undefined
  const touch = () => {
    clearTimeout(touching)
    touching = setTimeout(() => root.touch(), 150)
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
        // anything else outside the projects is the overview's: /, its page, its files and live channel
        if (!s) return root.handle(req, res)
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
      clearTimeout(touching)
      root.close()
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
