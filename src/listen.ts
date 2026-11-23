// The command's side of listening (`whiteboard wait` and `watch`): holding a listener at a server,
// and the fallback. A wait or watch on a page registers at its project's server first and only then
// reads the log, so from its first answer on the server knows it listens. A fallback (one without
// --page) registers too, and its stream is told who else listens on each project it covers
// (listeners.ts): a project's own server names that project, the shared server each project of the
// entry. The fallback hands out from each project's log what no other listener there would take.
import http from 'node:http'
import type { Listener } from './define.ts'
import type { HandOutOptions } from './events.ts'
import type { Followed, Snapshot } from './listeners.ts'
import { takenByOther } from './status.ts'

export interface ListenOptions {
  /** the server's base URL; null (or a throw) while none runs, tried again */
  at: () => Promise<string | null>
  /** what to ask /api/listen for: page, type, command, and `fallback` or `entry` */
  query: Record<string, string>
  /** a fallback: who listens on each project it covers, at once and on every change */
  onSnapshot?: (snapshot: Snapshot) => void
  /** the server refused it (another fallback holds it): the reason it gave */
  onRefused: (reason: string) => void
}

/**
 * Hold a listener at a server for as long as the process runs, and again after the server restarts.
 * Resolves once the server holds it; with `orNone`, also after a first try that found no server
 * running (a wait reads the log all the same, and registers once one appears).
 */
export function listen({ at, query, onSnapshot, onRefused }: ListenOptions, { orNone = false } = {}): Promise<void> {
  return new Promise(settled => {
    const connect = async () => {
      let base: string | null = null
      try {
        base = await at()
      } catch {
        /* none runs */
      }
      if (!base) {
        if (orNone) settled()
        return setTimeout(connect, 2000).unref()
      }
      let again = false
      const retry = (ms: number) => {
        if (!again) {
          again = true
          setTimeout(connect, ms).unref()
        }
      }
      const req = http.get(`${base}/api/listen?${new URLSearchParams(query)}`, res => {
        res.setEncoding('utf8')
        if (res.statusCode === 409) {
          let body = ''
          res.on('data', (d: string) => (body += d))
          res.on('end', () => {
            let reason = ''
            try {
              reason = JSON.parse(body).error ?? ''
            } catch {}
            onRefused(reason || 'another agent is the fallback already')
          })
          return
        }
        settled()
        let buf = ''
        res.on('data', (chunk: string) => {
          buf += chunk
          // an event ends at a blank line: `event: listeners` and its data
          let end
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, end)
            buf = buf.slice(end + 2)
            const event = /^event: (.*)$/m.exec(block)?.[1]
            const data = /^data: (.*)$/m.exec(block)?.[1]
            if (event === 'listeners' && data && onSnapshot) onSnapshot(JSON.parse(data) as Snapshot)
          }
        })
        res.on('close', () => retry(1000))
      })
      req.on('error', () => retry(2000))
      // the connection alone does not keep the command running
      req.on('socket', socket => socket.unref())
    }
    void connect()
  })
}

/** What the fallback hands a project's hand-out: what it leaves to others, and when to look again. */
export type FallbackHandOut = Required<Pick<HandOutOptions, 'skip' | 'recheck' | 'signal'>>

/**
 * The fallback over the projects a server names: `start` is called once for each project as it
 * appears, to hand out from its log what no other listener there takes (`skip`), looked at again
 * (`recheck`) whenever who listens there changes; a project no longer named is stopped (`signal`).
 * @returns what takes each snapshot the server sends
 */
export function fallback(start: (project: Followed, handOut: FallbackHandOut) => void): (snapshot: Snapshot) => void {
  const followed = new Map<string, { listeners: Listener[]; stop: AbortController; recheck: () => void }>()
  return ({ projects }) => {
    for (const p of projects) {
      const known = followed.get(p.dir)
      if (known) {
        known.listeners = p.listeners
        known.recheck()
        continue
      }
      const f = { listeners: p.listeners, stop: new AbortController(), recheck: () => {} }
      followed.set(p.dir, f)
      start(p, {
        skip: e => takenByOther(f.listeners, e),
        recheck: again => {
          f.recheck = again
        },
        signal: f.stop.signal,
      })
    }
    for (const [dir, f] of followed)
      if (!projects.some(p => p.dir === dir)) {
        f.stop.abort()
        followed.delete(dir)
      }
  }
}
