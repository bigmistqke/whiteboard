// The lightbox in the browser (index.ts): a click on a picture inside a container marked
// `data-lightbox` opens it large, over the page, with the container's other pictures and videos to
// step through (‹ ›, ← →); Esc or a click beside it closes it. It lives outside the page's content,
// so the page's updates leave it as it is.
import type { PluginMount } from '../../src/define'

const icon = (d: string) =>
  `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
const PREV = icon('M10 3.5 5.5 8l4.5 4.5')
const NEXT = icon('M6 3.5 10.5 8 6 12.5')
const CLOSE = icon('M4 4l8 8M12 4l-8 8')

/** What the lightbox shows of a container: its pictures and videos, in order; not a picture that is a link. */
const mediaIn = (scope: Element) =>
  [...scope.querySelectorAll<HTMLImageElement | HTMLVideoElement>('img, video')].filter(
    m => !m.closest('a, .wb-window-bar, .wb-lightbox'),
  )

let overlay: HTMLElement | null = null
let items: (HTMLImageElement | HTMLVideoElement)[] = []
let at = 0

function show() {
  if (!overlay) return
  const item = items[at]!
  const stage = overlay.querySelector('.wb-lightbox-stage')!
  let shown: HTMLElement
  if (item instanceof HTMLVideoElement) {
    const video = item.cloneNode(true) as HTMLVideoElement
    video.controls = true
    video.removeAttribute('autoplay')
    shown = video
  } else {
    const img = document.createElement('img')
    img.src = item.currentSrc || item.src
    img.alt = item.alt
    shown = img
  }
  stage.replaceChildren(shown)
  overlay.querySelector('.wb-lightbox-caption')!.textContent =
    (item instanceof HTMLImageElement ? item.alt : item.getAttribute('aria-label')) ?? ''
  for (const button of overlay.querySelectorAll<HTMLElement>('.wb-lightbox-prev, .wb-lightbox-next'))
    button.hidden = items.length < 2
}

function open(scope: Element, picture: HTMLImageElement) {
  items = mediaIn(scope)
  at = Math.max(0, items.indexOf(picture))
  overlay?.remove()
  overlay = document.createElement('div')
  overlay.className = 'wb-lightbox'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.innerHTML = `<div class="wb-lightbox-stage"></div><div class="wb-lightbox-caption"></div>
    <button type="button" class="wb-lightbox-prev" aria-label="Previous">${PREV}</button>
    <button type="button" class="wb-lightbox-next" aria-label="Next">${NEXT}</button>
    <button type="button" class="wb-lightbox-close" aria-label="Close">${CLOSE}</button>`
  overlay.addEventListener('click', e => {
    const target = e.target as Element
    if (target.closest('.wb-lightbox-prev')) step(-1)
    else if (target.closest('.wb-lightbox-next')) step(1)
    else if (target.closest('.wb-lightbox-close') || target === overlay || target.matches('.wb-lightbox-stage')) close()
  })
  place?.append(overlay)
  show()
}

function step(by: number) {
  if (items.length < 2) return
  at = (at + by + items.length) % items.length
  show()
}

function close() {
  overlay?.remove()
  overlay = null
}

/** Where an open lightbox goes: this plugin's element in the overlay slot. */
let place: HTMLElement | null = null

let listening = false
const mount: PluginMount = (_root, _page, api) => {
  api.slot('overlay', el => {
    place = el
    return () => {
      close()
      place = null
    }
  })
  if (listening) return
  listening = true
  document.addEventListener('click', e => {
    const picture = (e.target as Element).closest?.('img')
    const scope = picture?.closest('[data-lightbox]')
    if (!picture || !scope || !place || picture.closest('a, .wb-lightbox')) return
    e.preventDefault()
    open(scope, picture)
  })
  document.addEventListener('keydown', e => {
    if (!overlay) return
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
    else return
    e.preventDefault()
  })
}
export default mount
