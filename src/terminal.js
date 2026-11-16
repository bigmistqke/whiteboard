// The terminal drawer's server side: routes for the page, forwarded to the terminal's host.
//
//   /_/terminal/auth?token=…   sets the cookie that unlocks the terminal in this browser, then goes to `to`
//   /api/term/status           whether a session runs, and its command
//   /api/term/stream           server-sent events: `screen` (the whole screen, first), then `data`, `exit`
//   /api/term/input            POST { data }: keystrokes
//   /api/term/resize           POST { cols, rows }
//   /api/term/start            POST { args, restart }: start `claude` with these arguments
//
// The session itself runs in a process of its own (term-host.js), which this starts the first time a
// session starts and reaches over a Unix socket. So the session outlives this server: a restarted
// server connects to the same host and finds the session as it was. Each open drawer gets its own
// connection to the host, which sends it the whole screen first and then follows the output.
//
// Starting or driving a process runs code, so all of it needs the project's token: from a cookie set
// by the auth link (`whiteboard terminal` prints it), or from the CLI's header. The cookie is
// SameSite=Strict and requests from another origin are refused, so a website open in the same
// browser can't use it. The host's socket is readable by its owner only.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const COOKIE = 'wb-terminal'
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'term-host.js')

const hasPty = () => { try { require.resolve('node-pty'); return true } catch { return false } }

/** The project's token, made on first use; `.whiteboard/token`, readable by its owner only. */
export function projectToken(wb) {
  const file = path.join(wb, 'token')
  try { return fs.readFileSync(file, 'utf8').trim() } catch {}
  const token = crypto.randomBytes(24).toString('base64url')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}

/**
 * Where the host listens: `.whiteboard/term.sock`, or, when that path is too long for a Unix
 * socket (about 100 bytes), a name in /tmp made from it.
 */
export function hostSocket(wb) {
  const own = path.join(wb, 'term.sock')
  return Buffer.byteLength(own) < 100 ? own : path.join('/tmp', `wb-term-${crypto.createHash('sha1').update(wb).digest('hex').slice(0, 12)}.sock`)
}

export function createTerminal({ dir, wb }) {
  const token = projectToken(wb)
  const socket = hostSocket(wb)

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

  // ---- the host -------------------------------------------------------------------------------

  /** A connection to the host, or null when none runs. */
  function connect() {
    return new Promise(resolve => {
      const conn = net.connect(socket)
      conn.once('connect', () => resolve(conn))
      conn.once('error', () => resolve(null))
    })
  }

  /** Send one request; its one reply, or null when no host runs. */
  async function ask(req, timeout = 2000) {
    const conn = await connect()
    if (!conn) return null
    return new Promise(resolve => {
      let buf = ''
      const done = value => { clearTimeout(timer); conn.destroy(); resolve(value) }
      const timer = setTimeout(() => done(null), timeout)
      conn.setEncoding('utf8')
      conn.on('data', c => { buf += c; const nl = buf.indexOf('\n'); if (nl >= 0) { try { done(JSON.parse(buf.slice(0, nl))) } catch { done(null) } } })
      conn.on('error', () => done(null))
      conn.on('end', () => done(null))
      conn.write(JSON.stringify(req) + '\n')
    })
  }

  /** Start the host (detached: it outlives this server) and wait until it answers. */
  async function startHost() {
    const log = fs.openSync(path.join(wb, 'term.log'), 'a')
    const child = spawn(process.execPath, [HOST, dir, socket], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: process.env })
    child.unref()
    fs.closeSync(log)
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (await ask({ t: 'status' }, 500)) return true
    }
    return false
  }

  const status = async () => ({
    available: hasPty(),
    ...((await ask({ t: 'status' })) ?? { running: false, exited: null, command: null, started: null }),
  })

  /** The screen as HTML rows, for a page's first render; empty without a session. */
  async function screenHtml() {
    return (await ask({ t: 'html' }, 300))?.html ?? ''
  }

  // ---- routes ---------------------------------------------------------------------------------

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

    if (p === '/api/term/status') { json(res, 200, await status()); return true }
    if (p === '/api/term/start' && req.method === 'POST') {
      const body = await readJson(req)
      if (!hasPty()) { json(res, 500, { error: 'the terminal needs node-pty: npm install node-pty' }); return true }
      const request = { t: 'start', args: Array.isArray(body.args) ? body.args.map(String) : [], restart: !!body.restart }
      let reply = await ask(request)
      if (!reply) {
        if (!(await startHost())) { json(res, 500, { error: `the terminal's host did not start; see ${path.join(wb, 'term.log')}` }); return true }
        reply = await ask(request)
      }
      if (!reply || reply.error) { json(res, 500, { error: reply?.error ?? 'no answer from the terminal host' }); return true }
      json(res, 200, { available: true, ...reply })
      return true
    }
    if (p === '/api/term/input' && req.method === 'POST') {
      const { data } = await readJson(req)
      if (typeof data === 'string') await ask({ t: 'input', d: data })
      json(res, 200, { ok: true })
      return true
    }
    if (p === '/api/term/resize' && req.method === 'POST') {
      const { cols, rows } = await readJson(req)
      await ask({ t: 'resize', cols, rows })
      json(res, 200, { ok: true })
      return true
    }
    if (p === '/api/term/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': terminal\n\n')
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      const conn = await connect()
      if (!conn) {
        res.write('event: none\ndata: {}\n\n')
        req.on('close', () => clearInterval(ping))
        return true
      }
      // the host's messages, one per line, as server-sent events of the same name
      let buf = ''
      conn.setEncoding('utf8')
      conn.on('data', chunk => {
        buf += chunk
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          try {
            const { t, ...data } = JSON.parse(line)
            res.write(`event: ${t}\ndata: ${JSON.stringify(data)}\n\n`)
          } catch { /* not a message */ }
        }
      })
      // the host went away (stopped, or its program ended and it left): the page shows it as stopped
      conn.on('close', () => { if (!res.writableEnded) res.write('event: exit\ndata: {"code":null}\n\n') })
      conn.on('error', () => {})
      req.on('close', () => { clearInterval(ping); conn.destroy() })
      conn.write(JSON.stringify({ t: 'attach' }) + '\n')
      return true
    }
    json(res, 404, { error: 'unknown terminal request' })
    return true
  }

  return { handle, authorized, status, token, screenHtml }
}
