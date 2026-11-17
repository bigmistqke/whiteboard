// How markboard shows what an agent waits for. The core marks each named form with where it stands
// (waiting, unheard, pending, decided; see `api.onForms`); markboard styles those marks (base.css),
// folds a decided form into one line quoting its answer, sums the states up in a line above the
// page, puts a button in the page's corner that jumps from one waiting form to the next, and counts
// the waiting ones in the tab title.
import type { Api, FormState, FormStatus } from '../../src/define'
import { viewBottom } from './view'
import { STATES } from '../../src/status.ts'

const ORDER = STATES
const LABEL: Record<FormState, (n: number) => string> = {
  waiting: n => `${n} waiting for you`,
  unheard: n => `${n} nobody listening`,
  pending: n => `${n} waiting for the agent`,
  decided: n => `${n} decided`,
}

let main: HTMLElement
let api: Api
let forms: FormStatus[] = []

const button = document.createElement('button')
button.type = 'button'
button.className = 'wb-waiting-next'
button.hidden = true

// above the page's content, not in it: #wb-main is compared block by block on every update
const summary = document.createElement('div')
summary.className = 'wb-summary'
summary.hidden = true

// forms the reader opened again to change their answer, by name, with the answer they opened:
// they stay open until a newer answer is decided
const reopened = new Map<string, string>()

const inState = (state: FormState) => forms.filter(f => f.state === state && f.form.isConnected).map(f => f.form)

function show(list: FormStatus[]) {
  forms = list
  for (const { form, name, state, last } of forms) {
    if (last && reopened.has(name) && reopened.get(name) !== last.id && state === 'decided') reopened.delete(name)
    form.toggleAttribute('data-wb-folded', state === 'decided' && !reopened.has(name))
  }
  const parts = ORDER.map(state => [state, inState(state).length] as const).filter(([, count]) => count)
  summary.hidden = !parts.length
  summary.replaceChildren(...parts.flatMap(([state, count], i) => {
    const link = document.createElement('button')
    link.type = 'button'
    link.dataset.state = state
    link.textContent = LABEL[state](count)
    return i ? [document.createTextNode(' · '), link] : [link]
  }))
  const n = inState('waiting').length
  button.hidden = n === 0
  button.textContent = `→ waiting for you (${n})`
  api.badge('waiting', n ? `!${n}` : null, -1)
}

// The form a jump went to last, and where the page was scrolled then: jumping again in the same
// state goes to the one after it, round to the first. Once the reader scrolled themselves, the
// next one is the first below where they are.
let current: HTMLFormElement | null = null
let scrolledTo = 0

function next(state: FormState) {
  const list = inState(state)
  const i = current ? list.indexOf(current) : -1
  if (i >= 0 && Math.abs(scrollY - scrolledTo) < 40) return list[(i + 1) % list.length]
  return list.find(f => f.getBoundingClientRect().top > viewBottom() / 2) ?? list[0]
}

function jump(state: FormState) {
  const form = next(state)
  if (!form) return
  current = form
  // the form centred in the part of the window the page is seen in (above the terminal drawer),
  // as far as the page allows
  const r = form.getBoundingClientRect()
  scrolledTo = Math.max(0, Math.min(scrollY + r.top + r.height / 2 - viewBottom() / 2, document.documentElement.scrollHeight - innerHeight))
  scrollTo({ top: scrolledTo, behavior: 'smooth' })
  if (state === 'waiting') form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button')?.focus({ preventScroll: true })
}

export function trackWaiting(root: HTMLElement, core: Api) {
  main = root
  api = core
  api.corner().prepend(button)
  button.addEventListener('click', () => jump('waiting'))
  main.before(summary)
  summary.addEventListener('click', e => {
    const state = (e.target as HTMLElement).closest<HTMLElement>('button[data-state]')?.dataset.state as FormState | undefined
    if (state) jump(state)
  })
  // a folded form opens again on a click, to change the answer; not on one in its thread, which
  // stays open under it
  main.addEventListener('click', e => {
    const target = e.target as HTMLElement
    const form = target.closest<HTMLFormElement>('form[data-wb-folded]')
    if (!form || target.closest('[data-template=form-thread]')) return
    e.preventDefault()
    const name = form.getAttribute('name')!
    const last = api.last(name)
    if (last) reopened.set(name, last.id)
    show(forms)
    form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus({ preventScroll: true })
  })
  api.onForms(show)
  show(api.forms())
}
