// An open <details>'s summary stays at the top while its content is read, below the page's header;
// a summary of details inside details stacks below the summaries of the details around it. CSS
// makes them sticky (base.css); this says how far from the top each sticks: the header's height,
// then each open summary around it, measured, as a summary can take more than one line. Measured
// again when a details opens or closes, the window resizes, or the page updates. Closing a details by
// its title while the title is stuck (its start is above the view) scrolls back to it, so the
// reader lands at the title, not somewhere far below where the content was.

function place(main: HTMLElement) {
  const nav = document.querySelector<HTMLElement>('.wb-nav')
  const base = nav ? nav.getBoundingClientRect().height : 0
  for (const summary of main.querySelectorAll<HTMLElement>('details > summary')) {
    let top = base, depth = 0
    for (let d = summary.parentElement!.parentElement?.closest('details'); d && main.contains(d); d = d.parentElement?.closest('details')) {
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
  main.addEventListener('click', keepTitle)
  let frame = 0
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => place(main)) }
  // toggle doesn't bubble: listened for on the way down
  main.addEventListener('toggle', later, true)
  addEventListener('resize', later)
  onRendered(later)
  place(main)
}
