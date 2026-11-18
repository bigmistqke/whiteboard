// A list the reader can sort: a `<select data-wb-sort="<name>">` sorts the `ul` after its heading
// by what each `li` carries (`data-order`, `data-updated`, `data-title`: the overview's documents).
// The choice is kept per list in this browser, and put back after a live update, which writes the
// list again in the server's order.
const KEY = (name: string) => `wb-sort:${name}`

function sortList(select: HTMLSelectElement) {
  const list = select.closest('section')?.querySelector('ul')
  if (!list) return
  const by = select.value
  const value = (li: HTMLElement) =>
    by === 'title' ? (li.dataset.title ?? '') : Number(by === 'updated' ? li.dataset.updated : li.dataset.order)
  const rows = [...list.children] as HTMLElement[]
  rows.sort((a, b) => {
    const x = value(a),
      y = value(b)
    if (by === 'updated') return (y as number) - (x as number)
    return typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)
  })
  list.append(...rows)
}

export function applySorts() {
  for (const select of document.querySelectorAll<HTMLSelectElement>('select[data-wb-sort]')) {
    let kept: string | null = null
    try {
      kept = localStorage.getItem(KEY(select.dataset.wbSort!))
    } catch {
      /* private window */
    }
    if (kept && [...select.options].some(o => o.value === kept)) select.value = kept
    sortList(select)
  }
}

export function trackSorts() {
  document.addEventListener('change', e => {
    const select = e.target as HTMLSelectElement
    if (!select.matches?.('select[data-wb-sort]')) return
    try {
      localStorage.setItem(KEY(select.dataset.wbSort!), select.value)
    } catch {
      /* private window */
    }
    sortList(select)
  })
  applySorts()
}
