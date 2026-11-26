// The reader's place stays where it is on screen, whatever changes around it: a page update, a chat
// message drawn by its island above them, a block's markdown or diagram drawn after it showed. The
// place is one element: the field the reader is typing in, if any, else the innermost element at the
// top of the view, below the header. Whenever anything on the page changes or resizes and it moved
// without the reader scrolling, the page scrolls by as much. The reader's own scrolling sets the
// new place. At the very top of the page there is no place to keep: what comes in above shows.
//
// What the reader is on comes before the top of the view: the field they type in, or the control
// they last used (a radio they clicked in the form they answer, which WebKit doesn't focus), while
// it is in view. Otherwise a form answered above them would be the place, and what changes in it (a
// reply in its chat, it folding) would move the form they are in.
//
// This is the browser's scroll anchoring, done by the page: WebKit has none, and Chromium's loses its
// anchor when an update replaces elements, so the browser's own is turned off to keep the two from
// both correcting. A page update replaces the blocks it changed; the place in one is found again in
// its new render, by where it was in the block (see `beforeUpdate`).

type Sigs = string[]
interface Place {
  el: Element
  top: number
  /** where the page was scrolled to then: scrolled since, by the reader, before its scroll event */
  scrolled: number
  /**
   * The elements around it up to its block, and where each was: should something take the place
   * out of the page (an island that draws its content again), the nearest one still there is held
   * instead, so what moved with it is put back all the same
   */
  around: { el: Element; top: number }[]
}

let main: HTMLElement
let place: Place | null = null
/** The control of the page the reader last clicked or changed. */
let used: Element | null = null

const typing = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement &&
  el.matches(
    'input:not([type=radio], [type=checkbox], [type=button], [type=submit]), textarea, select, [contenteditable]',
  )

/** Laid out: not inside a closed <details> or otherwise not drawn. */
const shown = (el: Element) => el.isConnected && el.getClientRects().length > 0

/** The top of the view, below the header (which sticks there). */
function viewTop() {
  return Math.max(0, document.querySelector('.wb-nav')?.getBoundingClientRect().bottom ?? 0)
}

/** A sticky title (an open details' summary) stays at the top while what is under it moves: never the place. */
const stuck = (el: Element) => {
  const position = getComputedStyle(el).position
  return position === 'sticky' || position === 'fixed'
}

/** The innermost element at the top of the view: the first one reaching below it, and inside it, the same. */
function atTop(): Element | null {
  const y = viewTop()
  let found: Element | null = null
  for (let parent: Element = main; ;) {
    const next = [...parent.children].find(c => {
      if (stuck(c)) return false
      const r = c.getBoundingClientRect()
      return r.height > 0 && r.bottom > y
    })
    if (!next) return found
    found = next
    // below the top already: it is the first thing in view
    if (next.getBoundingClientRect().top >= y) return found
    parent = next
  }
}

/** The elements around `el` in the page's content, innermost first, and where each is now. */
function aroundOf(el: Element) {
  const around: Place['around'] = []
  for (let at = el.parentElement; at && at !== main && main.contains(at); at = at.parentElement)
    around.push({ el: at, top: at.getBoundingClientRect().top })
  return around
}

const placeAt = (el: Element, top = el.getBoundingClientRect().top): Place => ({
  el,
  top,
  scrolled: scrollY,
  around: aroundOf(el),
})

/** In view, below the header: some of it between the top of the view and its bottom. */
function inView(el: Element) {
  const r = el.getBoundingClientRect()
  return r.bottom > viewTop() && r.top < innerHeight
}

/** What the reader is on: the field they type in, else the control they last used, while in view. */
function onNow(): Element | null {
  const focused = document.activeElement
  if (typing(focused)) return focused
  for (const el of [focused, used])
    if (el instanceof HTMLElement && el !== document.body && main.contains(el) && shown(el) && inView(el)) return el
  return null
}

function pick() {
  const el = onNow() ?? (scrollY > 0 ? atTop() : null)
  place = el ? placeAt(el) : null
}

/** Put the place back where it was on screen, if it moved; then it is where it is. */
function keep() {
  if (!place || place.scrolled !== scrollY) return pick()
  if (!shown(place.el)) {
    // gone from the page (drawn again): the nearest element around it that is still there, put
    // back where it was, then a place afresh. Hidden (a details closed): nothing to keep
    const held = place.el.isConnected ? null : place.around.find(a => shown(a.el))
    if (held) {
      const moved = held.el.getBoundingClientRect().top - held.top
      if (Math.abs(moved) >= 1) scrollBy(0, moved)
    }
    return pick()
  }
  const moved = place.el.getBoundingClientRect().top - place.top
  // moves of less than a pixel left be, but not forgotten: they would add up
  if (Math.abs(moved) >= 1) {
    scrollBy(0, moved)
    place.scrolled = scrollY
    // the page can't scroll that far (its end): where it is is the place now
    const now = place.el.getBoundingClientRect().top
    if (Math.abs(now - place.top) >= 1) place.top = now
  }
  // what is around it may have moved apart from it: where each is now
  place.around = aroundOf(place.el)
}

/** The top-level block an element is in, and the way down to it: the index of each child taken. */
function pathOf(el: Element) {
  const path: number[] = []
  let at = el
  while (at.parentElement && at.parentElement !== main) {
    path.unshift([...at.parentElement.children].indexOf(at))
    at = at.parentElement
  }
  return at.parentElement === main ? { block: [...main.children].indexOf(at), path } : null
}

/** Which of the blocks with its signature block `i` is. */
const nthOf = (sigs: Sigs, i: number) => sigs.slice(0, i).filter(s => s === sigs[i]).length
/** The index of the `nth` block with signature `sig`, or -1. */
function indexOf(sigs: Sigs, sig: string, nth: number) {
  let seen = 0
  return sigs.findIndex(s => s === sig && seen++ === nth)
}

/**
 * Before a page update that turns blocks with signatures `from` into `to`: note the place, and how to
 * find it if the update replaces it. Call what it returns once the update is in.
 */
export function beforeUpdate(from: Sigs, to: Sigs): () => void {
  // a focused element the update takes (a button clicked, a field) stays where it is too
  const focused = document.activeElement
  if (focused instanceof HTMLElement && focused !== document.body && main.contains(focused)) place = placeAt(focused)
  else pick()
  const before = place
  const at = before && main.contains(before.el) ? pathOf(before.el) : null
  const blockTop = at ? main.children[at.block].getBoundingClientRect().top : 0
  return () => {
    if (!before) return pick()
    if (before.el.isConnected) {
      place = before
      return keep()
    }
    // replaced, the field with the focus: the one it went to
    const now = document.activeElement
    if (before.el === focused && now instanceof HTMLElement && now !== document.body && main.contains(now)) {
      place = { ...placeAt(now, before.top), scrolled: before.scrolled }
      return keep()
    }
    if (!at) return pick()
    // its block, in the new render: the same block if the update kept it, else the block in its
    // place, counted from the kept block before it
    const keptTo = new Set(to)
    let block = keptTo.has(from[at.block]) ? indexOf(to, from[at.block], nthOf(from, at.block)) : -1
    if (block < 0) {
      let prev = at.block - 1
      while (prev >= 0 && !keptTo.has(from[prev])) prev--
      const base = prev < 0 ? -1 : indexOf(to, from[prev], nthOf(from, prev))
      if (prev < 0 || base >= 0) block = base + (at.block - prev)
    }
    const el = main.children[block]
    if (!el) return pick()
    // down the same way, as far as it goes
    let target: Element = el
    let whole = true
    for (const i of at.path) {
      const child = target.children[i]
      if (!child) {
        whole = false
        break
      }
      target = child
    }
    place = { ...(whole ? placeAt(target, before.top) : placeAt(el, blockTop)), scrolled: before.scrolled }
    keep()
  }
}

export function trackPlace(root: HTMLElement) {
  main = root
  document.documentElement.style.overflowAnchor = 'none'
  // the reader scrolled: the place now. The page's own scrolling, to keep it, is not the reader's:
  // its scroll event comes later, when more can have moved, which is kept as well (see `keep`)
  addEventListener('scroll', keep, { passive: true })
  // typed somewhere else, a control used, or resized: the place now
  addEventListener('resize', pick)
  const use = (e: Event) => {
    const el = e.target instanceof Element ? e.target.closest('input, button, select, textarea, label, summary') : null
    if (!el || !main.contains(el)) return
    // a label stands for its control, unless the control is not drawn (a styled one)
    used = el instanceof HTMLLabelElement && el.control && shown(el.control) ? el.control : el
    pick()
  }
  document.addEventListener('click', use, true)
  document.addEventListener('change', use, true)
  document.addEventListener('focusin', pick)
  document.addEventListener('focusout', () => queueMicrotask(pick))
  // anything changed: before it is drawn, the place back where it was, and for a few frames after,
  // as what changed can lay out again later (a transition, a module that draws once it loaded)
  let frames = 0
  let frame = 0
  const follow = () => {
    keep()
    frame = --frames > 0 ? requestAnimationFrame(follow) : 0
  }
  const changed = () => {
    keep()
    frames = 30
    if (!frame) frame = requestAnimationFrame(follow)
  }
  new MutationObserver(changed).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  })
  // what resizes without a change to the page: a stylesheet, an image or a font that loaded. Not a
  // ResizeObserver on the page: as an ancestor of the plugins' own, it would miss the sizes they
  // change in theirs, and WebKit reports a loop
  document.addEventListener('load', changed, true)
  document.fonts?.addEventListener('loadingdone', changed)
  pick()
}
