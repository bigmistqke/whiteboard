// The page in the browser: mounts blocks' islands, patches the page in place when it changes, and
// shows what an agent waits for on the page's named forms (the core sends them and marks their
// state). Comments are a plugin of their own. Framework-free: an island's client module exports
// mount(element, props, api) (see types.ts).
import morphdom from 'morphdom'
import type { Api, PageHandle, PluginMount } from '../../define.ts'
import type { ClientApi, Mount } from '../../define.ts'
import { signature, signaturesOf, trackInitial, trackUpdate } from './fresh'
import { currentTheme, onTheme, setThemePreference, themePreference, type ThemePreference } from './theme'
import { trackWaiting } from './waiting'
import { trackElsewhere } from './elsewhere'
import { trackLive } from './live'
import { trackOrphanThreads } from './orphans'
import { html } from '../../html.ts'

interface Island { block: string; client: string; props: unknown }
interface Data { islands: Record<string, Island>; styles: string[]; mtime: number | null }

let main: HTMLElement
let page = ''
let api: ClientApi
let islands: Record<string, Island> = {}
const disposers = new Map<Element, () => void>()

// ---- islands -----------------------------------------------------------------------------------

async function mountOne(el: HTMLElement) {
  const island = islands[el.dataset.wbIsland!]
  el.dataset.wbMounted = ''
  if (!island) return
  try {
    const mod = await import(island.client)
    if (!el.isConnected) return
    const mount: Mount = mod.default
    if (typeof mount !== 'function') throw new Error('the client module must export a mount(element, props, api) function as default')
    el.replaceChildren()
    const dispose = await mount(el, island.props, api)
    if (typeof dispose === 'function') disposers.set(el, dispose)
  } catch (err) {
    console.error(`island ${island.block}:`, err)
    el.insertAdjacentHTML('afterbegin', String(html`<pre class="wb-error">block "${island.block}" failed to mount: ${(err as Error).message}</pre>`))
  }
}

/** Mount islands outermost first; nested islands show up once their parent has rendered. */
async function mountIslands(root: ParentNode = main): Promise<void> {
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


// ---- theme -------------------------------------------------------------------------------------

const NEXT: Record<ThemePreference, ThemePreference> = { auto: 'light', light: 'dark', dark: 'auto' }
// the preference as an icon: half a circle for following the system, a sun, a moon
const svg = (d: string) => `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${d}</svg>`
const THEME_ICON: Record<ThemePreference, string> = {
  auto: svg('<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor"/>'),
  light: svg('<circle cx="8" cy="8" r="2.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.2v1.8M8 13v1.8M1.2 8H3M13 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M3.2 12.8l1.3-1.3M11.5 4.5l1.3-1.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'),
  dark: svg('<path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
}
const THEME_LABEL: Record<ThemePreference, string> = { auto: 'Theme: follows the system', light: 'Theme: light', dark: 'Theme: dark' }

function themeToggle(root: HTMLElement) {
  const button = root.querySelector<HTMLButtonElement>('.wb-theme')
  if (!button) return
  const show = () => {
    const pref = themePreference()
    button.innerHTML = THEME_ICON[pref]
    button.dataset.pref = pref
    // what it is now, and that a click changes it
    button.title = `${THEME_LABEL[pref]} (click for ${NEXT[pref]})`
    button.setAttribute('aria-label', button.title)
  }
  show()
  button.addEventListener('click', () => {
    setThemePreference(NEXT[themePreference()])
    show()
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
      // what a plugin marked on an element (`data-wb-*`) stays, unless the new render sets it;
      // data-wb-mounted is the page's own, and a replaced island must mount afresh
      for (const { name, value } of [...from.attributes])
        if (name.startsWith('data-wb-') && name !== 'data-wb-mounted' && !to.hasAttribute(name)) to.setAttribute(name, value)
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

/** The new render of the page, patched in. */
async function refresh() {
  const next = await currentPage.render()
  const data = next.data as Data
  islands = data.islands
  for (const href of data.styles) {
    if (![...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].some(l => new URL(l.href).pathname === new URL(href, location.href).pathname))
      document.head.insertAdjacentHTML('beforeend', String(html`<link rel="stylesheet" href="${href}">`))
  }
  const content = new DOMParser().parseFromString(next.html, 'text/html').getElementById('wb-main')?.innerHTML ?? ''
  const nextSigs = signaturesOf(content)
  const place = placeOf(nextSigs)
  morph(content)
  keepPlace(place, nextSigs)
  const updated = document.getElementById('wb-updated')
  if (updated && data.mtime) updated.dataset.ts = String(data.mtime)
  if (next.title) core.title(next.title)
  trackUpdate(main, blockSigs, nextSigs)
  blockSigs = nextSigs
  await mountIslands()
  // islands that mounted just now can change the height of what is above the reader
  keepPlace(place, nextSigs)
  tickTimes()
  // plugins put back what they add to the content
  api.rendered()
}

let currentPage: PageHandle
let core: Api

const mount: PluginMount = async (root: HTMLElement, handle: PageHandle, coreApi: Api) => {
  currentPage = handle
  core = coreApi
  page = handle.id
  main = root.querySelector<HTMLElement>('#wb-main')!
  islands = (handle.data as Data).islands
  api = { ...core, theme: currentTheme, onTheme }
  const isDir = handle.kind === 'pages' || handle.kind === 'folder'

  themeToggle(root)
  setInterval(tickTimes, 15000)
  // islands rendered later (after async loading inside a component) still get mounted
  new MutationObserver(() => {
    if (main.querySelector('[data-wb-island]:not([data-wb-mounted])')) mountIslands()
  }).observe(main, { childList: true, subtree: true })

  handle.onChange(() => refresh())
  // the overview shows when pages were last answered
  if (isDir) core.onEvents(() => refresh())
  // the overview shows which pages an agent is waiting on
  if (isDir) core.onListeners(() => refresh())

  blockSigs = [...main.children].map(signature)
  if (!isDir) trackInitial(main, page, core)
  if (!isDir) trackWaiting(main, core)
  trackElsewhere(root, handle, core)
  trackLive(root, handle, core)
  if (!isDir) trackOrphanThreads(main, core)
  await mountIslands()
  tickTimes()
}

export default mount
