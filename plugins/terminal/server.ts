// What the terminal's routes do, forwarded to its host: the sessions (the drawer's tabs), starting
// one, its keystrokes and size, following its output, closing it, stopping them all.
//
// The sessions run in a process of their own (host.js), which this starts the first time a session
// starts and reaches over a Unix socket. So they outlive the page server: a restarted server
// connects to the same host and finds them as they were. Each open drawer gets its own connection to
// the host, which sends it the whole screen of its tab first and then follows the output.
//
// A session is the user's shell. A tab started with a program runs it in the shell, and when it
// exits the shell takes over in the same tab (`$SHELL -c '"$@"; exec "$0" -l' $SHELL <program>`),
// so leaving the program leaves a prompt, not a dead tab.
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
import type { IncomingMessage, ServerResponse } from 'node:http'

/** A session, as a tab. */
export interface Session {
  id: string
  label: string
  running: boolean
  exited: number | null
  started: string
}

/** The tabs, and whether the terminal can run (node-pty is installed). */
export interface Sessions {
  available: boolean
  sessions: Session[]
}

export interface StartOptions {
  /** the session to start in; a new tab without one */
  id?: string
  /** a program to run in the shell, with its arguments; the shell alone without one */
  program?: string[]
  /** start again in `id`, running what it ran before, even when it still runs */
  restart?: boolean
}

/** A reply from the host: one JSON object, its fields by request (see host.ts). */
type Reply = Record<string, any>

const require = createRequire(import.meta.url)
const HOST = fileURLToPath(new URL(`./host${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url))

const hasPty = () => {
  try {
    require.resolve('node-pty')
    return true
  } catch {
    return false
  }
}

/**
 * Where the host listens: `host.sock` in the terminal's folder, or, when that path is too long for
 * a Unix socket (about 100 bytes), a name in /tmp made from it.
 */
export function hostSocket(home: string): string {
  const own = path.join(home, 'host.sock')
  return Buffer.byteLength(own) < 100
    ? own
    : path.join('/tmp', `wb-term-${crypto.createHash('sha1').update(home).digest('hex').slice(0, 12)}.sock`)
}

/** `dir` the folder the sessions run in, `home` where the socket and log go */
export function createTerminal({ dir, home }: { dir: string; home: string }) {
  const own = hostSocket(home)
  const log = path.join(home, 'host.log')

  // ---- the host -------------------------------------------------------------------------------

  /** A connection to the host, or null when none runs. */
  function connect(): Promise<net.Socket | null> {
    return new Promise(resolve => {
      const conn = net.connect(own)
      conn.once('connect', () => resolve(conn))
      conn.once('error', () => resolve(null))
    })
  }

  /** Send one request; its one reply, or null when no host runs. */
  async function ask(req: Record<string, unknown>, timeout = 2000): Promise<Reply | null> {
    const conn = await connect()
    if (!conn) return null
    return new Promise(resolve => {
      let buf = ''
      const done = (value: Reply | null) => {
        clearTimeout(timer)
        conn.destroy()
        resolve(value)
      }
      const timer = setTimeout(() => done(null), timeout)
      conn.setEncoding('utf8')
      conn.on('data', (c: string) => {
        buf += c
        const nl = buf.indexOf('\n')
        if (nl >= 0) {
          try {
            done(JSON.parse(buf.slice(0, nl)))
          } catch {
            done(null)
          }
        }
      })
      conn.on('error', () => done(null))
      conn.on('end', () => done(null))
      conn.write(JSON.stringify(req) + '\n')
    })
  }

  /** Start the host (detached: it outlives this server) and wait until it answers. */
  async function startHost(): Promise<boolean> {
    const out = fs.openSync(log, 'a')
    const child = spawn(process.execPath, [HOST, dir, own], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    })
    child.unref()
    fs.closeSync(out)
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (await ask({ t: 'list' }, 500)) return true
    }
    return false
  }

  const shell = process.env.SHELL || '/bin/sh'

  /** The sessions, as tabs: `{ id, label, running, exited, started }` each. */
  async function sessions(): Promise<Sessions> {
    const reply = await ask({ t: 'list' })
    return { available: hasPty(), sessions: reply?.sessions ?? [] }
  }

  /** The screens as HTML rows by session id, for a page's first render. */
  async function screens(list: Session[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    await Promise.all(
      list.map(async s => {
        out[s.id] = (await ask({ t: 'html', id: s.id }, 300))?.html ?? ''
      }),
    )
    return out
  }

  // ---- what the routes do --------------------------------------------------------------------

  const failure = (message: string, status = 500) => Object.assign(new Error(message), { status })

  /**
   * Start a tab: the shell, or `program` in it (a new tab without `id`). In a running session it
   * reports it (`already`) unless `restart`; restarting without a program runs what it ran before.
   */
  async function start({ id, program = [], restart = false }: StartOptions = {}) {
    if (!hasPty()) throw failure('the terminal needs node-pty: npm install node-pty')
    const request = program.length
      ? {
          t: 'start',
          id,
          command: shell,
          args: ['-c', '"$@"; exec "$0" -l', shell, ...program],
          label: path.basename(program[0]!),
          restart,
        }
      : restart && id != null
        ? { t: 'start', id, restart }
        : { t: 'start', id, command: shell, args: ['-l'], label: path.basename(shell), restart }
    let reply = await ask(request)
    if (!reply) {
      if (!(await startHost())) throw failure(`the terminal's host did not start; see ${log}`)
      reply = await ask(request)
    }
    if (!reply || reply.error) throw failure(reply?.error ?? 'no answer from the terminal host')
    return { available: true, session: reply.session ?? '1', already: !!reply.already }
  }

  const input = async (id: string, data: string) => {
    await ask({ t: 'input', id, d: data })
  }
  /** The size that fits drawer `viewer`; `active`: the reader is using that drawer now (see host.ts, Sizes). */
  const resize = async (id: string, viewer: string, cols: number, rows: number, active = false) => {
    await ask({ t: 'resize', id, viewer, cols, rows, active })
  }

  /** End one session and drop its tab. */
  async function close(id: string) {
    await ask({ t: 'close', id })
    return { ok: true }
  }

  /**
   * Follow a session as server-sent events on `res`: `sessions` (the tabs) and `screen` first, then
   * `data`, `exit` and `sessions` as they come.
   */
  async function stream(req: IncomingMessage, res: ServerResponse, id: string | undefined, viewer?: string) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': terminal\n\n')
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    const conn = await connect()
    if (!conn) {
      // no host runs yet: say so, and have the browser ask again shortly, so that a tab started
      // meanwhile (from the command line, say) shows up
      clearInterval(ping)
      res.end('retry: 2000\nevent: none\ndata: {}\n\n')
      return
    }
    // the host's messages, one per line, as server-sent events of the same name
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk: string) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          const { t, ...data } = JSON.parse(line)
          res.write(`event: ${t}\ndata: ${JSON.stringify(data)}\n\n`)
        } catch {
          /* not a message */
        }
      }
    })
    // the host went away (stopped, or its program ended and it left): the page shows it as stopped
    conn.on('close', () => {
      if (!res.writableEnded) res.write('event: exit\ndata: {"code":null}\n\n')
    })
    conn.on('error', () => {})
    req.on('close', () => {
      clearInterval(ping)
      conn.destroy()
    })
    conn.write(JSON.stringify({ t: 'attach', id, viewer }) + '\n')
  }

  /** End the session and its host. */
  async function stop() {
    return { stopped: !!(await ask({ t: 'stop' })) }
  }

  /**
   * Show the page at `path` (a path on this server) in the browser tab whose drawer the reader used
   * last: for session `id`, or without one, of all sessions.
   */
  async function open(id: string | undefined, path: string) {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw failure('open takes a path on this server, like /plan', 400)
    const reply = await ask({ t: 'open', id, path })
    if (!reply) throw failure('no terminal host runs', 404)
    return { shown: Number(reply.shown ?? 0) }
  }

  return { sessions, screens, start, input, resize, close, open, stream, stop }
}
