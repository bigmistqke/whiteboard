// New-content tracking. A top-level block of the page is "new" when its content was not on the
// page last time the reader saw it: since the previous live update, or since their previous
// visit (remembered per page in localStorage). New blocks get .wb-new (a left border) until they
// have been in view for a moment with the tab visible. Floating buttons jump to unseen blocks.

const DWELL_MS = 600
const FADE_MS = 2500

const sigOf = new WeakMap<Element, string>()
const unseen = new Set<Element>()
const timers = new WeakMap<Element, number>()
let storeKey = ''
let baseTitle = document.title

/**
 * FNV-1a over the block's HTML, ignoring per-render attributes and anything quiet: content inside
 * [data-wb-quiet] can appear, change or go without the block counting as changed.
 */
export function signature(el: Element): string {
  const clone = el.cloneNode(true) as Element
  for (const q of clone.querySelectorAll('[data-wb-quiet]')) q.remove()
  for (const n of [clone, ...clone.querySelectorAll('[data-wb-island],[data-wb-mounted]')]) {
    n.removeAttribute('data-wb-island')
    n.removeAttribute('data-wb-mounted')
  }
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
  } catch { return null }
}

function saveSeen(main: HTMLElement) {
  try {
    const seen = [...main.children].filter(el => !unseen.has(el)).map(el => sigOf.get(el)).filter(Boolean)
    localStorage.setItem(storeKey, JSON.stringify(seen))
  } catch { /* storage unavailable: tracking still works for this visit */ }
}

// ---- seen detection ----------------------------------------------------------------------------
// Measured directly on scroll, resize and tab switches (and every half second while anything is
// unseen, since layout also moves without scrolling). An IntersectionObserver only reports at fixed
// fractions of a block's own height, which a block taller than twice the screen never reaches.

let mainEl: HTMLElement

/** In view enough to count as read: half the block, or half the screen for blocks taller than that. */
function inView(el: Element) {
  const r = el.getBoundingClientRect()
  const overlap = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)
  return overlap > 0 && overlap >= Math.min(r.height, innerHeight) * 0.5
}

/** Start the dwell timer of unseen blocks in view; stop it for blocks that left the view. */
function check() {
  const active = document.visibilityState === 'visible'
  for (const el of unseen) {
    if (!el.isConnected) { unseen.delete(el); continue }
    const pending = timers.has(el)
    if (active && inView(el)) {
      if (!pending) timers.set(el, window.setTimeout(() => { timers.delete(el); markSeen(el) }, DWELL_MS))
    } else if (pending) {
      clearTimeout(timers.get(el))
      timers.delete(el)
    }
  }
}

let checkFrame = 0
const scheduleCheck = () => { cancelAnimationFrame(checkFrame); checkFrame = requestAnimationFrame(check) }
addEventListener('scroll', scheduleCheck, { passive: true })
addEventListener('resize', scheduleCheck)
document.addEventListener('visibilitychange', scheduleCheck)
setInterval(() => { if (unseen.size) check() }, 500)

function markSeen(el: Element) {
  if (!unseen.delete(el)) return
  el.classList.add('wb-new-seen')
  setTimeout(() => el.classList.remove('wb-new', 'wb-new-seen'), FADE_MS)
  saveSeen(mainEl)
  update()
}

function markNew(el: Element) {
  // a block that is quiet as a whole is never news
  if (el.matches('[data-wb-quiet]')) return
  el.classList.remove('wb-new-seen')
  el.classList.add('wb-new')
  unseen.add(el)
  scheduleCheck()
}

// ---- navigator ---------------------------------------------------------------------------------

/** The floating buttons at the bottom right: what waits for the reader, then what is new. */
export const dock = document.createElement('div')
dock.className = 'wb-dock'

let titlePrefix = ''
/** A prefix for the tab title, in front of the new-content count: what waits for the reader. */
export function setTitlePrefix(prefix: string) {
  titlePrefix = prefix
  update()
}

const nav = document.createElement('div')
nav.className = 'wb-fresh'
dock.append(nav)
nav.innerHTML = ['up', 'down'].map(dir =>
  `<button type="button" data-dir="${dir}"><span class="wb-fresh-label"></span><span class="wb-fresh-close" title="Mark everything new as seen" aria-label="Mark everything new as seen">✕</span></button>`).join('')
const [upBtn, downBtn] = nav.querySelectorAll('button')
// hidden until the first update has counted: it runs in an animation frame, which a hidden tab
// does not get, so until then the bubbles would show without their labels
nav.hidden = upBtn.hidden = downBtn.hidden = true

function split() {
  const above: Element[] = [], below: Element[] = []
  for (const el of unseen) {
    if (!el.isConnected) { unseen.delete(el); continue }
    const r = el.getBoundingClientRect()
    if (r.bottom < 60) above.push(el)
    else if (r.top > innerHeight) below.push(el)
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
    upBtn.hidden = !above.length
    downBtn.hidden = !below.length
    upBtn.querySelector('.wb-fresh-label')!.textContent = `↑ new (${above.length})`
    downBtn.querySelector('.wb-fresh-label')!.textContent = `↓ new (${below.length})`
    nav.hidden = !above.length && !below.length
    document.title = `${titlePrefix}${unseen.size ? `(${unseen.size}) ` : ''}${baseTitle}`
  })
}

nav.addEventListener('click', e => {
  const dir = (e.target as HTMLElement).closest('button')?.dataset.dir
  if (!dir) return
  // the ✕ in a bubble clicks the marks away: everything new counts as seen
  if ((e.target as HTMLElement).closest('.wb-fresh-close')) { for (const el of [...unseen]) markSeen(el); return }
  const { above, below } = split()
  ;(dir === 'up' ? above : below)[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
})
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
export function trackInitial(main: HTMLElement, page: string) {
  mainEl = main
  storeKey = `wb-seen:${page}`
  baseTitle = document.title
  document.body.append(dock)
  const blocks = [...main.children]
  const sigs = blocks.map(signature)
  blocks.forEach((el, i) => sigOf.set(el, sigs[i]))
  const seen = loadSeen()
  const recognised = seen ? sigs.filter(s => seen.has(s)).length : 0
  if (seen && recognised >= blocks.length * RECOGNISED_MIN)
    blocks.forEach((el, i) => { if (!seen.has(sigs[i])) markNew(el) })
  saveSeen(main)
  update()
}

/** After a live update: blocks whose content was not on the page before are new. */
export function trackUpdate(main: HTMLElement, previous: string[], next: string[], title: string) {
  baseTitle = title
  const before = new Map<string, number>()
  for (const s of previous) before.set(s, (before.get(s) ?? 0) + 1)
  const blocks = [...main.children]
  blocks.forEach((el, i) => {
    const sig = next[i]
    sigOf.set(el, sig)
    const left = before.get(sig) ?? 0
    if (left > 0) before.set(sig, left - 1)
    else markNew(el)
  })
  for (const el of [...unseen]) if (!el.isConnected) unseen.delete(el)
  saveSeen(main)
  update()
}
