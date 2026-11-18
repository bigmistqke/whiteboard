// What waits for the reader on other pages: a menu in the page's header, there only while another
// page has a question they haven't answered or a message from the agent they haven't read. It
// lists those pages, each with how many; a click goes to the page, which goes to the first of them
// (`#wb-waiting`, see waiting.ts). This page's own are in its corner, not here.
import type { Api, PageHandle, PageStatus } from '../../define.ts'
import { INBOX_ICON, awaitingLabel } from '../../icons.ts'
import { awaiting } from '../../status.ts'

/** A link to a page that scrolls it to its first waiting question. */
export const WAITING_HASH = '#wb-waiting'

const box = document.createElement('div')
box.className = 'wb-elsewhere'
box.hidden = true
box.innerHTML =
  '<button type="button" class="wb-elsewhere-toggle wb-awaiting" aria-haspopup="true" aria-expanded="false"></button><ul class="wb-elsewhere-list" hidden></ul>'
const toggle = box.querySelector('button')!
// an inbox, and how many questions wait in it
toggle.innerHTML = `${INBOX_ICON}<span class="wb-elsewhere-count"></span>`
const count = toggle.querySelector('span')!
const list = box.querySelector('ul')!

function open(yes: boolean) {
  list.hidden = !yes
  toggle.setAttribute('aria-expanded', String(yes))
}

let current = ''

async function load() {
  let pages: PageStatus[]
  try {
    pages = await (await fetch('/api/status', { cache: 'no-store' })).json()
  } catch {
    return
  }
  const waiting = pages
    .filter(p => p.page !== current)
    .map(p => ({ p, n: awaiting(p) }))
    .filter(({ n }) => n > 0)
  const total = waiting.reduce((sum, { n }) => sum + n, 0)
  box.hidden = total === 0
  if (!total) open(false)
  count.textContent = String(total)
  toggle.title = awaitingLabel(total, ` on ${waiting.length === 1 ? 'another page' : `${waiting.length} other pages`}`)
  toggle.setAttribute('aria-label', toggle.title)
  list.replaceChildren(
    ...waiting.map(({ p, n }) => {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = `/${p.page.split('/').map(encodeURIComponent).join('/')}${WAITING_HASH}`
      a.textContent = `${p.title} (${n})`
      li.append(a)
      return li
    }),
  )
}

// several changes at once (an answer is an event and a listener less) load once
let timer = 0
const reload = () => {
  clearTimeout(timer)
  timer = window.setTimeout(load, 100)
}

export function trackElsewhere(root: HTMLElement, handle: PageHandle, core: Api) {
  current = handle.id
  const nav = root.querySelector('.wb-nav')
  if (!nav) return
  nav.querySelector('.wb-theme')?.before(box)
  toggle.addEventListener('click', () => open(!!list.hidden))
  document.addEventListener('click', e => {
    if (!box.contains(e.target as Node)) open(false)
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !list.hidden) {
      open(false)
      toggle.focus()
    }
  })
  // what waits changes with an answer (events), a wait starting or ending (listeners), and a page's
  // forms (a page changed)
  core.events.on(reload)
  core.listeners.on(reload)
  handle.onChange(reload)
  load()
}
