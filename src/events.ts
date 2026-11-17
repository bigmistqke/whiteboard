// The project's events, one JSON object per line, in `.whiteboard/events.ndjson`. An event has a
// `type`: a submitted form's type is the form's name; a template can append events of its own.
//
// Two layers. The primitives work on the log and nothing else: read it, follow it, append to it,
// record that an event was picked up. Handing out (`handOut`) is built from them alone: it gives
// each answer to an agent once, also one given before it started, and never the agent's own. The
// command line offers both (`events`, `events --follow`, `append`, `pick`; `wait`, `watch`), and a
// script can import them (`@bigmistqke/whiteboard/log`) to use the log in ways of its own.
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { WbEvent } from './define.ts'

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
    try { event = JSON.parse(line) } catch { continue /* a corrupt line */ }
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
  try { buf = fs.readFileSync(file) } catch { return { events: [], end: 0 } }
  const end = buf.lastIndexOf(0x0a) + 1
  return { events: parseLines(buf.subarray(0, end).toString('utf8')), end }
}

/**
 * Call `onEvent` for each event appended to the log from byte `from` on (a line boundary, such as
 * `read`'s `end`), in order, as whole lines arrive. Checks every `interval` ms (default 200).
 * Returns a function that stops it.
 */
export function follow(file: string, from: number, onEvent: (event: WbEvent) => void, { interval = 200 } = {}): () => void {
  let offset = from
  let partial = ''
  const poll = () => {
    let size: number
    try { size = fs.statSync(file).size } catch { return }
    if (size < offset) { offset = 0; partial = '' } // truncated
    if (size === offset) return
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = size
    const text = partial + buf.toString('utf8')
    const cut = text.lastIndexOf('\n')
    partial = text.slice(cut + 1)
    for (const e of parseLines(text.slice(0, cut + 1))) onEvent(e)
  }
  const timer = setInterval(poll, interval)
  return () => clearInterval(timer)
}

/** `page` matches the page itself and every page below it, unless `exact`. */
export function matches(event: WbEvent, { page, type, exact }: EventFilter = {}): boolean {
  if (page && event.page !== page && (exact || !event.page.startsWith(page + '/'))) return false
  if (type && event.type !== type) return false
  return true
}

/**
 * Was this event written by the reader (a form submit, a comment), not by an agent? Agents write
 * through the command line, which marks its events `from: 'cli'`: an agent's reply, a claim, a pick.
 */
export const fromReader = (event: WbEvent): boolean => event.from !== 'cli'

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

export interface HandOutOptions {
  /** stop after this many (default: no limit) */
  count?: number
  /** after the backlog, follow the log for new events (default true) */
  follow?: boolean
  /** how often to look for new events, in ms (default 200) */
  interval?: number
  /** stops following */
  signal?: AbortSignal
}

/**
 * Hand the reader's events that match `filter` to `onEvent`, each marked as picked up once it is
 * handed out. First the backlog: those nobody picked up yet, also from before this started,
 * whatever filter picked up the others. Then, with `follow`, every new one as it comes, also when
 * another running hand-out gets it too. The backlog and the following split the log at one line
 * boundary, so no event falls between them. Events an agent wrote are never handed out.
 *
 * Resolves with how many were handed out: once `count` is reached, after the backlog without
 * `follow`, or when `signal` aborts.
 */
export function handOut(file: string, filter: EventFilter, onEvent: (event: WbEvent) => void, options: HandOutOptions = {}): Promise<number> {
  const { count = Infinity, follow: following = true, interval, signal } = options
  return new Promise(resolve => {
    let got = 0
    let stop = () => {}
    const finish = () => { stop(); signal?.removeEventListener('abort', finish); resolve(got) }
    const wanted = (e: WbEvent) => fromReader(e) && matches(e, filter)
    // false once enough were handed out
    const hand = (e: WbEvent) => {
      onEvent(e)
      pick(file, e)
      return ++got < count
    }
    if (count <= 0 || signal?.aborted) return finish()
    const { events, end } = read(file)
    const picked = pickedUp(events)
    for (const e of events) {
      if (wanted(e) && !picked.has(e.id) && !hand(e)) return finish()
    }
    if (!following) return finish()
    signal?.addEventListener('abort', finish)
    stop = follow(file, end, e => { if (got < count && wanted(e) && !hand(e)) finish() }, { interval })
  })
}
