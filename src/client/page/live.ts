// The dot at the end of the header: is the page live, and does an agent take its answers? Green: the
// live channel is open and a wait or watch covers the page (one with --page on it or above it, or
// the project-wide one without --page). Grey: live, but no agent listens, so answers wait in the
// log. A ring: not connected, the page may be out of date (the core reconnects and catches up).
// What it says on hover tells them apart. Only the overview and folders have no answers: there it
// says only whether the page is live.
import type { Api, PageHandle } from '../../define.ts'

export function trackLive(root: HTMLElement, handle: PageHandle, api: Api) {
  const dot = root.querySelector<HTMLElement>('.wb-live')
  if (!dot) return
  const hasAnswers = handle.kind === 'page' || handle.kind === 'file'
  const show = () => {
    const live = document.documentElement.hasAttribute('data-wb-live')
    const listeners = hasAnswers ? api.listeners() : []
    const own = listeners.some(l => !l.fallback)
    const anyPage = listeners.some(l => l.fallback)
    const agent = live && (own || anyPage)
    dot.toggleAttribute('data-agent', agent)
    dot.title = !live ? 'Reconnecting… the page may be out of date'
      : !hasAnswers ? 'Live'
      : own ? 'Live · an agent is listening on this page'
      : anyPage ? 'Live · an agent is listening on every page'
      : 'Live · no agent is listening right now; answers wait in the log'
    dot.setAttribute('aria-label', dot.title)
  }
  api.listeners.on(show)
  new MutationObserver(show).observe(document.documentElement, { attributes: true, attributeFilter: ['data-wb-live'] })
  show()
}
