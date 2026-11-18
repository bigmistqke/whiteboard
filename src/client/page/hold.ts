// What the reader is typing in stays where it is on screen. While a field on the page has the focus,
// its place is noted; when anything on the page changes around it (a message arrives above a chat's
// box, a block comes in above a form, a thread grows) and it moved without the reader scrolling,
// the page scrolls by as much, so the box doesn't slide away mid-word. The reader's own scrolling
// sets the new place.

const typing = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && (el.matches('input:not([type=radio], [type=checkbox], [type=button], [type=submit]), textarea, select, [contenteditable]'))

let held: HTMLElement | null = null
let top = 0
let frame = 0

function note() {
  const el = document.activeElement
  held = typing(el) ? el : null
  if (held) top = held.getBoundingClientRect().top
}

function hold() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (!held || document.activeElement !== held || !held.isConnected) return note()
    const moved = held.getBoundingClientRect().top - top
    if (Math.abs(moved) >= 1) scrollBy(0, moved)
    top = held.getBoundingClientRect().top
  })
}

export function trackHold() {
  document.addEventListener('focusin', note)
  document.addEventListener('focusout', () => queueMicrotask(note))
  // the reader scrolled (or the page did, to keep it): that is the place now
  addEventListener('scroll', () => { if (held) top = held.getBoundingClientRect().top }, { passive: true })
  new MutationObserver(hold).observe(document.body, { childList: true, subtree: true, characterData: true })
  addEventListener('resize', note)
}
