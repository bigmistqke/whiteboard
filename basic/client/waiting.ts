// What an agent is waiting for on this page. The core knows who is listening (a running
// `whiteboard wait` or `watch`); this marks the forms they wait for, says so for forms nobody waits
// for, and gives the reader a button that jumps from one waiting form to the next.
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

const managed = (form: HTMLFormElement) => !!form.getAttribute('name') && !form.hasAttribute('action')

function waitingForms(): HTMLFormElement[] {
  return [...main.querySelectorAll('form')].filter(f => f.hasAttribute('data-wb-waiting'))
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
  const n = waitingForms().length
  button.hidden = n === 0
  button.textContent = `→ waiting for you (${n})`
  setTitlePrefix(n ? `(!${n}) ` : '')
}

// The form the button jumped to last, and where the page was scrolled then: clicking again goes to
// the one after it, round to the first. Once the reader scrolled themselves, the next one is the
// first below where they are.
let current: HTMLFormElement | null = null
let scrolledTo = 0

function next() {
  const forms = waitingForms()
  const i = current ? forms.indexOf(current) : -1
  if (i >= 0 && Math.abs(scrollY - scrolledTo) < 40) return forms[(i + 1) % forms.length]
  return forms.find(f => f.getBoundingClientRect().top > innerHeight / 2) ?? forms[0]
}

export function trackWaiting(root: HTMLElement, clientApi: ClientApi) {
  main = root
  api = clientApi
  dock.prepend(button)
  button.addEventListener('click', () => {
    const form = next()
    if (!form) return
    current = form
    form.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // where the smooth scroll ends: the form centred, as far as the page allows
    const r = form.getBoundingClientRect()
    scrolledTo = Math.max(0, Math.min(scrollY + r.top + r.height / 2 - innerHeight / 2, document.documentElement.scrollHeight - innerHeight))
    form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button')?.focus({ preventScroll: true })
  })
  api.onListeners(applyWaiting)
  api.onEvents(applyWaiting)
  applyWaiting()
}
