// What waits for the reader on a page, and how to say what is open on it: one definition for the
// server (`whiteboard status`, the hooks, the header and overview) and the page in the browser
// alike. No Node in it, so the browser runtime uses the same module.
//
// What waits for the reader is their to-do, not whether an agent's process runs: a question they
// haven't answered, and a message from the agent they haven't read.
//
// A question is a named form; its answers are the reader's events of its name. It stands:
//   open      no answer yet, or the agent asks again: a wait or watch asks for it by name after its
//             answer was picked up
//   pending   answered, but no agent has picked the answer up yet
//   decided   an agent picked up its latest answer
// Whether an agent listens is told apart where it helps when something goes wrong: the toast after
// a submit, and `whiteboard status` (`unheard`: open, and no wait or watch takes it).
//
// A message is an agent's event of a type a plugin declares `forReader` (a reply in a comment
// thread, a chat message). It is unread until a `whiteboard:read` event from the reader names it,
// which the page appends once the message has been in view; one the agent replaced (`replaces`)
// no longer counts.
import type { FormState, Listener, PageStatus, WbEvent } from './define.ts'

/**
 * Can this be a question's name, the type of its answers? Not with a colon: types with one belong
 * to whiteboard (`whiteboard:picked`) or a plugin (`comments:reply`, `chat:message`),
 * named after its owner, so a form's answers never mix with their events.
 */
export const isQuestionName = (name: string): boolean => !!name && !name.includes(':')

/** The states, in the order a reader should see them: what waits on them first. */
export const STATES: FormState[] = ['open', 'pending', 'decided']

/**
 * Was this event written by the reader (a form submit, a comment), not by an agent? Agents write
 * through the command line, which marks its events `from: 'cli'`: an agent's reply, a claim, a pick.
 */
export const fromReader = (event: WbEvent): boolean => event.from !== 'cli'

/** Does a listener's page filter cover `page`? An empty filter covers every page. */
export const covers = (l: Listener, page: string): boolean =>
  !l.page || page === l.page || page.startsWith(l.page + '/')

/**
 * Would a listener other than the fallback take this event, by its page and type? What the
 * fallback leaves to it.
 */
export const takenByOther = (listeners: Listener[], event: WbEvent): boolean =>
  listeners.some(l => !l.fallback && covers(l, event.page) && (l.type === null || l.type === event.type))

/**
 * Where the question `name` stands. `events` are the page's, `listeners` the running waits and
 * watches that cover the page (only one asking for it by name counts: it asks again),
 * `pickedUp` whether an event was handed to an agent. `last` is its latest answer: the reader's
 * latest event of its name.
 */
export function questionState(
  name: string,
  events: WbEvent[],
  listeners: Listener[],
  pickedUp: (id: string) => boolean,
): { state: FormState; last: WbEvent | undefined } {
  const last = events.findLast(e => e.type === name && fromReader(e))
  const askedAgain = listeners.some(l => !l.fallback && l.type === name)
  const state: FormState = !last ? 'open' : !pickedUp(last.id) ? 'pending' : askedAgain ? 'open' : 'decided'
  return { state, last }
}

/** Does a wait or watch take the answer to question `name`? Not: it is unheard. */
export const heard = (name: string, listeners: Listener[]): boolean =>
  listeners.some(l => !l.fallback && (l.type === null || l.type === name))

/** The type of the event the page appends once messages were in view: `{ ids }`. */
export const READ = 'whiteboard:read'

/**
 * The type of the event `whiteboard scroll` appends: show the reader a place on a page, `{ to }`. A
 * page applies the latest one that came after it loaded, as it comes or once its live channel is
 * back.
 */
export const SCROLL = 'whiteboard:scroll'

/**
 * The agent's messages on a page the reader hasn't read: events from the agent of a type
 * `isMessage` says is for the reader, not named by a `whiteboard:read` from the reader, and not
 * replaced by a later one (`replaces`).
 */
export function unreadMessages(events: WbEvent[], isMessage: (type: string) => boolean): WbEvent[] {
  const read = new Set<string>()
  const replaced = new Set<string>()
  for (const e of events) {
    if (e.type === READ && fromReader(e))
      for (const id of (e.data?.ids as unknown[] | undefined) ?? []) read.add(String(id))
    if (e.data?.replaces) replaced.add(String(e.data.replaces))
  }
  return events.filter(e => !fromReader(e) && isMessage(e.type) && !read.has(e.id) && !replaced.has(e.id))
}

/** How many things on a page wait for the reader: its open questions and unread messages. */
export const awaiting = (p: Pick<PageStatus, 'open' | 'unread'>): number => p.open.length + p.unread.length

/** The type of the event that says another event was handed to an agent: `{ event: <its id> }`. */
export const PICKED = 'whiteboard:picked'

/**
 * The type of the event `whiteboard new` appends when an agent session creates a page:
 * `{ session }`. The colon keeps it apart from form names, which are event types too.
 */
export const CLAIM = 'whiteboard:claim'

/** The ids of the events that were picked up. Only the command line's picks count. */
export function pickedUp(events: WbEvent[]): Set<string> {
  return new Set(events.filter(e => e.type === PICKED && !fromReader(e)).map(e => String(e.data?.event)))
}

/** A page as the snapshot needs it; its questions (`asks`) are its named forms. */
export interface StatusPage {
  id: string
  file: string
  title: string
  asks: string[]
}

/** What a project's status is made of: no disk in it, the server reads and hands it over. */
export interface StatusInput {
  pages: StatusPage[]
  /** the whole log */
  events: WbEvent[]
  /** the running waits and watches covering a page */
  listeners: (page: string) => Listener[]
  /** the event types handed to an agent (a form's answers; plugins' events declared handOut) */
  forAgent: (type: string) => boolean
  /** the event types that are messages for the reader (declared forReader) */
  forReader: (type: string) => boolean
}

/** A project's status at one moment: what `whiteboard status`, the page lists and the log's marks take. */
export interface ProjectStatus {
  /** per page, in the order given */
  pages: PageStatus[]
  /** the events that were picked up, by id */
  picked: Set<string>
  /** when the reader last sent something on a page (what the agent appended doesn't count) */
  lastAnswered: (page: string) => string | null
}

/**
 * A project's status from its pages, its log and who listens: per page its questions and where each
 * stands, what is open and unheard, the agent's messages unread, the reader's events not picked up,
 * and who listens; which events were picked up; when each page was last answered. The log is
 * gone through once.
 */
export function projectStatus({ pages, events, listeners, forAgent, forReader }: StatusInput): ProjectStatus {
  const picked = pickedUp(events)
  const byPage = new Map<string, WbEvent[]>()
  const owner = new Map<string, string | null>()
  const last = new Map<string, string>()
  for (const e of events) {
    let list = byPage.get(e.page)
    if (!list) byPage.set(e.page, (list = []))
    list.push(e)
    if (fromReader(e)) last.set(e.page, e.ts)
    else if (e.type === CLAIM) owner.set(e.page, (e.data?.session as string | undefined) ?? null)
  }
  return {
    picked,
    lastAnswered: page => last.get(page) ?? null,
    pages: pages.map(p => {
      const own = byPage.get(p.id) ?? []
      const listening = listeners(p.id)
      // where each question stands, as the page shows it
      const questions = p.asks.map(name => ({
        name,
        state: questionState(name, own, listening, id => picked.has(id)).state,
      }))
      const open = questions.filter(q => q.state === 'open').map(q => q.name)
      return {
        page: p.id,
        title: p.title,
        file: p.file,
        owner: owner.get(p.id) ?? null,
        asks: p.asks,
        questions,
        open,
        unheard: open.filter(name => !heard(name, listening)),
        unread: unreadMessages(own, forReader),
        // the reader's events for an agent: a form's answers, and plugin events declared handOut
        unpicked: own.filter(e => fromReader(e) && forAgent(e.type) && !picked.has(e.id)),
        listeners: listening,
      }
    }),
  }
}

/**
 * What is open on a page, one short line each; the command that picks it up comes last, once.
 * `file` is how to name the page's file to the reader (relative to where they are). Without
 * `waiting`, the questions an agent is already waiting on are left out.
 */
export function statusLines(p: PageStatus, file: string, { waiting = true } = {}): string[] {
  const lines: string[] = []
  if (p.unpicked.length)
    lines.push(
      `${p.unpicked.length} answer${p.unpicked.length > 1 ? 's' : ''} no agent picked up (${[...new Set(p.unpicked.map(e => e.type))].join(', ')})`,
    )
  const fallback = p.listeners.some(l => l.fallback)
  if (p.unheard.length)
    lines.push(
      fallback
        ? `no agent waits for ${p.unheard.join(', ')}; the fallback picks the answers up`
        : `nobody listens for ${p.unheard.join(', ')}`,
    )
  if (lines.length && !(fallback && !p.unpicked.length)) lines.push(`→ whiteboard wait --page ${file}`)
  const listened = p.open.filter(t => !p.unheard.includes(t))
  if (waiting && listened.length) lines.push(`waiting for the reader: ${listened.join(', ')}`)
  return lines
}

/** Whose a page is, said to `session`: yours, another session's, or nobody's. */
export const whose = (p: PageStatus, session: string | null): string =>
  p.owner && p.owner === session ? 'yours' : p.owner ? `session ${p.owner.slice(0, 8)}` : 'no session'
