// What waits for the reader on other pages: a menu in the page's header, there only while another
// page has a question they haven't answered or a message from the agent they haven't read. It
// lists those pages, each with how many; a click goes to the page, which goes to the first of them
// (`#wb-waiting`, see waiting.ts). This page's own are in its corner, not here.
import type { Api, PageHandle, PageStatus } from '../../define.ts'
import { INBOX_ICON, awaitingLabel } from '../../icons.ts'
import { awaiting } from '../../status.ts'
import { base, url } from '../base.ts'

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

/** A page with something waiting, in a group of the menu (its project, under a shared server). */
interface Waiting {
  href: string
  title: string
  n: number
}

/** This project's pages with something waiting, but this one. */
async function here(): Promise<Waiting[]> {
  const pages = (await (await fetch(url('/api/status'), { cache: 'no-store' })).json()) as PageStatus[]
  return pages
    .filter(p => p.page !== current)
    .map(p => ({
      href: `${base}/${p.page.split('/').map(encodeURIComponent).join('/')}${WAITING_HASH}`,
      title: p.title,
      n: awaiting(p),
    }))
    .filter(w => w.n > 0)
}

/**
 * Under a shared server (see Entries in DESIGN.md): the other projects of this one's entry, by
 * project, as the server's index has them; empty on a server of its own, or when it can't say.
 */
async function others(): Promise<{ label: string; pages: Waiting[] }[]> {
  if (!base) return []
  const entry = base.split('/')[1]
  try {
    const res = await fetch(`/api/index?entry=${encodeURIComponent(entry ?? '')}`, { cache: 'no-store' })
    if (!res.ok) return []
    const projects = (await res.json()) as {
      label: string
      base: string
      pages: { title: string; url: string; open: string[]; unread: number }[]
    }[]
    return projects
      .filter(p => p.base !== base)
      .map(p => ({
        label: p.label,
        pages: p.pages
          .map(x => ({ href: `${x.url}${WAITING_HASH}`, title: x.title, n: x.open.length + x.unread }))
          .filter(w => w.n > 0),
      }))
      .filter(g => g.pages.length)
  } catch {
    return []
  }
}

async function load() {
  let mine: Waiting[]
  let rest: { label: string; pages: Waiting[] }[]
  try {
    ;[mine, rest] = await Promise.all([here(), others()])
  } catch {
    return
  }
  const all = [...mine, ...rest.flatMap(g => g.pages)]
  const total = all.reduce((sum, w) => sum + w.n, 0)
  box.hidden = total === 0
  if (!total) open(false)
  count.textContent = String(total)
  toggle.title = awaitingLabel(total, ` on ${all.length === 1 ? 'another page' : `${all.length} other pages`}`)
  toggle.setAttribute('aria-label', toggle.title)
  const item = (w: Waiting) => {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = w.href
    a.textContent = `${w.title} (${w.n})`
    li.append(a)
    return li
  }
  const heading = (text: string) =>
    Object.assign(document.createElement('li'), { className: 'wb-elsewhere-group', textContent: text, title: text })
  // this project's own first; the others by project, named only when there are others
  list.replaceChildren(
    ...(rest.length && mine.length ? [heading('here')] : []),
    ...mine.map(item),
    ...rest.flatMap(g => [heading(g.label), ...g.pages.map(item)]),
  )
}

// several changes at once (an answer is an event and a listener less) load once; a hidden tab
// loads once it is shown, and not before (the index asks every project of the server)
let timer = 0
let stale = false
const reload = () => {
  clearTimeout(timer)
  if (document.hidden) return void (stale = true)
  timer = window.setTimeout(load, 100)
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !stale) return
  stale = false
  reload()
})

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
  // another project's pages, log or listeners changed: the shared server says so on the live
  // channel (and the channel opening again may have missed some)
  if (base) document.addEventListener('wb-elsewhere', reload)
}
