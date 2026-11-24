// Who listens, as a server holds it. An agent waiting for answers (`whiteboard wait` or `watch`)
// holds a connection to /api/listen for as long as it runs: that connection is the listener, gone
// when the command is. A project's server keeps its listeners in a registry; the shared server adds
// an entry's fallback to the registry of each project of the entry. The fallback (a wait or watch
// without --page) takes only what no other listener would, so its stream is told who else listens
// (`listeners`, a Snapshot), at once and on every change.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Listener } from './define.ts'
import { covers } from './status.ts'

/**
 * The listeners of one project, and the rules that one fallback holds it at a time, and one wait or
 * watch a page: a second on the same page would take answers from under the first.
 */
export interface Registry {
  /** the listeners, those covering `page` when given; each a copy */
  list(page?: string | null): Listener[]
  /**
   * hold `l` until the returned function is called; null when refused: a second fallback. `replaced`
   * is called when a newer listener takes its page over (`evict`).
   */
  add(l: Listener, replaced?: () => void): (() => void) | null
  /** the listener that has `l`'s page already, and since when (ms): the same page, overlapping types */
  holder(l: Listener): { listener: Listener; since: number } | null
  /** take `l`'s page from whoever has it: each is told (`replaced`) and let go */
  evict(l: Listener): void
  /** call `fn` whenever a listener comes or goes; returns what stops it */
  onChange(fn: () => void): () => void
}

/** Would `a` and `b` take the same answers: the same page, and the same type or either any? */
const overlap = (a: Listener, b: Listener) =>
  !a.fallback && !b.fallback && !!a.page && a.page === b.page && (!a.type || !b.type || a.type === b.type)

export function createRegistry(): Registry {
  const listeners = new Set<Listener>()
  const held = new Map<Listener, { since: number; replaced?: () => void }>()
  const watchers = new Set<() => void>()
  const changed = () => {
    for (const fn of watchers) fn()
  }
  return {
    list: (page = null) =>
      [...listeners]
        .filter(l => page == null || covers(l, page))
        .map(({ page, type, command, fallback }) => ({ page, type, command, ...(fallback && { fallback }) })),
    add(l, replaced) {
      // one fallback per project: two would split what nobody else takes between them
      if (l.fallback && [...listeners].some(x => x.fallback)) return null
      listeners.add(l)
      held.set(l, { since: Date.now(), replaced })
      changed()
      return () => {
        held.delete(l)
        if (listeners.delete(l)) changed()
      }
    },
    holder(l) {
      const x = [...listeners].find(x => overlap(x, l))
      return x ? { listener: { ...x }, since: held.get(x)!.since } : null
    },
    evict(l) {
      for (const x of [...listeners])
        if (overlap(x, l)) {
          const told = held.get(x)?.replaced
          held.delete(x)
          listeners.delete(x)
          told?.()
        }
      changed()
    },
    onChange(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
  }
}

/** A project as a fallback's stream names it, with who listens there. */
export interface Followed {
  /** the project's folder */
  dir: string
  /** where the server serves it: '' for a project's own server, `/rg/develop` under the shared one */
  base: string
  listeners: Listener[]
}

/** What a fallback's stream is told (`event: listeners`): every project it covers, now. */
export interface Snapshot {
  projects: Followed[]
}

/** The listener a /api/listen request asks for. */
export const listenerOf = (q: URLSearchParams, fallback = q.has('fallback')): Listener => ({
  page: q.get('page') || '',
  type: q.get('type') || null,
  command: q.get('command') === 'wait' ? 'wait' : 'watch',
  ...(fallback && { fallback }),
})

/**
 * Hold a /api/listen connection open as an event stream (with a ping, so nothing between closes it
 * as idle). `send` writes an event on it; `onEnd` runs once, when the agent goes or `end` is called.
 */
export function holdStream(req: IncomingMessage, res: ServerResponse, onEnd: () => void) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write(': listening\n\n')
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  let ended = false
  const finish = () => {
    if (ended) return
    ended = true
    clearInterval(ping)
    onEnd()
  }
  req.on('close', finish)
  return {
    send(event: string, data: unknown) {
      if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    end() {
      finish()
      res.end()
    },
  }
}
