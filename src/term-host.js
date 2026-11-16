// The terminal's host: a small process of its own that runs the session, so the session outlives the
// page server. The server starts it (detached, like the server itself) the first time a session
// starts, and talks to it over a Unix socket; a restarted server connects again and finds the session
// as it was.
//
//   node src/term-host.js <project dir> <socket path>
//
// It runs one program in a pseudo-terminal (node-pty) and follows its output in a headless terminal,
// which keeps the screen. One JSON object per line, each way. A connection sends one request:
//
//   { t: 'status' }                   → { running, exited, command, started }
//   { t: 'start', args, restart }     → status, with `already` when a session runs and restart is false
//   { t: 'input', d }                 → { ok }
//   { t: 'resize', cols, rows }       → { ok }
//   { t: 'html' }                     → { html }: the screen as HTML rows, for a page's first render
//   { t: 'stop' }                     → { ok }, and the host exits
//   { t: 'attach' }                   → { t: 'none' }, or { t: 'screen', d, cols, rows, exited } and then
//                                       { t: 'data', d } and { t: 'exit', code } for as long as it stays open
//
// It exits on `stop`, and after ten minutes without a program running.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const [dir, socket] = process.argv.slice(2)
if (!dir || !socket) { console.error('usage: term-host.js <project dir> <socket path>'); process.exit(2) }

/** node-pty. Its prebuilt helper ships without execute permission (1.1.0): add it. */
function loadPty() {
  const pty = require('node-pty')
  const helper = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  try { if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755) } catch {}
  return pty
}

const { Terminal } = (await import('@xterm/headless')).default
const { SerializeAddon } = (await import('@xterm/addon-serialize')).default

let session = null
// a host with no program running leaves after a while (also one whose first start failed)
let idle = setTimeout(() => quit(), 10 * 60 * 1000)

function start(args) {
  const pty = loadPty()
  const cols = session?.cols ?? 100, rows = session?.rows ?? 30
  stopSession()
  clearTimeout(idle)
  const screen = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  const proc = pty.spawn('claude', args, {
    name: 'xterm-256color', cols, rows, cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })
  const s = { proc, screen, serializer, args, cols, rows, attached: new Set(), exited: null, started: new Date().toISOString() }
  proc.onData(d => {
    screen.write(d)
    for (const c of s.attached) send(c, { t: 'data', d })
  })
  proc.onExit(({ exitCode }) => {
    s.exited = exitCode
    for (const c of s.attached) send(c, { t: 'exit', code: exitCode })
    if (session === s) idle = setTimeout(() => quit(), 10 * 60 * 1000)
  })
  session = s
}

function stopSession() {
  if (!session) return
  try { if (session.exited == null) session.proc.kill() } catch {}
  for (const c of session.attached) send(c, { t: 'exit', code: null })
  session.screen.dispose()
  session = null
}

function quit() {
  stopSession()
  try { fs.unlinkSync(socket) } catch {}
  process.exit(0)
}

const status = () => ({
  running: !!session && session.exited == null,
  exited: session?.exited ?? null,
  command: session ? ['claude', ...session.args].join(' ') : null,
  started: session?.started ?? null,
})

/** Write a message to a connection; one that is still waiting for its screen queues it. */
function send(conn, msg) {
  if (conn.queue) return void conn.queue.push(msg)
  conn.socket.write(JSON.stringify(msg) + '\n')
}

function html() {
  if (!session) return ''
  try {
    // the rows, without the wrapper that sets the serializer's own colors and font; text is escaped
    const m = /<pre><div style='[^']*'>([\s\S]*)<\/div><\/pre>/.exec(session.serializer.serializeAsHTML())
    return m ? m[1] : ''
  } catch { return '' }
}

function handle(conn, req) {
  const reply = msg => { conn.socket.end(JSON.stringify(msg) + '\n') }
  switch (req.t) {
    case 'status': return reply(status())
    case 'start':
      if (session && session.exited == null && !req.restart) return reply({ ...status(), already: true })
      try { start(Array.isArray(req.args) ? req.args.map(String) : []) } catch (e) { return reply({ error: e.message }) }
      return reply(status())
    case 'input':
      if (session && session.exited == null && typeof req.d === 'string') session.proc.write(req.d)
      return reply({ ok: true })
    case 'resize': {
      const { cols, rows } = req
      if (session && Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1 && cols < 1000 && rows < 500) {
        session.cols = cols; session.rows = rows
        session.screen.resize(cols, rows)
        if (session.exited == null) session.proc.resize(cols, rows)
      }
      return reply({ ok: true })
    }
    case 'html': return reply({ html: html() })
    case 'stop': reply({ ok: true }); return void setTimeout(quit, 50)
    case 'attach': {
      const s = session
      if (!s) return reply({ t: 'none' })
      // the screen once the headless terminal has parsed everything written so far; what arrives
      // meanwhile is queued for this connection and follows the screen
      conn.queue = []
      s.attached.add(conn)
      conn.socket.on('close', () => s.attached.delete(conn))
      s.screen.write('', () => {
        conn.socket.write(JSON.stringify({ t: 'screen', d: s.serializer.serialize(), cols: s.cols, rows: s.rows, exited: s.exited }) + '\n')
        const queued = conn.queue
        conn.queue = null
        for (const msg of queued) send(conn, msg)
      })
      return
    }
    default: return reply({ error: `unknown request ${req.t}` })
  }
}

const server = net.createServer(socketConn => {
  const conn = { socket: socketConn, queue: null }
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
  await new Promise((resolve, reject) => {
    const probe = net.connect(socket)
    probe.on('connect', () => { probe.destroy(); reject(new Error('running')) })
    probe.on('error', () => resolve())
  })
  try { fs.unlinkSync(socket) } catch {}
} catch { console.error('term-host: another host answers on', socket); process.exit(0) }

server.listen(socket, () => {
  // only its owner may talk to it: the socket runs code
  try { fs.chmodSync(socket, 0o600) } catch {}
  console.log(`term-host: ${process.pid} on ${socket}`)
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, quit)
