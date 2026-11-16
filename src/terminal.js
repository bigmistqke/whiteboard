// A terminal session on the server, shown in a drawer at the bottom of every page.
//
//   /_/terminal/auth?token=…   sets the cookie that unlocks the terminal in this browser, then goes to `to`
//   /api/term/status           whether a session runs, and its command
//   /api/term/stream           server-sent events: `screen` (the whole screen, first), then `data`, `exit`
//   /api/term/input            POST { data }: keystrokes
//   /api/term/resize           POST { cols, rows }
//   /api/term/start            POST { args, restart }: start `claude` with these arguments
//
// The process runs in a pseudo-terminal (node-pty, an optional dependency) and lives as long as the
// server, not as long as a tab: a page that loads (a reload, another page, a second tab) connects again
// and first gets the screen as it is, from a headless terminal on the server that follows the output.
//
// Starting or driving a process runs code, so all of it needs the project's token: from a cookie set
// by the auth link (`whiteboard terminal` prints it), or from the CLI's header. The cookie is
// SameSite=Strict and requests from another origin are refused, so a website open in the same
// browser can't use it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const COOKIE = 'wb-terminal'

/** node-pty, or null when it is not installed. Its prebuilt helper ships without execute permission (1.1.0). */
function loadPty() {
  try {
    const pty = require('node-pty')
    const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`)
    const helper = path.join(dir, 'spawn-helper')
    try { if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755) } catch {}
    return pty
  } catch { return null }
}

/** The project's token, made on first use; `.whiteboard/token`, readable by its owner only. */
export function projectToken(wb) {
  const file = path.join(wb, 'token')
  try { return fs.readFileSync(file, 'utf8').trim() } catch {}
  const token = crypto.randomBytes(24).toString('base64url')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}

export function createTerminal({ dir, wb }) {
  const token = projectToken(wb)
  let session = null

  const cookieOf = req => Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=')).filter(([k]) => k))[COOKIE]
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

  /** Has this request the token, from this origin? */
  function authorized(req) {
    if (!same(cookieOf(req), token) && !same(req.headers['x-whiteboard-token'], token)) return false
    const origin = req.headers.origin
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') return false
    return true
  }

  async function start(args = []) {
    const pty = loadPty()
    if (!pty) throw new Error('the terminal needs node-pty: npm install node-pty')
    const { Terminal } = (await import('@xterm/headless')).default
    const { SerializeAddon } = (await import('@xterm/addon-serialize')).default
    const cols = session?.cols ?? 100, rows = session?.rows ?? 30
    stop()
    const screen = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const proc = pty.spawn('claude', args, {
      name: 'xterm-256color', cols, rows, cwd: dir,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    })
    const s = { proc, screen, serializer, args, cols, rows, clients: new Set(), exited: null, started: new Date().toISOString() }
    proc.onData(data => {
      screen.write(data)
      for (const c of s.clients) send(c, 'data', { d: data })
    })
    proc.onExit(({ exitCode }) => {
      s.exited = exitCode
      for (const c of s.clients) send(c, 'exit', { code: exitCode })
    })
    session = s
    return s
  }

  function stop() {
    if (!session) return
    try { if (session.exited == null) session.proc.kill() } catch {}
    for (const c of session.clients) send(c, 'exit', { code: null })
    session.screen.dispose()
    session = null
  }

  /** Write one event to a stream; a stream that is still catching up queues it. */
  function send(client, event, data) {
    if (client.queue) return client.queue.push([event, data])
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /**
   * The screen as HTML, for the page to show before its terminal connects: rows of styled spans,
   * text escaped by the serializer. Empty without a session.
   */
  function screenHtml() {
    if (!session) return ''
    try {
      const page = session.serializer.serializeAsHTML()
      // the rows, without the wrapper that sets the serializer's own colors and font
      const m = /<pre><div style='[^']*'>([\s\S]*)<\/div><\/pre>/.exec(page)
      return m ? m[1] : ''
    } catch { return '' }
  }

  const status = () => ({
    available: !!loadPty(),
    running: !!session && session.exited == null,
    exited: session?.exited ?? null,
    command: session ? ['claude', ...session.args].join(' ') : null,
    started: session?.started ?? null,
  })

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy() })
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) } })
      req.on('error', reject)
    })
  }

  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }

  /** Handle a terminal request; false when `p` is not one. */
  async function handle(req, res, p, q) {
    if (p === '/_/terminal/auth') {
      if (!same(q.token, token)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('wrong token'); return true }
      const to = typeof q.to === 'string' && q.to.startsWith('/') && !q.to.startsWith('//') ? q.to : '/'
      res.writeHead(302, {
        'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        location: to + (q.open ? (to.includes('?') ? '&' : '?') + 'terminal=open' : ''),
      })
      res.end()
      return true
    }
    if (!p.startsWith('/api/term/')) return false
    if (!authorized(req)) { json(res, 403, { error: 'no terminal token: open the link `whiteboard terminal` prints' }); return true }

    if (p === '/api/term/status') { json(res, 200, status()); return true }
    if (p === '/api/term/start' && req.method === 'POST') {
      const body = await readJson(req)
      if (session && session.exited == null && !body.restart) { json(res, 200, { ...status(), already: true }); return true }
      try { await start(Array.isArray(body.args) ? body.args.map(String) : []) } catch (e) { json(res, 500, { error: e.message }); return true }
      json(res, 200, status())
      return true
    }
    if (p === '/api/term/input' && req.method === 'POST') {
      const { data } = await readJson(req)
      if (session && session.exited == null && typeof data === 'string') session.proc.write(data)
      json(res, 200, { ok: true })
      return true
    }
    if (p === '/api/term/resize' && req.method === 'POST') {
      const { cols, rows } = await readJson(req)
      if (session && Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1 && cols < 1000 && rows < 500) {
        session.cols = cols; session.rows = rows
        session.screen.resize(cols, rows)
        if (session.exited == null) session.proc.resize(cols, rows)
      }
      json(res, 200, { ok: true })
      return true
    }
    if (p === '/api/term/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': terminal\n\n')
      const s = session
      if (!s) { res.write(`event: none\ndata: {}\n\n`) }
      else {
        // the screen as it is once the headless terminal has parsed everything written so far; what
        // arrives meanwhile is queued for this client and follows the screen
        const client = { res, queue: [] }
        s.clients.add(client)
        s.screen.write('', () => {
          res.write(`event: screen\ndata: ${JSON.stringify({ d: s.serializer.serialize(), cols: s.cols, rows: s.rows, exited: s.exited })}\n\n`)
          const queued = client.queue
          client.queue = null
          for (const [event, data] of queued) send(client, event, data)
        })
        req.on('close', () => s.clients.delete(client))
      }
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => clearInterval(ping))
      return true
    }
    json(res, 404, { error: 'unknown terminal request' })
    return true
  }

  return { handle, authorized, status, stop, token, screenHtml }
}
