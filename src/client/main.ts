// Page runtime: mounts template islands, records named form submits, live-reloads.
// Framework-free: an island's client module exports mount(element, props, api) (see define.ts).
import morphdom from 'morphdom'
import { api, page, loadEvents, submit, setThemePreference, themePreference, type ThemePreference } from './api'
import { signature, signaturesOf, trackInitial, trackUpdate } from './fresh'
import type { Mount } from '../define'

interface Island { template: string; client: string; props: unknown }

const main = document.getElementById('wb-main')!
const isDir = 'dir' in document.body.dataset
let islands: Record<string, Island> = JSON.parse(document.getElementById('wb-islands')?.textContent || '{}')
const disposers = new Map<Element, () => void>()
const lastSubmit = api.lastSubmit

// ---- islands -----------------------------------------------------------------------------------

async function mountOne(el: HTMLElement) {
  const island = islands[el.dataset.wbIsland!]
  el.dataset.wbMounted = ''
  if (!island) return
  try {
    const mod = await import(/* @vite-ignore */ `/@fs${island.client}`)
    if (!el.isConnected) return
    const mount: Mount = mod.default
    if (typeof mount !== 'function') throw new Error('the client module must export a mount(element, props, api) function as default')
    el.replaceChildren()
    const dispose = await mount(el, island.props, api)
    if (typeof dispose === 'function') disposers.set(el, dispose)
  } catch (err) {
    console.error(`island ${island.template}:`, err)
    el.insertAdjacentHTML('afterbegin', `<pre class="wb-error">template "${island.template}" failed to mount: ${String((err as Error).message)}</pre>`)
  }
}

/** Mount islands outermost first; nested islands show up once their parent has rendered. */
async function mountIslands(root: ParentNode = main) {
  for (;;) {
    const pending = [...root.querySelectorAll<HTMLElement>('[data-wb-island]:not([data-wb-mounted])')]
      .filter(el => !el.parentElement?.closest('[data-wb-island]:not([data-wb-mounted])'))
    if (!pending.length) return
    await Promise.all(pending.map(mountOne))
  }
}

function disposeWithin(node: Node) {
  for (const [el, dispose] of disposers) {
    if (node === el || node.contains(el)) { dispose(); disposers.delete(el) }
  }
}

// islands rendered later (after async loading inside a component) still get mounted
new MutationObserver(() => {
  if (main.querySelector('[data-wb-island]:not([data-wb-mounted])')) mountIslands()
}).observe(main, { childList: true, subtree: true })

// ---- forms -------------------------------------------------------------------------------------

type Data = Record<string, unknown>

function readForm(form: HTMLFormElement): Data {
  const data: Data = {}
  const elements = [...form.elements] as HTMLInputElement[]
  const boxes: Record<string, number> = {}
  for (const el of elements) if (el.name && el.type === 'checkbox') boxes[el.name] = (boxes[el.name] ?? 0) + 1
  for (const el of elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'file') continue
    if (el.type === 'checkbox') {
      if (boxes[el.name] > 1) { const list = (data[el.name] ??= []) as string[]; if (el.checked) list.push(el.value) }
      else data[el.name] = el.checked
    } else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value
      else data[el.name] ??= null
    } else if (el instanceof HTMLSelectElement && el.multiple) data[el.name] = [...el.selectedOptions].map(o => o.value)
    else data[el.name] = el.value
  }
  return data
}

function writeForm(form: HTMLFormElement, data: Data) {
  for (const el of [...form.elements] as HTMLInputElement[]) {
    if (!el.name || !(el.name in data) || ['submit', 'button', 'hidden', 'file'].includes(el.type)) continue
    const v = data[el.name]
    if (el.type === 'checkbox') el.checked = Array.isArray(v) ? v.includes(el.value) : !!v
    else if (el.type === 'radio') el.checked = v === el.value
    else el.value = v == null ? '' : String(v)
  }
}

/** Forms this runtime looks after: named, no action attribute (those submit normally). */
const managed = (form: HTMLFormElement) => !!form.getAttribute('name') && !form.hasAttribute('action')

// ---- drafts ------------------------------------------------------------------------------------
// What the reader typed and has not sent yet survives a reload of the page and a re-render of the
// form: it is kept per page and form in localStorage until the form is sent.

const draftKey = (form: HTMLFormElement) => `wb-draft:${page}:${form.getAttribute('name')}`

function saveDraft(e: Event) {
  const form = (e.target as Element | null)?.closest?.('form')
  if (!form || !managed(form)) return
  try { localStorage.setItem(draftKey(form), JSON.stringify(readForm(form))) } catch { /* storage unavailable */ }
}
document.addEventListener('input', saveDraft)
document.addEventListener('change', saveDraft)

/** Put unsent drafts back into their forms; a form being typed in is left alone. */
function restoreDrafts() {
  for (const form of main.querySelectorAll('form')) {
    if (!managed(form) || form.contains(document.activeElement)) continue
    let draft: Data | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey(form)) ?? 'null') } catch { /* storage unavailable */ }
    if (draft) writeForm(form, draft)
  }
}

const dropDraft = (form: HTMLFormElement) => { try { localStorage.removeItem(draftKey(form)) } catch { /* storage unavailable */ } }

/** Plain HTML forms get their last submission back; template forms handle this themselves. */
function restorePlainForms(prefill: boolean) {
  for (const form of main.querySelectorAll('form')) {
    if (!managed(form) || form.closest('[data-wb-island]')) continue
    const last = lastSubmit(form.getAttribute('name')!)
    if (!last) continue
    form.dataset.wbSent = last.action ?? ''
    if (prefill) writeForm(form, last.data)
  }
}

document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  if (!managed(form)) return
  e.preventDefault()
  const button = e.submitter as HTMLButtonElement | null
  const action = button ? button.value || button.textContent?.trim() || null : null
  form.dataset.wbState = 'sending'
  try {
    await submit(form.getAttribute('name')!, action, readForm(form))
    dropDraft(form)
    form.dataset.wbState = 'sent'
    form.dataset.wbSent = action ?? ''
  } catch (err) {
    form.dataset.wbState = 'failed'
    console.error(err)
  }
})

// ---- theme -------------------------------------------------------------------------------------

const themeButton = document.querySelector<HTMLButtonElement>('.wb-theme')
const NEXT: Record<ThemePreference, ThemePreference> = { auto: 'light', light: 'dark', dark: 'auto' }
if (themeButton) {
  themeButton.textContent = themePreference()
  themeButton.addEventListener('click', () => {
    setThemePreference(NEXT[themePreference()])
    themeButton.textContent = themePreference()
  })
}

// ---- time --------------------------------------------------------------------------------------

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}
function tickTimes() {
  for (const t of document.querySelectorAll<HTMLTimeElement>('time[data-ts]')) {
    const ts = Number(t.dataset.ts)
    t.textContent = ago(ts)
    t.title = new Date(ts).toLocaleString()
  }
}
setInterval(tickTimes, 15000)

// ---- live reload -------------------------------------------------------------------------------

let blockSigs: string[] = []

const FIELD = (n: Element): n is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
  n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement || n instanceof HTMLSelectElement
const KEEP_CLASSES = ['wb-new', 'wb-new-seen']

/** Patch the page in place: focus, caret, typed values, open <details> and unchanged islands survive. */
/**
 * A <details> element's identity across renders: its summary, the nearest heading above its
 * top-level block, and how many before it share both. Blocks are matched by position when the page
 * updates, so a block inserted above an open section would otherwise pair it with a different
 * element and close it; this finds the same section wherever it moved.
 */
function detailsKeys(root: HTMLElement): Map<HTMLDetailsElement, string> {
  const keys = new Map<HTMLDetailsElement, string>()
  const seen = new Map<string, number>()
  for (const el of root.querySelectorAll('details')) {
    let block: Element = el
    while (block.parentElement && block.parentElement !== root) block = block.parentElement
    let heading = ''
    for (let b: Element | null = block; b; b = b.previousElementSibling) {
      if (/^H[1-6]$/.test(b.tagName)) { heading = b.textContent?.trim() ?? ''; break }
    }
    const base = `${heading}\u0000${el.querySelector(':scope > summary')?.textContent?.trim() ?? ''}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    keys.set(el, `${base}\u0000${n}`)
  }
  return keys
}

function morph(html: string) {
  const open = new Set<string>()
  for (const [el, key] of detailsKeys(main)) if (el.open) open.add(key)
  const next = main.cloneNode(false) as HTMLElement
  next.innerHTML = html
  for (const [el, key] of detailsKeys(next)) el.open = open.has(key)
  morphdom(main, next, {
    getNodeKey: n => (n as HTMLElement).dataset?.wbKey || (n as HTMLElement).id || undefined,
    onBeforeElUpdated(from, to) {
      if (from.dataset.wbKey) {
        if (from.dataset.wbKey === to.dataset.wbKey && 'wbMounted' in from.dataset) {
          from.dataset.wbIsland = to.dataset.wbIsland // ids are per render; the key is what's stable
          return false
        }
        disposeWithin(from)
      }
      if (FIELD(from)) {
        if (from === document.activeElement) return false
        ;(to as typeof from).value = from.value
        if (from instanceof HTMLInputElement) (to as HTMLInputElement).checked = from.checked
      }
      // <details> open state was set on the new tree by detailsKeys(), matched by identity, not position
      if (from instanceof HTMLFormElement) {
        for (const k of ['wbSent', 'wbState']) if (from.dataset[k] != null) to.dataset[k] = from.dataset[k]
      }
      for (const c of KEEP_CLASSES) if (from.classList.contains(c)) to.classList.add(c)
      return true
    },
    onBeforeNodeDiscarded(node) {
      disposeWithin(node)
      return true
    },
  })
}

// The page keeps the reader's place itself: the browser's own scroll anchoring loses its anchor
// when an update replaces elements, so it is turned off to keep the two from both correcting.
document.documentElement.style.overflowAnchor = 'none'

/**
 * The reader's place before an update: the first block in view that the update keeps (by
 * signature, and which of the blocks with that signature it is), and where it is on screen.
 */
function placeOf(nextSigs: string[]) {
  const keep = new Set(nextSigs)
  const blocks = [...main.children]
  for (let i = 0; i < blocks.length; i++) {
    const sig = blockSigs[i]
    if (!keep.has(sig) || blocks[i].getBoundingClientRect().bottom <= 0) continue
    const nth = blockSigs.slice(0, i).filter(s => s === sig).length
    return { sig, nth, top: blocks[i].getBoundingClientRect().top }
  }
  return null
}

/** Scroll so the block of `place` is where it was on screen. */
function keepPlace(place: ReturnType<typeof placeOf>, sigs: string[]) {
  if (!place) return
  let seen = 0
  const i = sigs.findIndex(s => s === place.sig && seen++ === place.nth)
  const el = main.children[i]
  if (el) window.scrollBy(0, el.getBoundingClientRect().top - place.top)
}

async function refresh() {
  const res = await fetch(`${location.pathname}?fragment`)
  if (!res.ok) return
  const next = await res.json()
  islands = next.islands
  for (const href of next.styles as string[]) {
    if (![...document.querySelectorAll<HTMLLinkElement>('link[data-wb-style]')].some(l => new URL(l.href).pathname === href))
      document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${href}" data-wb-style>`)
  }
  const nextSigs = signaturesOf(next.html)
  const place = placeOf(nextSigs)
  morph(next.html)
  keepPlace(place, nextSigs)
  const updated = document.getElementById('wb-updated')
  if (updated && next.mtime) updated.dataset.ts = String(next.mtime)
  trackUpdate(main, blockSigs, nextSigs, next.title || document.title)
  blockSigs = nextSigs
  await mountIslands()
  // islands that mounted just now can change the height of what is above the reader
  keepPlace(place, nextSigs)
  restorePlainForms(false)
  restoreDrafts()
  tickTimes()
}

function connect() {
  const live = document.querySelector('.wb-live')
  const es = new EventSource(`/api/watch?page=${encodeURIComponent(page)}${isDir ? '&dir' : ''}`)
  es.onopen = () => live?.classList.add('on')
  es.onerror = () => live?.classList.remove('on')
  es.addEventListener('change', () => refresh())
  es.addEventListener('style', () => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[data-wb-style]')) {
      const url = new URL(link.href)
      url.searchParams.set('t', String(Date.now()))
      link.href = url.pathname + url.search
    }
  })
  es.addEventListener('events', async () => {
    if (isDir) return refresh()
    await loadEvents()
    restorePlainForms(false)
  })
}

blockSigs = [...main.children].map(signature)
if (!isDir) trackInitial(main, page)
if (!isDir) await loadEvents()
await mountIslands()
restorePlainForms(true)
restoreDrafts()
tickTimes()
connect()
