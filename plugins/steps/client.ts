// Steps in the browser: which item shows, by the ‹ › buttons, the tabs and ← →, and kept across
// the page's updates (which write the block anew) by the block's place among the page's steps. It
// marks only data-wb-* attributes, which a block's signature leaves out: flipping through items is
// not a change to the page.
import type { Api, PageHandle, PluginMount } from '../../src/define'

const windows = () => [...document.querySelectorAll<HTMLElement>('#wb-main .wb-steps-window')]
const items = (win: HTMLElement) => [
  ...win.querySelectorAll<HTMLElement>(':scope > .wb-window-body > .wb-steps > .wb-steps-item'),
]
const marks = (win: HTMLElement) => [...win.querySelectorAll<HTMLElement>(':scope > .wb-window-bar .wb-steps-mark')]

/** which item shows, by the block's place */
const at = new Map<number, number>()

function show(win: HTMLElement, place: number, i: number) {
  const all = items(win)
  const n = Math.max(all.length, 1)
  i = Math.min(Math.max(i, 0), n - 1)
  at.set(place, i)
  win.setAttribute('data-wb-step', String(i))
  all.forEach((item, k) => item.toggleAttribute('data-wb-current', k === i))
  marks(win).forEach((mark, k) => mark.toggleAttribute('data-wb-current', k === i))
  win.toggleAttribute('data-wb-first', i === 0)
  win.toggleAttribute('data-wb-last', i === n - 1)
}

const apply = () => windows().forEach((win, place) => show(win, place, at.get(place) ?? 0))

function step(win: HTMLElement, to: 'prev' | 'next' | number) {
  const place = windows().indexOf(win)
  if (place < 0) return
  const now = at.get(place) ?? 0
  show(win, place, to === 'prev' ? now - 1 : to === 'next' ? now + 1 : to)
}

const typing = (el: Element | null) =>
  !!el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')

let listening = false
const mount: PluginMount = (_el: HTMLElement, _handle: PageHandle, core: Api) => {
  apply()
  core.onRendered(apply)
  if (listening) return
  listening = true
  document.addEventListener('click', e => {
    const button = (e.target as Element).closest?.<HTMLElement>('[data-steps]')
    const win = button?.closest<HTMLElement>('.wb-steps-window')
    if (!button || !win) return
    const to = button.dataset.steps!
    step(win, to === 'prev' || to === 'next' ? to : Number(to))
  })
  document.addEventListener('keydown', e => {
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as Element
    if (typing(target)) return
    // the steps that have the focus, or the one filling the window
    const win =
      target.closest?.<HTMLElement>('.wb-steps-window') ??
      document.querySelector<HTMLElement>('#wb-main .wb-steps-window[data-wb-maximized]')
    if (!win) return
    e.preventDefault()
    step(win, e.key === 'ArrowLeft' ? 'prev' : 'next')
  })
}
export default mount
