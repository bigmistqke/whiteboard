// New-content tracking. A top-level block of the page is "new" when its content was not on the
// page last time the reader saw it: since the previous live update, or since their previous
// visit (remembered per page in localStorage). New blocks get .vz-new (a left border) until they
// have been in view for a moment with the tab visible. Floating buttons jump to unseen blocks.

const DWELL_MS = 600
const FADE_MS = 2500

const sigOf = new WeakMap<Element, string>()
const unseen = new Set<Element>()
const visible = new Set<Element>()
const timers = new WeakMap<Element, number>()
let storeKey = ''
let baseTitle = document.title

/** FNV-1a over the block's HTML, ignoring per-render attributes. */
export function signature(el: Element): string {
  const clone = el.cloneNode(true) as Element
  for (const n of [clone, ...clone.querySelectorAll('[data-vz-island],[data-vz-mounted]')]) {
    n.removeAttribute('data-vz-island')
    n.removeAttribute('data-vz-mounted')
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

let mainEl: HTMLElement

const observer = new IntersectionObserver(entries => {
  for (const e of entries) {
    // half the block, or half the viewport for blocks taller than it
    const enough = e.intersectionRatio >= 0.5 || e.intersectionRect.height >= innerHeight * 0.5
    if (e.isIntersecting && enough) visible.add(e.target)
    else visible.delete(e.target)
    schedule(e.target)
  }
}, { threshold: [0, 0.25, 0.5, 0.75, 1] })

function schedule(el: Element) {
  clearTimeout(timers.get(el))
  if (!unseen.has(el) || !visible.has(el) || document.visibilityState !== 'visible') return
  timers.set(el, window.setTimeout(() => markSeen(el), DWELL_MS))
}

function markSeen(el: Element) {
  if (!unseen.delete(el)) return
  observer.unobserve(el)
  el.classList.add('vz-new-seen')
  setTimeout(() => el.classList.remove('vz-new', 'vz-new-seen'), FADE_MS)
  saveSeen(mainEl)
  update()
}

document.addEventListener('visibilitychange', () => { for (const el of unseen) schedule(el) })

function markNew(el: Element) {
  el.classList.remove('vz-new-seen')
  el.classList.add('vz-new')
  unseen.add(el)
  observer.observe(el)
}

// ---- navigator ---------------------------------------------------------------------------------

const nav = document.createElement('div')
nav.className = 'vz-fresh'
nav.innerHTML = '<button type="button" data-dir="up"></button><button type="button" data-dir="down"></button>'
const [upBtn, downBtn] = nav.querySelectorAll('button')

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
    upBtn.textContent = `↑ new (${above.length})`
    downBtn.textContent = `↓ new (${below.length})`
    nav.hidden = !above.length && !below.length
    document.title = unseen.size ? `(${unseen.size}) ${baseTitle}` : baseTitle
  })
}

nav.addEventListener('click', e => {
  const dir = (e.target as HTMLElement).closest('button')?.dataset.dir
  if (!dir) return
  const { above, below } = split()
  ;(dir === 'up' ? above : below)[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
})
addEventListener('scroll', update, { passive: true })
addEventListener('resize', update)

// ---- entry points ------------------------------------------------------------------------------

/** First render: blocks the reader has not seen on a previous visit are new. */
export function trackInitial(main: HTMLElement, page: string) {
  mainEl = main
  storeKey = `vz-seen:${page}`
  baseTitle = document.title
  document.body.append(nav)
  const blocks = [...main.children]
  const sigs = blocks.map(signature)
  blocks.forEach((el, i) => sigOf.set(el, sigs[i]))
  const seen = loadSeen()
  if (seen) blocks.forEach((el, i) => { if (!seen.has(sigs[i])) markNew(el) })
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
