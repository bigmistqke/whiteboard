// The table of contents (index.ts): built from the page's ## and ### headings, again after each
// update; the section being read is the last heading above the top of the view; a section is
// marked when an open question (data-wb-open) or an unread message (data-wb-message, or the element
// holding one, data-wb-holds) is in it. A click scrolls to the heading, below the header.
import type { Api, PageHandle, PluginMount } from '../../src/define.ts'

const panel = document.createElement('nav')
panel.className = 'wb-toc'
panel.setAttribute('aria-label', 'Contents')
const list = document.createElement('ol')
panel.append(list)

const toggle = document.createElement('button')
toggle.type = 'button'
toggle.className = 'wb-toc-toggle'
toggle.title = toggle.ariaLabel = 'Contents'
toggle.innerHTML =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg>'

let main: HTMLElement
let api: Api
let headings: HTMLElement[] = []

const navHeight = () => document.querySelector<HTMLElement>('.wb-nav')?.getBoundingClientRect().height ?? 0

/** The gap between the panel and the text, and between the panel and the window's edge. */
const GAP = 40
const EDGE = 16

/** Is there room left of the text for the panel at its narrowest? Else it opens from the header. */
function fits() {
  const narrowest = parseFloat(getComputedStyle(panel).minWidth) || 0
  return main.getBoundingClientRect().left >= narrowest + GAP + EDGE
}

/** A width as the frontmatter or the options give it: a CSS length, or a number of pixels. */
const length = (value: unknown): string | null => {
  const m = /^(\d+(?:\.\d+)?)(px|em|rem|ch|vw)?$/.exec(String(value ?? '').trim())
  return m && Number(m[1]) > 0 ? m[1] + (m[2] ?? 'px') : null
}

/**
 * How wide the panel may be: it fits its items, between a minimum and a maximum, which the page's
 * frontmatter can set (`toc: { minWidth: 160px, maxWidth: 320px }`), else the project's options.
 */
function bounds() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=wb-toc]')
  const said = handle.frontmatter().toc
  const own = said && typeof said === 'object' ? (said as Record<string, unknown>) : {}
  for (const [name, prop] of [
    ['minWidth', '--wb-toc-min-width'],
    ['maxWidth', '--wb-toc-max-width'],
  ] as const) {
    const value = length(own[name]) ?? length(meta?.dataset[name])
    if (value) panel.style.setProperty(prop, value)
    else panel.style.removeProperty(prop)
  }
}

/** Docked: its right edge a gap left of the text, so a wider panel grows away from it. */
function place() {
  const left = main.getBoundingClientRect().left
  panel.style.setProperty('--wb-toc-right', `${document.documentElement.clientWidth - left + GAP}px`)
  panel.style.setProperty('--wb-toc-room', `${left - GAP - EDGE}px`)
}

let handle: PageHandle

/** Does this page have it: what its frontmatter says (`toc:`), and whether it is on everywhere. */
function wanted() {
  // `toc: true`, or `toc: { minWidth, maxWidth }`: on; `toc: false`: off; else as the project says
  const said = handle.frontmatter().toc
  const always = document.querySelector('meta[name=wb-toc]')?.getAttribute('content') === 'always'
  if (said === false) return false
  if (said === true || (said && typeof said === 'object')) return true
  return always
}

function build() {
  headings = wanted() ? [...main.querySelectorAll<HTMLElement>(':scope > h2, :scope > h3')] : []
  let h2 = 0,
    h3 = 0
  list.replaceChildren(
    ...headings.map((h, i) => {
      // the page's numbers: 1, 1.1, 1.2, 2 (base.css counts ## and ### alike)
      const number = h.tagName === 'H2' ? `${++h2}` : `${h2}.${++h3}`
      if (h.tagName === 'H2') h3 = 0
      const li = document.createElement('li')
      li.dataset.level = h.tagName === 'H2' ? '2' : '3'
      const a = document.createElement('a')
      a.href = '#'
      a.dataset.index = String(i)
      a.innerHTML = `<span class="wb-toc-number"></span><span class="wb-toc-text"></span>`
      a.querySelector('.wb-toc-number')!.textContent = number
      a.querySelector('.wb-toc-text')!.textContent = h.textContent ?? ''
      li.append(a)
      return li
    }),
  )
  const any = headings.length > 1
  bounds()
  place()
  toggle.hidden = !any || fits()
  panel.hidden = !any || (!fits() && !panel.classList.contains('wb-toc-open'))
  panel.classList.toggle('wb-toc-docked', fits())
  mark()
  current()
}

/** The section each element is in: the last heading before it. */
function sectionOf(el: Element): number {
  let at = -1
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) at = i
    else break
  }
  return at
}

/** A dot on the sections where something waits for the reader. */
function mark() {
  const waiting = new Set<number>()
  const unread = new Set(api.unread().map(e => e.id))
  const els = [
    ...main.querySelectorAll('form[data-wb-open]'),
    ...[...main.querySelectorAll<HTMLElement>('[data-wb-message]')].filter(el => unread.has(el.dataset.wbMessage!)),
  ]
  for (const el of els) waiting.add(sectionOf(el))
  // a reply in a closed comment thread: its badge sits outside the page's flow, beside the passage
  for (const badge of document.querySelectorAll<HTMLElement>('[data-wb-holds]')) {
    if (!badge.dataset.wbHolds!.split(' ').some(id => unread.has(id))) continue
    const y = badge.getBoundingClientRect().top
    let at = -1
    headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= y) at = i
    })
    waiting.add(at)
  }
  list.querySelectorAll<HTMLElement>('a').forEach((a, i) => a.toggleAttribute('data-waiting', waiting.has(i)))
}

/** The section being read: the last heading above the top of the view. */
function current() {
  const line = navHeight() + 40
  let at = 0
  headings.forEach((h, i) => {
    if (h.getBoundingClientRect().top <= line) at = i
  })
  list
    .querySelectorAll<HTMLElement>('a')
    .forEach((a, i) => a.toggleAttribute('aria-current', i === at && headings.length > 0))
}

function go(i: number) {
  const h = headings[i]
  if (!h) return
  scrollTo({ top: Math.max(0, scrollY + h.getBoundingClientRect().top - navHeight() - 12), behavior: 'smooth' })
  if (!fits()) {
    panel.classList.remove('wb-toc-open')
    panel.hidden = true
  }
}

const mount: PluginMount = (root, page, core) => {
  if (page.kind !== 'page' && page.kind !== 'file') return
  handle = page
  main = root.querySelector<HTMLElement>('#wb-main') ?? root
  api = core
  document.body.append(panel)
  root.querySelector('.wb-nav .wb-theme')?.before(toggle)
  list.addEventListener('click', e => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('a[data-index]')
    if (!a) return
    e.preventDefault()
    go(Number(a.dataset.index))
  })
  toggle.addEventListener('click', () => {
    const open = !panel.classList.contains('wb-toc-open')
    panel.classList.toggle('wb-toc-open', open)
    panel.hidden = !open
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel.classList.contains('wb-toc-open')) toggle.click()
  })
  let frame = 0
  const soon = (fn: () => void) => () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(fn)
  }
  addEventListener('scroll', soon(current), { passive: true })
  addEventListener('resize', soon(build))
  api.onRendered(build)
  page.frontmatter.on(build)
  api.forms.on(() => mark())
  api.events.on(() => requestAnimationFrame(mark))
  build()
}

export default mount
