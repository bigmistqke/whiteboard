// New-content tracking. A top-level block of the page is "new" when its content was not on the
// page last time the reader saw it: since the previous live update, or since their previous
// visit (remembered per page in localStorage). New blocks get .wb-new (a left border) until they
// have been in view for a moment with the tab visible. Floating buttons jump to unseen blocks.

import { html } from '../../html.ts'
import type { Api, Toast } from '../../define.ts'
import { viewBottom } from './view'
import { storageKey } from '../base.ts'

const DWELL_MS = 600
const FADE_MS = 2500

const sigOf = new WeakMap<Element, string>()
const unseen = new Set<Element>()
const timers = new WeakMap<Element, number>()
let storeKey = ''
// set by trackInitial: a page that tracks nothing (the overview) has no bubbles
let core: Api | undefined

// the data-wb-* attributes the server writes into a page; every other one is the browser's (a
// form's state, a mark, a key), and not part of what the server sent
const SERVER_MARKS = new Set([
  'data-wb-at',
  'data-wb-key',
  'data-wb-maximize',
  'data-wb-other',
  'data-wb-other-text',
  'data-wb-quiet',
  'data-wb-self',
  'data-wb-sort',
])

/**
 * FNV-1a over the block's HTML as the server sent it, ignoring anything quiet: content inside
 * [data-wb-quiet] can appear, change or go without the block counting as changed. What the browser
 * added is left out, so a block in the page and the same block in a new render have one signature:
 * an island's content (it draws itself; its props are in its key), the page's own elements (a folded
 * form's card), its marks (data-wb-* the server doesn't write: a form's state) and its classes for
 * new content.
 */
export function signature(el: Element): string {
  const clone = el.cloneNode(true) as Element
  for (const q of clone.querySelectorAll('[data-wb-quiet], .wb-folded')) q.remove()
  for (const n of [clone, ...clone.querySelectorAll('*')]) {
    for (const { name } of [...n.attributes])
      if (name.startsWith('data-wb-') && !SERVER_MARKS.has(name)) n.removeAttribute(name)
    n.classList.remove('wb-new', 'wb-new-seen')
    if (!n.classList.length) n.removeAttribute('class')
  }
  for (const island of clone.querySelectorAll('[data-wb-key]')) island.replaceChildren()
  const s = clone.outerHTML
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}

/** Signatures of the top-level blocks in an HTML string, in order. */
export function signaturesOf(html: string): string[] {
  const t = document.createElement('template')
  t.innerHTML = html
  return [...t.content.children].map(signature)
}

function loadSeen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(storeKey)
    return raw ? new Set(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function saveSeen(main: HTMLElement) {
  try {
    const seen = [...main.children]
      .filter(el => !unseen.has(el) && ![...unseen].some(u => el.contains(u)))
      .map(el => sigOf.get(el))
      .filter(Boolean)
    localStorage.setItem(storeKey, JSON.stringify(seen))
  } catch {
    /* storage unavailable: tracking still works for this visit */
  }
}

// ---- seen detection ----------------------------------------------------------------------------
// Measured directly on scroll, resize and tab switches (and every half second while anything is
// unseen, since layout also moves without scrolling). An IntersectionObserver only reports at fixed
// fractions of a block's own height, which a block taller than twice the screen never reaches.

let mainEl: HTMLElement

/** In view enough to count as read: half the block, or half the screen for blocks taller than that. */
function inView(el: Element) {
  const r = el.getBoundingClientRect()
  const bottom = viewBottom()
  const overlap = Math.min(r.bottom, bottom) - Math.max(r.top, 0)
  return overlap > 0 && overlap >= Math.min(r.height, bottom) * 0.5
}

/** Start the dwell timer of unseen blocks in view; stop it for blocks that left the view. */
function check() {
  const active = document.visibilityState === 'visible'
  for (const el of unseen) {
    if (!el.isConnected) {
      unseen.delete(el)
      continue
    }
    const pending = timers.has(el)
    if (active && inView(el)) {
      if (!pending)
        timers.set(
          el,
          window.setTimeout(() => {
            timers.delete(el)
            markSeen(el)
          }, DWELL_MS),
        )
    } else if (pending) {
      clearTimeout(timers.get(el))
      timers.delete(el)
    }
  }
}

let checkFrame = 0
const scheduleCheck = () => {
  cancelAnimationFrame(checkFrame)
  checkFrame = requestAnimationFrame(check)
}
addEventListener('scroll', scheduleCheck, { passive: true })
addEventListener('resize', scheduleCheck)
document.addEventListener('visibilitychange', scheduleCheck)
setInterval(() => {
  if (unseen.size) check()
}, 500)

function markSeen(el: Element) {
  if (!unseen.delete(el)) return
  el.classList.add('wb-new-seen')
  setTimeout(() => el.classList.remove('wb-new', 'wb-new-seen'), FADE_MS)
  saveSeen(mainEl)
  update()
}

/**
 * An item in a list: its bar where the bars of blocks are, not in the list's indent by its bullet.
 * Set inline, so set again after every update (which takes the page's style attributes back).
 */
function placeBar(el: Element) {
  if (el.parentElement === mainEl || !mainEl?.contains(el)) return
  const item = el as HTMLElement
  let block: Element = el
  while (block.parentElement && block.parentElement !== mainEl) block = block.parentElement
  item.style.removeProperty('--wb-new-at')
  const base = parseFloat(getComputedStyle(item).getPropertyValue('--wb-new-at')) || 14
  const indent = item.getBoundingClientRect().left - block.getBoundingClientRect().left
  item.style.setProperty('--wb-new-at', `${base + indent}px`)
}

function markNew(el: Element) {
  // a block that is quiet as a whole is never news
  if (el.matches('[data-wb-quiet]')) return
  el.classList.remove('wb-new-seen')
  el.classList.add('wb-new')
  placeBar(el)
  unseen.add(el)
  scheduleCheck()
}

// ---- navigator ---------------------------------------------------------------------------------

// the "new" toasts, in the page's corner (api.toast): one for what is new above, one for below,
// each going to the nearest; their ✕ counts everything new as seen. Their count is in the tab title.
let upToast: Toast | null = null
let downToast: Toast | null = null

function split() {
  const above: Element[] = [],
    below: Element[] = []
  for (const el of unseen) {
    if (!el.isConnected) {
      unseen.delete(el)
      continue
    }
    const r = el.getBoundingClientRect()
    if (r.bottom < 60) above.push(el)
    else if (r.top > viewBottom()) below.push(el)
  }
  const top = (el: Element) => el.getBoundingClientRect().top
  above.sort((a, b) => top(b) - top(a)) // nearest first
  below.sort((a, b) => top(a) - top(b))
  return { above, below }
}

let raf = 0
function update() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    const { above, below } = split()
    for (const [toast, list, arrow] of [
      [upToast, above, '↑'],
      [downToast, below, '↓'],
    ] as const) {
      if (!toast) continue
      if (list.length) {
        toast.update(`${arrow} new (${list.length})`)
        toast.show()
      } else toast.hide()
    }
    core?.badge('new', unseen.size ? String(unseen.size) : null)
  })
}

function go(dir: 'up' | 'down') {
  const { above, below } = split()
  ;(dir === 'up' ? above : below)[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const seeAll = () => {
  for (const el of [...unseen]) markSeen(el)
}
addEventListener('scroll', update, { passive: true })
addEventListener('resize', update)

// ---- entry points ------------------------------------------------------------------------------

/** Below this share of blocks recognised from the last visit, the page counts as new to the reader. */
const RECOGNISED_MIN = 0.25

/**
 * First render: blocks the reader has not seen on a previous visit are new. On a first visit, or
 * when so little is recognised that the page is effectively a different one (a rewrite, say),
 * nothing is marked: marking every block tells the reader nothing.
 */
export function trackInitial(main: HTMLElement, page: string, api: Api) {
  core = api
  upToast = api.toast('', {
    ms: 0,
    kind: 'alert',
    name: 'new-up',
    order: 1,
    onClick: () => go('up'),
    onDismiss: seeAll,
  })
  downToast = api.toast('', {
    ms: 0,
    kind: 'alert',
    name: 'new-down',
    order: 2,
    onClick: () => go('down'),
    onDismiss: seeAll,
  })
  upToast.hide()
  downToast.hide()
  mainEl = main
  storeKey = storageKey(`wb-seen:${page}`)
  const blocks = [...main.children]
  const sigs = blocks.map(signature)
  blocks.forEach((el, i) => sigOf.set(el, sigs[i]))
  const seen = loadSeen()
  const recognised = seen ? sigs.filter(s => seen.has(s)).length : 0
  if (seen && recognised >= blocks.length * RECOGNISED_MIN)
    blocks.forEach((el, i) => {
      if (!seen.has(sigs[i])) markNew(el)
    })
  saveSeen(main)
  update()
}

// ---- items --------------------------------------------------------------------------------------
// A list is often one block (the overview's pages, a long list on a page): one item new in it would
// mark the whole list. In a block that changed, the items whose content was not on the page before
// are what is new, and only they are marked; the block only when no item of it is new (what changed
// is outside its lists, or an item went).

/** An item's signature: its content, not its own attributes (its place in a sort) nor the times shown in it. */
function itemSignature(li: Element) {
  const clone = li.cloneNode(true) as Element
  for (const { name } of [...clone.attributes]) clone.removeAttribute(name)
  for (const t of clone.querySelectorAll('time[data-ts]')) t.textContent = ''
  return signature(clone)
}

/** The page's list items, but those in something quiet. */
const itemsOf = (root: Element) => [...root.querySelectorAll('li')].filter(li => !li.closest('[data-wb-quiet]'))

/** How many of each item signature are on the page: what the next update compares with. */
let itemsBefore = new Map<string, number>()
export function countItems(main: HTMLElement) {
  mainEl = main
  itemsBefore = new Map()
  for (const li of itemsOf(main)) {
    const sig = itemSignature(li)
    itemsBefore.set(sig, (itemsBefore.get(sig) ?? 0) + 1)
  }
}

/** The new items in a block that changed: the innermost ones, as an item new inside makes its parent differ too. */
function newItems(block: Element, before: Map<string, number>) {
  const fresh = itemsOf(block).filter(li => {
    const sig = itemSignature(li)
    const left = before.get(sig) ?? 0
    if (left > 0) before.set(sig, left - 1)
    return left === 0
  })
  return fresh.filter(li => !fresh.some(other => other !== li && li.contains(other)))
}

/** After a live update: blocks whose content was not on the page before are new, or in a list, the items. */
export function trackUpdate(main: HTMLElement, previous: string[], next: string[]) {
  const before = new Map<string, number>()
  for (const s of previous) before.set(s, (before.get(s) ?? 0) + 1)
  const items = new Map(itemsBefore)
  const blocks = [...main.children]
  blocks.forEach((el, i) => {
    const sig = next[i]
    sigOf.set(el, sig)
    const left = before.get(sig) ?? 0
    if (left > 0) return before.set(sig, left - 1)
    const fresh = newItems(el, items)
    if (fresh.length) fresh.forEach(markNew)
    else markNew(el)
  })
  countItems(main)
  for (const el of [...unseen]) if (!el.isConnected) unseen.delete(el)
  for (const el of unseen) placeBar(el)
  saveSeen(main)
  update()
}
