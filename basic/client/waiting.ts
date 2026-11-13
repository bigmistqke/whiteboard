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

type State = 'waiting' | 'unheard' | 'answered'
const LABEL: Record<State, (n: number) => string> = {
  waiting: n => `${n} waiting for you`,
  unheard: n => `${n} nobody listening`,
  answered: n => `${n} answered`,
}
const stateOf = (form: HTMLFormElement): State =>
  form.hasAttribute('data-wb-waiting') ? 'waiting' : form.hasAttribute('data-wb-unheard') ? 'unheard' : 'answered'

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
    const answered = !!api.last(name)
    const asked = listeners.some(l => l.type === name)
    const any = listeners.some(l => l.type === null)
    form.toggleAttribute('data-wb-waiting', asked || (any && !answered))
    form.toggleAttribute('data-wb-unheard', !answered && !asked && !any)
  }
  const n = formsIn('waiting').length
  const parts = (['waiting', 'unheard', 'answered'] as State[]).map(state => [state, formsIn(state).length] as const).filter(([, count]) => count)
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
  summary.addEventListener('click', e => {
    const state = (e.target as HTMLElement).closest<HTMLElement>('button[data-state]')?.dataset.state as State | undefined
    if (state) jump(state)
  })
  api.onListeners(applyWaiting)
  api.onEvents(applyWaiting)
  applyWaiting()
}
