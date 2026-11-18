// The project's events, one JSON object per line, in `.whiteboard/events.ndjson`. An event has a
// `type`: a submitted form's type is the form's name; a plugin can append events of its own.
//
// Two layers. The primitives work on the log and nothing else: read it, follow it, append to it,
// record that an event was picked up. Handing out (`handOut`) is built from them alone: it gives
// each answer to an agent once, also one given before it started, and never the agent's own. The
// command line offers both (`events`, `events --follow`, `append`, `pick`; `wait`, `watch`), and a
// script can import them (`@bigmistqke/whiteboard/log`) to use the log in ways of its own.
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { WbEvent } from './define.ts'
import { fromReader } from './status.ts'

export { fromReader }

/** What is appended: the id and time are added. */
export interface EventInput {
  page?: unknown
  type?: unknown
  action?: string | null
  data?: Record<string, unknown>
}

/** Which events: `page` (and the pages below it) and `type`, as `whiteboard wait` takes them. */
export interface EventFilter {
  page?: string | null
  type?: string | null
  /** `page` alone, not the pages below it */
  exact?: boolean
}

/**
 * The type of the event `whiteboard new` appends when an agent session creates a page:
 * `{ session }`. The colon keeps it apart from form names, which are event types too.
 */
export const CLAIM = 'whiteboard:claim'

// ---- primitives ----------------------------------------------------------------------------------

/**
 * Append one event; `action` is the button that submitted a form, null for anything else. `from`
 * is set only for events the command line writes ('cli'), so that waits skip them and pages can
 * tell them apart; what the browser appends has none.
 */
export function appendEvent(file: string, input: EventInput, from: 'cli' | null = null): WbEvent {
  const event: WbEvent = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    page: String(input.page ?? ''),
    type: String(input.type ?? ''),
    action: input.action ?? null,
    data: input.data ?? {},
    ...(from ? { from } : {}),
  }
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
  return event
}

export function parseLines(text: string): WbEvent[] {
  const out: WbEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue /* a corrupt line */
    }
    out.push(event)
  }
  return out
}

export function readEvents(file: string): WbEvent[] {
  return read(file).events
}

/**
 * The events in the log, and the byte offset they end at: after its last whole line. A line still
 * being written is left out, and following from `end` gets it whole, so reading and then following
 * from `end` never loses or splits an event.
 */
export function read(file: string): { events: WbEvent[]; end: number } {
  let buf: Buffer
  try {
    buf = fs.readFileSync(file)
  } catch {
    return { events: [], end: 0 }
  }
  const end = buf.lastIndexOf(0x0a) + 1
  return { events: parseLines(buf.subarray(0, end).toString('utf8')), end }
}

/**
 * Call `onEvent` for each event appended to the log from byte `from` on (a line boundary, such as
 * `read`'s `end`), in order, as whole lines arrive. Checks every `interval` ms (default 200).
 * Returns a function that stops it.
 *
 * The log can be rewritten under it (`prune`: a page closed, its events gone): a new file, or a
 * shorter one. Then it reads the log again and goes on after the last event it had passed on (by
 * time, and by id among those of the same time), so nothing is passed on twice.
 */
export function follow(
  file: string,
  from: number,
  onEvent: (event: WbEvent) => void,
  { interval = 200 } = {},
): () => void {
  let offset = from
  let partial = ''
  let inode: number | null = null
  try {
    inode = fs.statSync(file).ino
  } catch {
    /* not there yet */
  }
  // where it is in the log, to find its place again after a rewrite
  let lastTs = ''
  let atLastTs = new Set<string>()
  // the events before `from` count as passed on: the place starts after the last of them
  if (from > 0) {
    let before: WbEvent[] = []
    try {
      before = parseLines(fs.readFileSync(file).subarray(0, from).toString('utf8'))
    } catch {
      /* not there */
    }
    for (const e of before) {
      if (e.ts > lastTs) {
        lastTs = e.ts
        atLastTs = new Set()
      }
      if (e.ts === lastTs) atLastTs.add(e.id)
    }
  }
  const pass = (e: WbEvent) => {
    if (e.ts > lastTs) {
      lastTs = e.ts
      atLastTs = new Set()
    }
    atLastTs.add(e.id)
    onEvent(e)
  }
  const poll = () => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    if ((inode != null && stat.ino !== inode) || stat.size < offset) {
      // rewritten: read it again, and go on after the place reached
      inode = stat.ino
      const { events, end } = read(file)
      offset = end
      partial = ''
      for (const e of events) if (e.ts > lastTs || (e.ts === lastTs && !atLastTs.has(e.id))) pass(e)
      return
    }
    inode = stat.ino
    if (stat.size === offset) return
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(stat.size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = stat.size
    const text = partial + buf.toString('utf8')
    const cut = text.lastIndexOf('\n')
    partial = text.slice(cut + 1)
    for (const e of parseLines(text.slice(0, cut + 1))) pass(e)
  }
  const timer = setInterval(poll, interval)
  return () => clearInterval(timer)
}

/**
 * Rewrite the log, event by event: `change` returns the event to keep (as it is, or changed) or
 * null to drop it. The log is written anew and put in place in one rename; when an event was
 * appended while it was being written, it starts over, so none is lost. A follow running across it
 * reads it again and goes on after the last event it passed on (see follow). Lines that aren't
 * events are kept as they are. Returns how many were dropped and changed.
 */
export function rewrite(
  file: string,
  change: (event: WbEvent) => WbEvent | null,
): { removed: number; changed: number } {
  for (let attempt = 0; attempt < 10; attempt++) {
    let buf: Buffer
    try {
      buf = fs.readFileSync(file)
    } catch {
      return { removed: 0, changed: 0 }
    }
    const keep: string[] = []
    let removed = 0,
      changed = 0
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let ev: WbEvent | null = null
      try {
        ev = JSON.parse(line)
      } catch {
        /* not an event: kept */
      }
      if (!ev) {
        keep.push(line)
        continue
      }
      const next = change(ev)
      if (!next) {
        removed++
        continue
      }
      const text = JSON.stringify(next)
      if (text !== JSON.stringify(ev)) changed++
      keep.push(next === ev ? line : text)
    }
    if (!removed && !changed) return { removed, changed }
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '')
    // appended to meanwhile: that event would be lost with the old file
    if (fs.statSync(file).size !== buf.length) {
      fs.rmSync(tmp, { force: true })
      continue
    }
    fs.renameSync(tmp, file)
    return { removed, changed }
  }
  throw new Error('the log kept changing while it was being rewritten; try again')
}

/** Remove a page's events from the log (`whiteboard close`, `whiteboard prune`): those of exactly
 *  that page, and of them only those `which` says (all by default). Returns how many. */
export function prune(file: string, page: string, which: (event: WbEvent) => boolean = () => true): number {
  return rewrite(file, e => (e.page === page && which(e) ? null : e)).removed
}

/**
 * Change an agent's event in place (`whiteboard edit`): `data` is merged into its data; its id, time
 * and everything else stay, so what refers to it (a reply, a pick, a read) still does. Only an
 * agent's own events (`from: cli`): what the reader sent stays as they sent it. Returns the event
 * as it is now.
 */
export function editEvent(file: string, id: string, data: Record<string, unknown>): WbEvent {
  const found = readEvents(file).find(e => e.id === id)
  if (!found) throw new Error(`no event ${id} in the log`)
  if (fromReader(found))
    throw new Error(
      `event ${id} is the reader's (${found.type}): what the reader sent stays as they sent it; an agent edits only its own`,
    )
  let edited: WbEvent | null = null
  rewrite(file, e => (e.id === id ? (edited = { ...e, data: { ...e.data, ...data } }) : e))
  return edited ?? found
}

/** `page` matches the page itself and every page below it, unless `exact`. */
export function matches(event: WbEvent, { page, type, exact }: EventFilter = {}): boolean {
  if (page && event.page !== page && (exact || !event.page.startsWith(page + '/'))) return false
  if (type && event.type !== type) return false
  return true
}

// When an event is handed to an agent, a `whiteboard:picked` event naming it is appended. The log
// is the only record: a wait that starts hands out the matching events nobody picked up yet,
// whatever its filter, and pages show the same events as picked up.

/** The type of the event that says another event was handed to an agent: `{ event: <its id> }`. */
export const PICKED = 'whiteboard:picked'

/** The ids of the events that were picked up. Only the command line's picks count. */
export function pickedUp(events: WbEvent[]): Set<string> {
  return new Set(events.filter(e => e.type === PICKED && !fromReader(e)).map(e => String(e.data?.event)))
}

/** Record that `event` was handed to an agent: from then on it counts as picked up. */
export function pick(file: string, event: WbEvent): WbEvent {
  return appendEvent(file, { page: event.page, type: PICKED, data: { event: event.id } }, 'cli')
}

// ---- handing out ---------------------------------------------------------------------------------

/**
 * Which event types reach an agent unasked: a form's answers (types without a colon) always, and of
 * the plugins' events (`<plugin>:<what>`) those declared `handOut: true`, given in `handedOut`.
 */
export const forAgent =
  (handedOut: ReadonlySet<string> = new Set()) =>
  (type: string): boolean =>
    !type.includes(':') || handedOut.has(type)

export interface HandOutOptions {
  /** which event types it hands out unasked (see forAgent); a filter's `type` is handed out always */
  forAgent?: (type: string) => boolean
  /** stop after this many (default: no limit) */
  count?: number
  /** after the backlog, follow the log for new events (default true) */
  follow?: boolean
  /** how often to look for new events, in ms (default 200) */
  interval?: number
  /** stops following */
  signal?: AbortSignal
  /**
   * Leave an event for now (the fallback: another listener would take it). A left event is looked
   * at again each time `recheck` calls back, and handed out then if nobody picked it up meanwhile
   * and it is no longer left.
   */
  skip?: (event: WbEvent) => boolean
  recheck?: (again: () => void) => void
}

/**
 * Hand the reader's events that match `filter` to `onEvent`, each marked as picked up once it is
 * handed out. First the backlog: those nobody picked up yet, also from before this started,
 * whatever filter picked up the others. Then, with `follow`, every new one as it comes, also when
 * another running hand-out gets it too. The backlog and the following split the log at one line
 * boundary, so no event falls between them. Events an agent wrote are never handed out, and of the
 * plugins' events only those for an agent (`forAgent`), unless the filter asks for a type by name.
 *
 * Resolves with how many were handed out: once `count` is reached, after the backlog without
 * `follow`, or when `signal` aborts.
 */
export function handOut(
  file: string,
  filter: EventFilter,
  onEvent: (event: WbEvent) => void,
  options: HandOutOptions = {},
): Promise<number> {
  const {
    count = Infinity,
    follow: following = true,
    interval,
    signal,
    forAgent: isForAgent = forAgent(),
    skip,
    recheck,
  } = options
  return new Promise(resolve => {
    let got = 0
    let stop = () => {}
    const finish = () => {
      stop()
      signal?.removeEventListener('abort', finish)
      resolve(got)
    }
    // the reader's events, and of those, the ones for an agent, unless the filter names a type
    const wanted = (e: WbEvent) => fromReader(e) && matches(e, filter) && (!!filter.type || isForAgent(e.type))
    // false once enough were handed out
    const hand = (e: WbEvent) => {
      onEvent(e)
      pick(file, e)
      return ++got < count
    }
    // the events left for now (skip), by id
    const left = new Map<string, WbEvent>()
    // false once enough were handed out; a left event is kept to look at again
    const offer = (e: WbEvent) => {
      if (skip?.(e)) {
        left.set(e.id, e)
        return true
      }
      return hand(e)
    }
    if (count <= 0 || signal?.aborted) return finish()
    const { events, end } = read(file)
    const picked = pickedUp(events)
    for (const e of events) {
      if (wanted(e) && !picked.has(e.id) && !offer(e)) return finish()
    }
    if (!following) return finish()
    signal?.addEventListener('abort', finish)
    recheck?.(() => {
      if (!left.size || got >= count) return
      const picked = pickedUp(read(file).events)
      for (const [id, e] of left) {
        if (picked.has(id)) {
          left.delete(id)
          continue
        }
        if (skip?.(e)) continue
        left.delete(id)
        if (!hand(e)) return finish()
      }
    })
    stop = follow(
      file,
      end,
      e => {
        if (got < count && wanted(e) && !offer(e)) finish()
      },
      { interval },
    )
  })
}
