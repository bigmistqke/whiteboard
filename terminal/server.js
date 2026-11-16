// What the terminal's routes do, forwarded to its host: the sessions (the drawer's tabs), starting
// one, its keystrokes and size, following its output, closing it, stopping them all.
//
// The sessions run in a process of their own (host.js), which this starts the first time a session
// starts and reaches over a Unix socket. So they outlive the page server: a restarted server
// connects to the same host and finds them as they were. Each open drawer gets its own connection to
// the host, which sends it the whole screen of its tab first and then follows the output.
//
// A session runs in the user's shell: the configured command first, and when it exits, the shell
// takes over in the same tab (`$SHELL -c '"$@"; exec "$0" -l' $SHELL <command>`), so leaving the
// program leaves a prompt, not a dead tab. A new tab can also start the shell alone.
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
 * @param {{ dir: string, home: string, command: string[] }} options
 *   `dir` the folder the session runs in, `home` where the socket and log go, `command` the program
 *   a session starts, with its first arguments
 */
export function createTerminal({ dir, home, command }) {
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

  const shell = process.env.SHELL || '/bin/sh'
  const label = path.basename(command[0])

  /**
   * The sessions, as tabs: `{ id, label, running, exited, started }` each. `legacy`: the host is
   * one from before tabs, running a single session until it leaves; it is shown as one tab.
   */
  async function sessions() {
    const reply = await ask({ t: 'list' })
    if (!reply) return { available: hasPty(), legacy: false, sessions: [] }
    if (!reply.error) return { available: hasPty(), legacy: false, sessions: reply.sessions }
    const old = await ask({ t: 'status' })
    const one = old && (old.running || old.exited != null) ? [{ id: '1', label: path.basename(String(old.command ?? label).split(' ')[0]), running: old.running, exited: old.exited, started: old.started }] : []
    return { available: hasPty(), legacy: true, sessions: one }
  }

  /** The screens as HTML rows by session id, for a page's first render. */
  async function screens(list) {
    const out = {}
    await Promise.all(list.map(async s => { out[s.id] = (await ask({ t: 'html', id: s.id }, 300))?.html ?? '' }))
    return out
  }

  // ---- what the routes do --------------------------------------------------------------------

  const failure = (message, status = 500) => Object.assign(new Error(message), { status })

  /**
   * Start the command, with `args` after its own, in the session `id` (a new tab without one), or
   * report the running session (`already`) unless `restart`. With `shell`, the shell alone.
   */
  async function start({ id, args = [], restart = false, shell: plain = false } = {}) {
    if (!hasPty()) throw failure('the terminal needs node-pty: npm install node-pty')
    const program = [...command, ...args]
    const isShell = plain || path.basename(program[0]) === path.basename(shell)
    const request = isShell
      ? { t: 'start', id, command: shell, args: ['-l'], label: path.basename(shell), restart }
      : { t: 'start', id, command: shell, args: ['-c', '"$@"; exec "$0" -l', shell, ...program], label, restart }
    const state = await sessions()
    if (state.legacy) {
      // an old host runs one session: it can only be started again as it was
      if (id == null || plain) throw failure('tabs come once the current session has ended (its host is from before tabs)', 409)
      Object.assign(request, { command: command[0], args: program.slice(1) })
    }
    let reply = await ask(request)
    if (!reply) {
      if (!(await startHost())) throw failure(`the terminal's host did not start; see ${log}`)
      reply = await ask(request)
    }
    if (!reply || reply.error) throw failure(reply?.error ?? 'no answer from the terminal host')
    return { available: true, session: reply.session ?? '1', already: !!reply.already }
  }

  const input = async (id, data) => { await ask({ t: 'input', id, d: data }) }
  const resize = async (id, cols, rows) => { await ask({ t: 'resize', id, cols, rows }) }

  /** End one session and drop its tab. */
  async function close(id) {
    const reply = await ask({ t: 'close', id })
    if (reply?.error) throw failure('this host is from before tabs: stop it to end its session', 409)
    return { ok: true }
  }

  /**
   * Follow a session as server-sent events on `res`: `sessions` (the tabs) and `screen` first, then
   * `data`, `exit` and `sessions` as they come.
   */
  async function stream(req, res, id) {
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
    conn.write(JSON.stringify({ t: 'attach', id }) + '\n')
  }

  /** End the session and its host. */
  async function stop() {
    return { stopped: !!(await ask({ t: 'stop' })) }
  }

  return { sessions, screens, start, input, resize, close, stream, stop, label }
}
