// The terminal's host: a small process of its own that runs the sessions, so they outlive the page
// server. The server starts it (detached, like the server itself) the first time a session starts,
// and talks to it over a Unix socket; a restarted server connects again and finds the sessions as
// they were.
//
//   node terminal/host.ts <project dir> <socket path>
//
// Each session is a program in a pseudo-terminal (node-pty), followed by a headless terminal that
// keeps its screen; the drawer shows them as tabs. A session has an id ('1', '2', …). One JSON
// object per line, each way. A connection sends one request:
//
//   { t: 'list' }                          → { sessions: [{ id, label, running, exited, started }] }
//   { t: 'start', id?, command, args, label?, restart }
//                                          → { session, already? }: in the session `id` (a new one
//                                            without), unless it runs and restart is false (`already`)
//   { t: 'input', id, d }                  → { ok }
//   { t: 'resize', id, viewer, cols, rows, active? }
//                                          → { ok }: the size that fits drawer `viewer`; `active`:
//                                            the reader is using that drawer now. A session takes
//                                            the size of its active viewer (see sizes.ts)
//   { t: 'html', id? }                     → { html }: a screen as HTML rows (the first session's
//                                            without an id), for a page's first render
//   { t: 'close', id }                     → { ok }: end the session and drop its tab
//   { t: 'open', id, path }                → { shown }: show the page at `path` in the browser tab
//                                            whose drawer the reader used last for the session
//                                            (a `navigate` to its attach); how many were told
//   { t: 'stop' }                          → { ok }, and the host exits
//   { t: 'attach', id, viewer }            → { t: 'sessions', sessions }, then { t: 'none' } or
//                                            { t: 'screen', d, cols, rows, active, exited }, and then
//                                            { t: 'data', d }, { t: 'exit', code },
//                                            { t: 'size', cols, rows, active }, { t: 'navigate', path } and
//                                            { t: 'sessions', sessions } for as long as it stays open
//
// A session has one size for every drawer showing it: whose, is sizes.ts. Every drawer is told of
// each change (`size`), and shows the session at that size.
//
// It exits on `stop`, and after ten minutes without a program running.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'
import type { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { SerializeAddon as Serializer } from '@xterm/addon-serialize'
import { followMouseEncoding } from './modes.ts'
import { handOver, leave, report, type Sizes } from './sizes.ts'

const require = createRequire(import.meta.url)
const [dir, socket] = process.argv.slice(2)
if (!dir || !socket) { console.error('usage: host <project dir> <socket path>'); process.exit(2) }

/** node-pty. Its prebuilt helper ships without execute permission (1.1.0): add it. */
function loadPty(): typeof import('node-pty') {
  const pty = require('node-pty')
  const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try { if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755) } catch {}
  return pty
}

const { Terminal } = (await import('@xterm/headless')).default
const { SerializeAddon } = (await import('@xterm/addon-serialize')).default

/** A program in a pseudo-terminal, and the headless terminal that keeps its screen. */
interface Session extends Sizes {
  id: string
  label: string
  proc: IPty
  screen: HeadlessTerminal
  serializer: Serializer
  /** what the serializer leaves out: the mouse encoding the program asked for (see modes.ts) */
  mouseEncoding: () => string
  cols: number
  rows: number
  /** the connections following it */
  attached: Set<Conn>
  exited: number | null
  started: string
}

/** A connection; `queue` holds what arrives while it still waits for its screen. */
interface Conn {
  socket: net.Socket
  queue: unknown[] | null
  /** the drawer it follows a session for (attach) */
  viewer?: string
}

/** the sessions by id, in the order they were made */
const sessions = new Map<string, Session>()
let nextId = 1
// connections following some session: each hears when the list of sessions changes
const watchers = new Set<Conn>()

// a host with no program running leaves after a while (also one whose first start failed)
let idle: ReturnType<typeof setTimeout> | undefined
function checkIdle() {
  clearTimeout(idle)
  if (![...sessions.values()].some(s => s.exited == null)) idle = setTimeout(() => quit('no program ran for ten minutes'), 10 * 60 * 1000)
}

const list = () => [...sessions.values()].map(s => ({ id: s.id, label: s.label, running: s.exited == null, exited: s.exited, started: s.started }))
function announce() { for (const c of watchers) send(c, { t: 'sessions', sessions: list() }) }

function start(id: string, command: string, args: string[], label: string): Session {
  const pty = loadPty()
  const before = sessions.get(id)
  const cols = before?.cols ?? 100, rows = before?.rows ?? 30
  const attached = before?.attached ?? new Set<Conn>()
  const viewers = before?.viewers ?? new Map()
  const active = before?.active ?? null
  if (before) endProcess(before)
  const screen = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  const mouseEncoding = followMouseEncoding(screen)
  const proc = pty.spawn(command, args, {
    name: 'xterm-256color', cols, rows, cwd: dir,
    // WHITEBOARD_TERMINAL: which tab a program runs in, so it can show a page where its drawer is (`open`)
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WHITEBOARD_TERMINAL: id },
  })
  const s: Session = { id, label, proc, screen, serializer, mouseEncoding, cols, rows, attached, viewers, active, exited: null, started: new Date().toISOString() }
  proc.onData(d => {
    screen.write(d)
    for (const c of s.attached) send(c, { t: 'data', d })
  })
  proc.onExit(({ exitCode, signal }) => {
    s.exited = exitCode
    log(`tab ${id} (${label}) ended: ${signal ? `signal ${signal}` : `exit code ${exitCode}`}`)
    for (const c of s.attached) send(c, { t: 'exit', code: exitCode })
    announce()
    checkIdle()
  })
  sessions.set(id, s)
  // a restarted session's followers get its new screen
  for (const c of attached) sendScreen(c, s)
  clearTimeout(idle)
  announce()
  return s
}

function endProcess(s: Session) {
  try { if (s.exited == null) s.proc.kill() } catch {}
  s.screen.dispose()
}

function close(id: string) {
  const s = sessions.get(id)
  if (!s) return
  endProcess(s)
  sessions.delete(id)
  for (const c of s.attached) send(c, { t: 'none' })
  announce()
  checkIdle()
}

/** A line in the host's log (.whiteboard/terminal/host.log), with the time: what happened to it and its tabs. */
function log(line: string) {
  console.log(`${new Date().toISOString()} terminal host ${process.pid}: ${line}`)
}

/** Leave, saying why: the log is where to look when the tabs are gone. */
function quit(reason: string) {
  const running = [...sessions.values()].filter(s => s.exited == null).length
  log(`leaves: ${reason}${running ? `, ending ${running} running tab${running > 1 ? 's' : ''}` : ''}`)
  for (const id of [...sessions.keys()]) close(id)
  try { fs.unlinkSync(socket) } catch {}
  process.exit(0)
}

// ---- sizes (see sizes.ts) ----------------------------------------------------------------------

/** Give a session a size, and tell the drawers showing it. */
function resize(s: Session, cols: number, rows: number) {
  if (cols !== s.cols || rows !== s.rows) {
    s.cols = cols; s.rows = rows
    s.screen.resize(cols, rows)
    if (s.exited == null) s.proc.resize(cols, rows)
  }
  sendSize(s)
}

function sendSize(s: Session) {
  for (const c of s.attached) send(c, { t: 'size', cols: s.cols, rows: s.rows, active: s.active })
}

/** A drawer stopped showing a session. If it was the active one, pass the session on, after a moment. */
function leaveSession(s: Session, viewer: string) {
  // the same drawer may still show it through another connection
  if ([...s.attached].some(c => c.viewer === viewer)) return
  if (!leave(s, viewer)) return
  setTimeout(() => {
    if (sessions.get(s.id) !== s) return
    const size = handOver(s, viewer)
    if (size) resize(s, size.cols, size.rows)
  }, 1500)
}

/** Write a message to a connection; one that is still waiting for its screen queues it. */
function send(conn: Conn, msg: unknown) {
  if (conn.queue) return void conn.queue.push(msg)
  conn.socket.write(JSON.stringify(msg) + '\n')
}

/** The screen once the headless terminal has parsed everything written so far; what arrives meanwhile follows it. */
function sendScreen(conn: Conn, s: Session) {
  conn.queue = []
  s.screen.write('', () => {
    conn.socket.write(JSON.stringify({ t: 'screen', d: s.serializer.serialize() + s.mouseEncoding(), cols: s.cols, rows: s.rows, active: s.active, exited: s.exited }) + '\n')
    const queued = conn.queue ?? []
    conn.queue = null
    for (const msg of queued) send(conn, msg)
  })
}

function html(s: Session | undefined): string {
  if (!s) return ''
  try {
    // the rows, without the wrapper that sets the serializer's own colors and font; text is escaped
    const m = /<pre><div style='[^']*'>([\s\S]*)<\/div><\/pre>/.exec(s.serializer.serializeAsHTML())
    return m ? m[1] : ''
  } catch { return '' }
}

function handle(conn: Conn, req: Record<string, any>) {
  const reply = (msg: unknown) => { conn.socket.end(JSON.stringify(msg) + '\n') }
  const s = req.id != null ? sessions.get(String(req.id)) : undefined
  switch (req.t) {
    case 'list': return reply({ sessions: list() })
    case 'start': {
      if (typeof req.command !== 'string' || !req.command) return reply({ error: 'start needs a command' })
      const id = req.id != null ? String(req.id) : String(nextId)
      const running = sessions.get(id)
      if (running && running.exited == null && !req.restart) return reply({ session: id, already: true })
      const label = String(req.label ?? path.basename(req.command))
      try { start(id, req.command, Array.isArray(req.args) ? req.args.map(String) : [], label) } catch (e) { return reply({ error: (e as Error).message }) }
      log(`tab ${id} (${label}) ${running ? 'restarted' : 'started'}`)
      // ids are never reused while the host runs, so a closed tab's id can't come back as another
      if (Number(id) >= nextId) nextId = Number(id) + 1
      return reply({ session: id })
    }
    case 'input':
      if (s && s.exited == null && typeof req.d === 'string') s.proc.write(req.d)
      return reply({ ok: true })
    case 'resize': {
      const { cols, rows } = req
      const viewer = String(req.viewer ?? '')
      if (s && viewer && Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1 && cols < 1000 && rows < 500) {
        const size = report(s, viewer, cols, rows, !!req.active)
        resize(s, size.cols, size.rows)
      }
      return reply({ ok: true })
    }
    case 'html': return reply({ html: html(s ?? sessions.values().next().value) })
    case 'close': close(String(req.id)); return reply({ ok: true })
    case 'open': {
      // show a page in the browser tab whose drawer the reader used last for this session; with
      // none of them active, in every one that shows it
      if (!s || typeof req.path !== 'string') return reply({ shown: 0 })
      const mine = [...s.attached].filter(c => c.viewer && c.viewer === s.active)
      const to = mine.length ? mine : [...s.attached]
      // not `open`: a browser's EventSource has an event of that name already
      for (const c of to) send(c, { t: 'navigate', path: req.path })
      return reply({ shown: to.length })
    }
    case 'stop': reply({ ok: true }); return void setTimeout(() => quit('asked to stop (whiteboard terminal stop)'), 50)
    case 'attach': {
      watchers.add(conn)
      if (req.viewer) conn.viewer = String(req.viewer)
      conn.socket.on('close', () => {
        watchers.delete(conn)
        for (const x of sessions.values()) if (x.attached.delete(conn) && conn.viewer) leaveSession(x, conn.viewer)
      })
      send(conn, { t: 'sessions', sessions: list() })
      if (!s) return send(conn, { t: 'none' })
      s.attached.add(conn)
      sendScreen(conn, s)
      return
    }
    default: return reply({ error: `unknown request ${req.t}` })
  }
}

const server = net.createServer(socketConn => {
  const conn: Conn = { socket: socketConn, queue: null }
  let buf = ''
  socketConn.setEncoding('utf8')
  socketConn.on('error', () => {})
  socketConn.on('data', chunk => {
    buf += chunk
    const nl = buf.indexOf('\n')
    if (nl < 0) return
    const line = buf.slice(0, nl)
    buf = ''
    socketConn.removeAllListeners('data')
    let req
    try { req = JSON.parse(line) } catch { return socketConn.end(JSON.stringify({ error: 'not JSON' }) + '\n') }
    handle(conn, req)
  })
})

// a socket left by a host that is gone: remove it; one whose host still answers: leave, it's running
try {
  await new Promise<void>((resolve, reject) => {
    const probe = net.connect(socket)
    probe.on('connect', () => { probe.destroy(); reject(new Error('running')) })
    probe.on('error', () => resolve())
  })
  try { fs.unlinkSync(socket) } catch {}
} catch { console.error('terminal host: another host answers on', socket); process.exit(0) }

server.listen(socket, () => {
  // only its owner may talk to it: the socket runs code
  try { fs.chmodSync(socket, 0o600) } catch {}
  log(`listening on ${socket}`)
  checkIdle()
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => quit(`got ${signal} from outside`))
