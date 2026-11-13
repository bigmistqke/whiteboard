// Page runtime: mounts template islands, records named form submits, live-reloads.
// Framework-free: an island's client module exports mount(element, props, api) (see define.ts).
import morphdom from 'morphdom'
import { api, page, loadEvents, submit, setThemePreference, themePreference, type ThemePreference } from './api'
import { signature, signaturesOf, trackInitial, trackUpdate } from './fresh'
import type { Mount } from '../define'

interface Island { template: string; client: string; props: unknown }

const main = document.getElementById('vz-main')!
const isDir = 'dir' in document.body.dataset
let islands: Record<string, Island> = JSON.parse(document.getElementById('vz-islands')?.textContent || '{}')
const disposers = new Map<Element, () => void>()
const lastSubmit = api.lastSubmit

// ---- islands -----------------------------------------------------------------------------------

async function mountOne(el: HTMLElement) {
  const island = islands[el.dataset.vzIsland!]
  el.dataset.vzMounted = ''
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
    el.insertAdjacentHTML('afterbegin', `<pre class="vz-error">template "${island.template}" failed to mount: ${String((err as Error).message)}</pre>`)
  }
}

/** Mount islands outermost first; nested islands show up once their parent has rendered. */
async function mountIslands(root: ParentNode = main) {
  for (;;) {
    const pending = [...root.querySelectorAll<HTMLElement>('[data-vz-island]:not([data-vz-mounted])')]
      .filter(el => !el.parentElement?.closest('[data-vz-island]:not([data-vz-mounted])'))
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
  if (main.querySelector('[data-vz-island]:not([data-vz-mounted])')) mountIslands()
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

/** Plain HTML forms get their last submission back; template forms handle this themselves. */
function restorePlainForms(prefill: boolean) {
  for (const form of main.querySelectorAll('form')) {
    if (!managed(form) || form.closest('[data-vz-island]')) continue
    const last = lastSubmit(form.getAttribute('name')!)
    if (!last) continue
    form.dataset.vzSent = last.action ?? ''
    if (prefill) writeForm(form, last.data)
  }
}

document.addEventListener('submit', async e => {
  const form = e.target as HTMLFormElement
  if (!managed(form)) return
  e.preventDefault()
  const button = e.submitter as HTMLButtonElement | null
  const action = button ? button.value || button.textContent?.trim() || null : null
  form.dataset.vzState = 'sending'
  try {
    await submit(form.getAttribute('name')!, action, readForm(form))
    form.dataset.vzState = 'sent'
    form.dataset.vzSent = action ?? ''
  } catch (err) {
    form.dataset.vzState = 'failed'
    console.error(err)
  }
})

// ---- theme -------------------------------------------------------------------------------------

const themeButton = document.querySelector<HTMLButtonElement>('.vz-theme')
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
const KEEP_CLASSES = ['vz-new', 'vz-new-seen']

/** Patch the page in place: focus, caret, typed values, open <details> and unchanged islands survive. */
function morph(html: string) {
  const next = main.cloneNode(false) as HTMLElement
  next.innerHTML = html
  morphdom(main, next, {
    getNodeKey: n => (n as HTMLElement).dataset?.vzKey || (n as HTMLElement).id || undefined,
    onBeforeElUpdated(from, to) {
      if (from.dataset.vzKey) {
        if (from.dataset.vzKey === to.dataset.vzKey && 'vzMounted' in from.dataset) {
          from.dataset.vzIsland = to.dataset.vzIsland // ids are per render; the key is what's stable
          return false
        }
        disposeWithin(from)
      }
      if (FIELD(from)) {
        if (from === document.activeElement) return false
        ;(to as typeof from).value = from.value
        if (from instanceof HTMLInputElement) (to as HTMLInputElement).checked = from.checked
      }
      if (from instanceof HTMLDetailsElement) (to as HTMLDetailsElement).open = from.open
      if (from instanceof HTMLFormElement) {
        for (const k of ['vzSent', 'vzState']) if (from.dataset[k] != null) to.dataset[k] = from.dataset[k]
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

async function refresh() {
  const res = await fetch(`${location.pathname}?fragment`)
  if (!res.ok) return
  const next = await res.json()
  islands = next.islands
  for (const href of next.styles as string[]) {
    if (![...document.querySelectorAll<HTMLLinkElement>('link[data-vz-style]')].some(l => new URL(l.href).pathname === href))
      document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${href}" data-vz-style>`)
  }
  const nextSigs = signaturesOf(next.html)
  morph(next.html)
  const updated = document.getElementById('vz-updated')
  if (updated && next.mtime) updated.dataset.ts = String(next.mtime)
  trackUpdate(main, blockSigs, nextSigs, next.title || document.title)
  blockSigs = nextSigs
  await mountIslands()
  restorePlainForms(false)
  tickTimes()
}

function connect() {
  const live = document.querySelector('.vz-live')
  const es = new EventSource(`/api/watch?page=${encodeURIComponent(page)}${isDir ? '&dir' : ''}`)
  es.onopen = () => live?.classList.add('on')
  es.onerror = () => live?.classList.remove('on')
  es.addEventListener('change', () => refresh())
  es.addEventListener('style', () => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[data-vz-style]')) {
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
tickTimes()
connect()
