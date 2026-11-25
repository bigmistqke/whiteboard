// An open <details>'s summary stays at the top while its content is read, below the page's header;
// a summary of details inside details stacks below the summaries of the details around it. CSS
// makes them sticky (base.css); this says how far from the top each sticks: the header's height,
// then each open summary around it, measured, as a summary can take more than one line. Measured
// again when a details opens or closes, the window resizes, or the page updates. Closing a details by
// its title while the title is stuck (its start is above the view) scrolls back to it, so the
// reader lands at the title, not somewhere far below where the content was.

function place(body: HTMLElement) {
  const nav = document.querySelector<HTMLElement>('.wb-nav')
  const base = nav ? nav.getBoundingClientRect().height : 0
  for (const summary of body.querySelectorAll<HTMLElement>('details > summary')) {
    let top = base,
      depth = 0
    for (
      let d = summary.parentElement!.parentElement?.closest('details');
      d && body.contains(d);
      d = d.parentElement?.closest('details')
    ) {
      const outer = d.querySelector<HTMLElement>(':scope > summary')
      if (outer && d.open) top += outer.getBoundingClientRect().height
      depth++
    }
    summary.style.setProperty('--wb-sticky-top', `${top}px`)
    // an inner summary that scrolls away goes under the ones around it, all under the header
    summary.style.setProperty('--wb-sticky-z', String(Math.max(1, 4 - depth)))
  }
}

/** A click on a stuck title: once its details has closed, the title where it was stuck. */
function keepTitle(e: MouseEvent) {
  const summary = (e.target as HTMLElement).closest?.('summary')
  const details = summary?.parentElement
  if (!summary || !(details instanceof HTMLDetailsElement) || !details.open) return
  const top = parseFloat(summary.style.getPropertyValue('--wb-sticky-top')) || 0
  // stuck: the details starts above where its title is held
  if (details.getBoundingClientRect().top >= top - 1) return
  requestAnimationFrame(() => scrollBy({ top: details.getBoundingClientRect().top - top }))
}

export function trackSticky(main: HTMLElement, onRendered: (fn: () => void) => void) {
  // the reading area: the content and the lists after it (a page without one: the content alone)
  const body = main.closest<HTMLElement>('.wb-body') ?? main
  body.addEventListener('click', keepTitle)
  let frame = 0
  const later = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => place(body))
  }
  // toggle doesn't bubble: listened for on the way down
  body.addEventListener('toggle', later, true)
  addEventListener('resize', later)
  onRendered(later)
  // a list after the content draws itself again as the log changes (chats no longer on the page),
  // and its summary with it: measured again then too
  new MutationObserver(later).observe(body, { childList: true, subtree: true })
  place(body)
}
