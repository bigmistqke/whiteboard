// Where a page's questions stand, and how to say what is open on it: one definition for the server
// (`whiteboard status`, the hooks) and the page in the browser alike. No Node in it, so the browser
// runtime uses the same module.
//
// A question is a named form; its answers are the reader's events of its name. It stands:
//   waiting   an agent is listening and wants its answer: a wait or watch asks for it by name (also
//             when it was answered before: the agent wants a new answer), or takes any answer and
//             it has none
//   unheard   no answer, and no agent is listening
//   pending   answered, but no agent has picked the answer up yet
//   decided   an agent picked up its latest answer
import type { FormState, Listener, PageStatus, WbEvent } from './define.ts'

/** The states, in the order a reader should see them: what waits on them first. */
export const STATES: FormState[] = ['waiting', 'unheard', 'pending', 'decided']

/**
 * Was this event written by the reader (a form submit, a comment), not by an agent? Agents write
 * through the command line, which marks its events `from: 'cli'`: an agent's reply, a claim, a pick.
 */
export const fromReader = (event: WbEvent): boolean => event.from !== 'cli'

/**
 * Where the question `name` stands. `events` are the page's, `listeners` the running waits and
 * watches that cover the page, `pickedUp` whether an event was handed to an agent. `last` is its
 * latest answer: the reader's latest event of its name.
 */
export function questionState(
  name: string,
  events: WbEvent[],
  listeners: Listener[],
  pickedUp: (id: string) => boolean,
): { state: FormState; last: WbEvent | undefined } {
  const last = events.findLast(e => e.type === name && fromReader(e))
  const asked = listeners.some(l => l.type === name)
  const any = listeners.some(l => l.type === null)
  const state: FormState =
    asked || (any && !last) ? 'waiting'
    : !last ? 'unheard'
    : pickedUp(last.id) ? 'decided'
    : 'pending'
  return { state, last }
}

/**
 * What is open on a page, one short line each; the command that picks it up comes last, once.
 * `file` is how to name the page's file to the reader (relative to where they are). Without
 * `waiting`, the questions an agent is already waiting on are left out.
 */
export function statusLines(p: PageStatus, file: string, { waiting = true } = {}): string[] {
  const lines: string[] = []
  if (p.unpicked.length) lines.push(`${p.unpicked.length} answer${p.unpicked.length > 1 ? 's' : ''} no agent picked up (${[...new Set(p.unpicked.map(e => e.type))].join(', ')})`)
  if (p.unheard.length) lines.push(`nobody listens for ${p.unheard.join(', ')}`)
  if (lines.length) lines.push(`→ whiteboard wait --page ${file}`)
  const heard = p.open.filter(t => !p.unheard.includes(t))
  if (waiting && heard.length) lines.push(`waiting for the reader: ${heard.join(', ')}`)
  return lines
}

/** Whose a page is, said to `session`: yours, another session's, or nobody's. */
export const whose = (p: PageStatus, session: string | null): string =>
  p.owner && p.owner === session ? 'yours' : p.owner ? `session ${p.owner.slice(0, 8)}` : 'no session'
