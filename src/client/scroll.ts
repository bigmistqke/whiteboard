// An agent shows the reader a place on the page (`whiteboard scroll <page> <where>`): the live
// channel says where, and the page goes there. `where` is, in this order: a heading whose text it
// is (or, failing that, contains), a form of that name, an element with that id, or the first text
// that contains it. A <details> around it opens; it is scrolled to just below the header and the
// titles of open details that stick above it, and lit up a moment, so the eye finds it.

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export function findTarget(root: ParentNode, where: string): HTMLElement | null {
  const want = norm(where)
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, summary')]
  const heading =
    headings.find(h => norm(h.textContent ?? '') === want) ??
    headings.find(h => norm(h.textContent ?? '').includes(want))
  if (heading) return heading
  const byName = [...root.querySelectorAll<HTMLElement>('form[name]')].find(
    f => f.getAttribute('name') === where.trim(),
  )
  if (byName) return byName
  const byId = root.querySelector<HTMLElement>(`#${CSS.escape(where.trim())}`)
  if (byId) return byId
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (norm(n.textContent ?? '').includes(want) && n.parentElement && !n.parentElement.closest('script, style'))
      return n.parentElement
  }
  return null
}

export function scrollToTarget(root: ParentNode, where: string): boolean {
  const target = findTarget(root, where)
  if (!target) return false
  // a <details> around it opens (a summary's own details stays as it is)
  for (
    let d = (target.tagName === 'SUMMARY' ? target.parentElement?.parentElement : target)?.closest('details');
    d;
    d = d.parentElement?.closest('details')
  )
    d.open = true
  requestAnimationFrame(() => {
    // below the header, and below the titles of the open details around it, which stick
    let offset = (document.querySelector<HTMLElement>('.wb-nav')?.getBoundingClientRect().height ?? 0) + 12
    for (let d = target.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) {
      const summary = d.querySelector<HTMLElement>(':scope > summary')
      if (summary && summary !== target) offset += summary.getBoundingClientRect().height
    }
    scrollTo({ top: Math.max(0, scrollY + target.getBoundingClientRect().top - offset), behavior: 'smooth' })
    target.classList.remove('wb-flash')
    void target.offsetWidth
    target.classList.add('wb-flash')
    setTimeout(() => target.classList.remove('wb-flash'), 2000)
  })
  return true
}
