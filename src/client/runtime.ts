// The core in the browser: the page's events, the live channel, and handing the page to its
// renderer. Framework-free, and it draws nothing: the renderer's client gets the root element and
// does the rest. A page without a renderer client shows the server's HTML, replaced when it changes.
import type { Api, PageHandle, Rendered, RendererMount, StoredPage, WbEvent } from '../define'

interface Handoff { id: string; kind: StoredPage['kind']; renderer: string | null; client: string | null; data: unknown }

const handoff: Handoff = JSON.parse(document.getElementById('wb-page')!.textContent!)
const root = document.getElementById('wb-root')!
const page = handoff.id
const isDir = handoff.kind === 'pages' || handoff.kind === 'folder'

// ---- events ------------------------------------------------------------------------------------

let events: WbEvent[] = []
const eventListeners = new Set<(events: WbEvent[]) => void>()
function setEvents(next: WbEvent[]) {
  events = next
  for (const fn of eventListeners) fn(events)
}

async function loadEvents() {
  const res = await fetch(`/api/events?page=${encodeURIComponent(page)}`)
  const all: WbEvent[] = await res.json()
  setEvents(all.filter(e => e.page === page))
}

async function append(type: string, data: Record<string, unknown> = {}, action: string | null = null): Promise<WbEvent> {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page, type, action, data }),
  })
  if (!res.ok) throw new Error(await res.text())
  const saved: WbEvent = await res.json()
  if (!events.some(e => e.id === saved.id)) setEvents([...events, saved])
  return saved
}

const api: Api = {
  page,
  events: () => events,
  onEvents(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) },
  last: type => events.findLast(e => e.type === type),
  append,
}

// ---- the page ----------------------------------------------------------------------------------

const changeListeners = new Set<() => void>()

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

const handle: PageHandle = {
  id: page,
  kind: handoff.kind,
  data: handoff.data,
  onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn) },
  render: () => getJson<Rendered>(`/api/render?page=${encodeURIComponent(page)}`),
  stored: () => getJson<StoredPage>(`/api/page?page=${encodeURIComponent(page)}`),
}

// without a renderer client, the server's HTML is the page: replace it when the page changes
if (!handoff.client) handle.onChange(async () => { root.innerHTML = (await handle.render()).html })

// ---- live channel ------------------------------------------------------------------------------

function connect() {
  const es = new EventSource(`/api/watch?page=${encodeURIComponent(page)}${isDir ? '&dir' : ''}`)
  es.onopen = () => document.documentElement.dataset.wbLive = ''
  es.onerror = () => { delete document.documentElement.dataset.wbLive }
  es.addEventListener('change', () => { for (const fn of changeListeners) fn() })
  es.addEventListener('events', () => loadEvents())
  // browser code changed; renderers keep what matters across a reload themselves
  es.addEventListener('reload', () => location.reload())
  es.addEventListener('style', () => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')) {
      const url = new URL(link.href)
      if (url.origin !== location.origin) continue
      url.searchParams.set('t', String(Date.now()))
      link.href = url.pathname + url.search
    }
  })
}

await loadEvents()
if (handoff.client) {
  try {
    const mount: RendererMount = (await import(handoff.client)).default
    if (typeof mount !== 'function') throw new Error('the client module must export a mount(root, page, api) function as default')
    await mount(root, handle, api)
  } catch (err) {
    console.error(`renderer ${handoff.renderer}:`, err)
    root.insertAdjacentHTML('afterbegin', `<pre class="wb-error" role="alert">renderer "${handoff.renderer}" failed to start: ${String((err as Error).message)}</pre>`)
  }
}
connect()
