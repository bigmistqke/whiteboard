// What the terminal's routes do, forwarded to its host: the session's status, starting it, its
// keystrokes and size, following its output, stopping it.
//
// The session itself runs in a process of its own (host.js), which this starts the first time a
// session starts and reaches over a Unix socket. So the session outlives the page server: a
// restarted server connects to the same host and finds the session as it was. Each open drawer gets
// its own connection to the host, which sends it the whole screen first and then follows the output.
//
// No whiteboard in it: give it the folder the session runs in and a folder for its socket and log.
// It doesn't check who asks; whoever mounts it must (it runs code).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host.js')

const hasPty = () => { try { require.resolve('node-pty'); return true } catch { return false } }

/**
 * Where the host listens: `host.sock` in the terminal's folder, or, when that path is too long for
 * a Unix socket (about 100 bytes), a name in /tmp made from it.
 */
export function hostSocket(home) {
  const own = path.join(home, 'host.sock')
  return Buffer.byteLength(own) < 100 ? own : path.join('/tmp', `wb-term-${crypto.createHash('sha1').update(home).digest('hex').slice(0, 12)}.sock`)
}

/**
 * @param {{ dir: string, home: string }} options
 *   `dir` the folder the session runs in, `home` where the socket and log go
 */
export function createTerminal({ dir, home }) {
  const own = hostSocket(home)
  // a host started before the terminal had a folder of its own listens on .whiteboard/term.sock;
  // it is used until it leaves, so that its session isn't lost
  const legacy = path.join(path.dirname(home), 'term.sock')
  const socketPath = () => (fs.existsSync(legacy) ? legacy : own)
  const log = path.join(home, 'host.log')

  // ---- the host -------------------------------------------------------------------------------

  /** A connection to the host, or null when none runs. */
  function connect() {
    return new Promise(resolve => {
      const conn = net.connect(socketPath())
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
    const out = fs.openSync(log, 'a')
    const child = spawn(process.execPath, [HOST, dir, own], { cwd: dir, detached: true, stdio: ['ignore', out, out], env: process.env })
    child.unref()
    fs.closeSync(out)
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

  // ---- what the routes do --------------------------------------------------------------------

  const failure = (message, status = 500) => Object.assign(new Error(message), { status })

  /** Start `claude` with `args`, or report the running session (`already`) unless `restart`. */
  async function start({ args = [], restart = false } = {}) {
    if (!hasPty()) throw failure('the terminal needs node-pty: npm install node-pty')
    const request = { t: 'start', args, restart }
    let reply = await ask(request)
    if (!reply) {
      if (!(await startHost())) throw failure(`the terminal's host did not start; see ${log}`)
      reply = await ask(request)
    }
    if (!reply || reply.error) throw failure(reply?.error ?? 'no answer from the terminal host')
    return { available: true, ...reply }
  }

  const input = async data => { await ask({ t: 'input', d: data }) }
  const resize = async (cols, rows) => { await ask({ t: 'resize', cols, rows }) }

  /** Follow the session as server-sent events on `res`: `screen` first, then `data` and `exit`. */
  async function stream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': terminal\n\n')
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    const conn = await connect()
    if (!conn) {
      res.write('event: none\ndata: {}\n\n')
      req.on('close', () => clearInterval(ping))
      return
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
  }

  /** End the session and its host. */
  async function stop() {
    return { stopped: !!(await ask({ t: 'stop' })) }
  }

  return { status, start, input, resize, stream, stop, screenHtml }
}
