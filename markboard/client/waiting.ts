// What an agent is waiting for on this page. The core knows who is listening (a running
// `whiteboard wait` or `watch`); this marks the forms they wait for, says so for forms nobody waits
// for, gives the reader a button that jumps from one waiting form to the next, and sums it all up
// in a line above the page: what waits for the reader, what nobody listens for, what is answered.
//
// A form waits for the reader when a listener asks for it by name (also when it was answered
// before: the agent wants a new answer), or when a listener takes any answer on the page and the
// form has none yet.
import type { ClientApi } from '../types'
import { dock, setTitlePrefix } from './fresh'

const button = document.createElement('button')
button.type = 'button'
button.className = 'wb-waiting-next'
button.hidden = true

let main: HTMLElement
let api: ClientApi

// above the page's content, not in it: #wb-main is compared block by block on every update
const summary = document.createElement('div')
summary.className = 'wb-summary'
summary.hidden = true

// A form is in one of four states:
//   waiting    an agent is listening and wants its answer
//   unheard    no answer, and no agent is listening
//   sent       answered, but no agent has picked the answer up yet
//   decided    an agent picked up its latest answer: the form folds into one line quoting it
type State = 'waiting' | 'unheard' | 'sent' | 'decided'
const ORDER: State[] = ['waiting', 'unheard', 'sent', 'decided']
const LABEL: Record<State, (n: number) => string> = {
  waiting: n => `${n} waiting for you`,
  unheard: n => `${n} nobody listening`,
  sent: n => `${n} waiting for the agent`,
  decided: n => `${n} decided`,
}
const STATE_ATTR: Record<State, string> = { waiting: 'data-wb-waiting', unheard: 'data-wb-unheard', sent: 'data-wb-pending', decided: 'data-wb-decided' }
const stateOf = (form: HTMLFormElement): State => ORDER.find(st => form.hasAttribute(STATE_ATTR[st])) ?? 'sent'

// forms the reader opened again to change their answer, by name, with the answer they opened:
// they stay open until a newer answer is decided
const reopened = new Map<string, string>()

/** One line quoting an answer: what was chosen, then what was written. */
function outcome(data: Record<string, unknown>, action: string | null) {
  const chosen: string[] = [], written: string[] = []
  for (const v of Object.values(data)) {
    if (v == null || v === '' || v === false) continue
    if (Array.isArray(v)) { if (v.length) chosen.push(v.join(', ')) }
    else if (v === true) continue
    else if (String(v).length > 60 || String(v).includes('\n')) written.push(String(v))
    else chosen.push(String(v))
  }
  if (action && !['Send', 'Submit'].includes(action)) chosen.unshift(action)
  return [chosen.join(' · ') || 'sent', ...written.map(w => `“${w.length > 240 ? w.slice(0, 240) + '…' : w}”`)].join('\n')
}

const managed = (form: HTMLFormElement) => !!form.getAttribute('name') && !form.hasAttribute('action')

function formsIn(state: State): HTMLFormElement[] {
  return [...main.querySelectorAll('form')].filter(f => managed(f) && stateOf(f) === state)
}

/** Mark the page's forms from the current listeners and answers. Call after anything re-renders. */
export function applyWaiting() {
  if (!main) return
  const listeners = api.listeners()
  for (const form of main.querySelectorAll('form')) {
    if (!managed(form)) continue
    const name = form.getAttribute('name')!
    const last = api.last(name)
    const asked = listeners.some(l => l.type === name)
    const any = listeners.some(l => l.type === null)
    const picked = !!last && api.pickedUp(last.id)
    // a form opened again stays open until a newer answer of it is decided
    if (last && reopened.has(name) && reopened.get(name) !== last.id && picked) reopened.delete(name)
    const state: State =
      asked || (any && !last) ? 'waiting'
      : !last ? 'unheard'
      : picked ? 'decided'
      : 'sent'
    for (const st of ORDER) form.toggleAttribute(STATE_ATTR[st], st === state)
    form.toggleAttribute('data-wb-folded', state === 'decided' && !reopened.has(name))
    if (state === 'decided') form.dataset.wbOutcome = outcome(last!.data, last!.action)
    else delete form.dataset.wbOutcome
  }
  const n = formsIn('waiting').length
  const parts = ORDER.map(state => [state, formsIn(state).length] as const).filter(([, count]) => count)
  summary.hidden = !parts.length
  summary.replaceChildren(...parts.flatMap(([state, count], i) => {
    const link = document.createElement('button')
    link.type = 'button'
    link.dataset.state = state
    link.textContent = LABEL[state](count)
    return i ? [document.createTextNode(' · '), link] : [link]
  }))
  button.hidden = n === 0
  button.textContent = `→ waiting for you (${n})`
  setTitlePrefix(n ? `(!${n}) ` : '')
}

// The form a jump went to last, and where the page was scrolled then: jumping again in the same
// state goes to the one after it, round to the first. Once the reader scrolled themselves, the
// next one is the first below where they are.
let current: HTMLFormElement | null = null
let scrolledTo = 0

function next(state: State) {
  const forms = formsIn(state)
  const i = current ? forms.indexOf(current) : -1
  if (i >= 0 && Math.abs(scrollY - scrolledTo) < 40) return forms[(i + 1) % forms.length]
  return forms.find(f => f.getBoundingClientRect().top > innerHeight / 2) ?? forms[0]
}

function jump(state: State) {
  const form = next(state)
  if (!form) return
  current = form
  form.scrollIntoView({ behavior: 'smooth', block: 'center' })
  // where the smooth scroll ends: the form centred, as far as the page allows
  const r = form.getBoundingClientRect()
  scrolledTo = Math.max(0, Math.min(scrollY + r.top + r.height / 2 - innerHeight / 2, document.documentElement.scrollHeight - innerHeight))
  if (state === 'waiting') form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button')?.focus({ preventScroll: true })
}

export function trackWaiting(root: HTMLElement, clientApi: ClientApi) {
  main = root
  api = clientApi
  dock.prepend(button)
  button.addEventListener('click', () => jump('waiting'))
  main.before(summary)
  // a folded form opens again on a click, to change the answer
  main.addEventListener('click', e => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-wb-folded]')
    if (!form) return
    e.preventDefault()
    const last = api.last(form.getAttribute('name')!)
    if (last) reopened.set(form.getAttribute('name')!, last.id)
    applyWaiting()
    form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus({ preventScroll: true })
  })
  summary.addEventListener('click', e => {
    const state = (e.target as HTMLElement).closest<HTMLElement>('button[data-state]')?.dataset.state as State | undefined
    if (state) jump(state)
  })
  api.onListeners(applyWaiting)
  api.onEvents(applyWaiting)
  applyWaiting()
}
