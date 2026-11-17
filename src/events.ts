// The project's events, one JSON object per line, in `.whiteboard/events.ndjson`. An event has a
// `type`: a submitted form's type is the form's name; a template can append events of its own.
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

/** Which events: `page` and `type` as `whiteboard wait` takes them. */
export interface EventFilter {
  page?: string | null
  type?: string | null
}

/**
 * The type of the event `whiteboard new` appends when an agent session creates a page:
 * `{ session }`. The colon keeps it apart from form names, which are event types too.
 */
export const CLAIM = 'whiteboard:claim'

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
    try { event = JSON.parse(line) } catch { continue /* a partial or corrupt line */ }
    out.push(event)
  }
  return out
}

export function readEvents(file: string): WbEvent[] {
  try { return parseLines(fs.readFileSync(file, 'utf8')) } catch { return [] }
}

/** `page` matches the page itself and every page below it. */
export function matches(event: WbEvent, { page, type }: EventFilter = {}): boolean {
  if (page && event.page !== page && !event.page.startsWith(page + '/')) return false
  if (type && event.type !== type) return false
  return true
}

// ---- what was handed out -----------------------------------------------------------------------
// When `whiteboard wait` or `watch` hands an event out, it appends a `whiteboard:picked` event
// naming it. The log is the only record: a wait that starts hands out the matching events nobody
// picked up yet, whatever its filter, and pages show the same events as picked up.

/** The type of the event that says another event was handed to an agent: `{ event: <its id> }`. */
export const PICKED = 'whiteboard:picked'

/** The ids of the events some wait, watch or hook handed out. */
export function pickedUp(events: WbEvent[]): Set<string> {
  return new Set(events.filter(e => e.type === PICKED && e.from === 'cli').map(e => String(e.data?.event)))
}

/** Record that `event` was handed to an agent. */
export function markPicked(file: string, event: WbEvent): WbEvent {
  return appendEvent(file, { page: event.page, type: PICKED, data: { event: event.id } }, 'cli')
}
