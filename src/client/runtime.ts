// The core in the browser: the page's events, the live channel, and handing the page to the page
// module (./page: markdown live, the blocks' islands) and the plugins' modules. When the config failed
// to load, the page is its raw text: the server's HTML, replaced when it changes.
import type { Api, PluginMount, Listener, PageHandle, RenderedPage, StoredPage, WbEvent } from '../define'
import { html } from '../html.ts'
import { formsApi, trackForms } from './forms'
import { createToast } from './toast'
import { markRead, messagesChanged, readsArrived, trackReading, unread as unreadNow } from './read'
import { READ } from '../status.ts'
import { markdown } from './markdown'
import { scrollToTarget } from './scroll'
import { reactive } from './reactive'

interface Handoff {
  id: string
  kind: StoredPage['kind']
  data: unknown
  /** the page module; null for raw text */
  client: string | null
  /** the plugins' browser modules */
  plugins: { name: string; client: string }[]
  /** the event types that, from the agent, are messages for the reader */
  messages: string[]
  /** the page's frontmatter (PageHandle.frontmatter) */
  frontmatter: Record<string, unknown>
  /** false on a built page (`whiteboard build`): a file, no server behind it */
  live?: boolean
}

const handoff: Handoff = JSON.parse(document.getElementById('wb-page')!.textContent!)
const root = document.getElementById('wb-root')!
const page = handoff.id
const isDir = handoff.kind === 'pages' || handoff.kind === 'folder'
// a built page has no server: no events, no listeners, no live channel, nothing to record
const live = handoff.live !== false
// a module's path as the page names it: a built page's are relative to the page, which an import()
// here would take as relative to this module
const moduleUrl = (path: string) => new URL(path, document.baseURI).href

// ---- events ------------------------------------------------------------------------------------

let events: WbEvent[] = []
const eventsValue = reactive(() => events)
// what is unread changes with the events, and with a message read here before the log has it
const unread = reactive(unreadNow)
function setEvents(next: WbEvent[]) {
  events = next
  readsArrived(events)
  eventsValue.notify()
  unread.notify()
  messagesChanged()
}

async function loadEvents() {
  if (!live) return
  const res = await fetch(`/api/events?page=${encodeURIComponent(page)}`)
  const all: WbEvent[] = await res.json()
  setEvents(all.filter(e => e.page === page))
}

async function append(
  type: string,
  data: Record<string, unknown> = {},
  action: string | null = null,
): Promise<WbEvent> {
  if (!live) throw new Error('a built page is a file: there is no log to append to')
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

let listeners: Listener[] = []
const listenersValue = reactive(() => listeners)

async function loadListeners() {
  if (!live) return
  listeners = await (await fetch(`/api/listeners?page=${encodeURIComponent(page)}`)).json()
  listenersValue.notify()
}

const renderedListeners = new Set<() => void>()

// ---- the corner and the title ------------------------------------------------------------------

// the server puts it in the page; a page from a server older than this runtime has none
const corner =
  document.getElementById('wb-dock') ??
  document.body.appendChild(Object.assign(document.createElement('div'), { id: 'wb-dock' }))
let baseTitle = document.title
const badges = new Map<string, { text: string; order: number; since: number }>()
let badgeCount = 0
function writeTitle() {
  const list = [...badges.values()].toSorted((a, b) => a.order - b.order || a.since - b.since)
  document.title = `${list.map(b => `(${b.text}) `).join('')}${baseTitle}`
}

const api: Api = {
  page,
  events: eventsValue,
  last: type => events.findLast(e => e.type === type),
  pickedUp: id => !!events.find(e => e.id === id)?.pickedUp,
  unread,
  markRead: ids => {
    markRead(ids)
    unread.notify()
  },
  markdown,
  append,
  listeners: listenersValue,
  rendered() {
    // the new page is in place: what came with its render is the page's now, before anyone hears
    // of the update, so a listener reads the new values
    const frontmatterChanged = JSON.stringify(nextFrontmatter) !== JSON.stringify(frontmatter)
    data = nextData
    frontmatter = nextFrontmatter
    for (const fn of renderedListeners) fn()
    dataValue.notify()
    if (frontmatterChanged) frontmatterValue.notify()
  },
  onRendered(fn) {
    renderedListeners.add(fn)
    return () => renderedListeners.delete(fn)
  },
  corner: () => corner,
  badge(key, text, order = 0) {
    if (text == null) badges.delete(key)
    else badges.set(key, { text, order, since: badges.get(key)?.since ?? badgeCount++ })
    writeTitle()
  },
  title(title) {
    baseTitle = title
    writeTitle()
  },
  toast: createToast(() => corner),
  ...formsApi,
}

// ---- the page ----------------------------------------------------------------------------------

const changeListeners = new Set<() => void>()

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json()
}

// what came with the page, and what came with its last render: the page's once the new page is in
// place (api.rendered), so a listener never sees new values over the old page
let data: unknown = handoff.data
let nextData: unknown = data
let frontmatter: Record<string, unknown> = handoff.frontmatter ?? {}
let nextFrontmatter = frontmatter
const dataValue = reactive(() => data)
const frontmatterValue = reactive(() => frontmatter)
const handle: PageHandle = {
  id: page,
  kind: handoff.kind,
  live,
  data: dataValue,
  frontmatter: frontmatterValue,
  onChange(fn) {
    changeListeners.add(fn)
    return () => changeListeners.delete(fn)
  },
  render: async () => {
    const next = await getJson<RenderedPage>(`/api/render?page=${encodeURIComponent(page)}`)
    nextData = next.data ?? null
    nextFrontmatter = next.frontmatter ?? {}
    return next
  },
  stored: () => getJson<StoredPage>(`/api/page?page=${encodeURIComponent(page)}`),
}

/** Did the page change since it was rendered here (its file's time, or it came to be)? Then say so. */
async function caughtUp() {
  let now: number | null
  try {
    now =
      (await getJson<RenderedPage & { mtime: number | null }>(`/api/render?page=${encodeURIComponent(page)}`)).mtime ??
      null
  } catch {
    now = null
  }
  const shown = (data as { mtime?: number | null } | null)?.mtime ?? null
  if (now !== shown) for (const fn of changeListeners) fn()
}

// raw text: the server's HTML is the page, replaced when the page changes
if (!handoff.client)
  handle.onChange(async () => {
    root.innerHTML = (await handle.render()).html
    api.rendered()
  })

// ---- live channel ------------------------------------------------------------------------------

function connect() {
  const es = new EventSource(`/api/watch?page=${encodeURIComponent(page)}${isDir ? '&dir' : ''}`)
  es.onopen = () => {
    document.documentElement.dataset.wbLive = ''
    // after a server restart: who is listening now, and what was answered meanwhile
    loadListeners()
    loadEvents()
    // and the page, if it changed while the channel wasn't open yet (just after loading, or while
    // the server restarted): that change was never announced. Only then: an update that changes
    // nothing still redraws, sorts and scrolls, under the reader's hands
    caughtUp()
  }
  es.onerror = () => {
    delete document.documentElement.dataset.wbLive
  }
  es.addEventListener('change', () => {
    for (const fn of changeListeners) fn()
  })
  es.addEventListener('events', () => loadEvents())
  es.addEventListener('listeners', () => loadListeners())
  // browser code changed; the page keeps what matters across a reload itself. Reload only once
  // the server answers: reloading while it restarts would leave the browser's error page, which
  // has nothing left in it to recover with.
  es.addEventListener('reload', () => {
    const go = async () => {
      try {
        if ((await fetch('/api/health', { cache: 'no-store' })).ok) return location.reload()
      } catch {
        /* not up yet */
      }
      setTimeout(go, 500)
    }
    go()
  })
  // an agent shows the reader a place on the page
  es.addEventListener('scroll', e => {
    const { to } = JSON.parse((e as MessageEvent).data) as { to: string }
    if (!scrollToTarget(root, to)) console.warn(`whiteboard scroll: nothing on the page matches ${JSON.stringify(to)}`)
  })
  es.addEventListener('style', () => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')) {
      const url = new URL(link.href)
      if (url.origin !== location.origin) continue
      url.searchParams.set('t', String(Date.now()))
      link.href = url.pathname + url.search
    }
  })
}

await Promise.all([loadEvents(), loadListeners()])
if (handoff.client) {
  try {
    const mount: PluginMount = (await import(moduleUrl(handoff.client))).default
    await mount(root, handle, api)
  } catch (err) {
    console.error('page:', err)
    root.insertAdjacentHTML(
      'afterbegin',
      String(html`<pre class="wb-error" role="alert">the page failed to start: ${(err as Error).message}</pre>`),
    )
  }
}
// named forms, once the page is on the page, and what the reader read: neither on a built page
if (live) {
  trackForms(root, page, api)
  trackReading({
    messages: handoff.messages ?? [],
    events: () => events,
    send: ids => {
      append(READ, { ids }).catch(err => console.error('marking read:', err))
    },
  })
}
// the plugins' modules after the page, so that what they work on is there; one failing leaves the others
await Promise.all(
  (handoff.plugins ?? []).map(async ext => {
    try {
      const mount: PluginMount = (await import(moduleUrl(ext.client))).default
      if (typeof mount !== 'function')
        throw new Error('the client module must export a mount(root, page, api) function as default')
      await mount(root, handle, api)
    } catch (err) {
      console.error(`plugin ${ext.name}:`, err)
      root.insertAdjacentHTML(
        'afterbegin',
        String(
          html`<pre class="wb-error" role="alert">
plugin "${ext.name}" failed in the browser: ${(err as Error).message}</pre>`,
        ),
      )
    }
  }),
)
if (live) connect()
