// The core in the browser: the page's events, the live channel, and handing the page to the page
// module (./page: markdown live, the blocks' islands) and the plugins' modules. When the config failed
// to load, the page is its raw text: the server's HTML, replaced when it changes.
import type { Api, PluginMount, Listener, PageHandle, RenderedPage, StoredPage, WbEvent } from '../define'
import { html } from '../html.ts'
import { formsApi, trackForms } from './forms'
import { createToast } from './toast'
import { markRead, messagesChanged, readsArrived, trackReading, unread as unreadNow } from './read'
import { READ, SCROLL, fromReader } from '../status.ts'
import { markdown } from './markdown'
import { scrollToTarget } from './scroll'
import { reactive } from './reactive'
import { url } from './base.ts'

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
  /** what the browser runs and how it looks, as the server served them (see /api/stamps) */
  stamps?: { code: string; style: string }
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
  const res = await fetch(url(`/api/events?page=${encodeURIComponent(page)}`))
  const all: WbEvent[] = (await res.json()).filter((e: WbEvent) => e.page === page)
  // what is still on its way stays: the log doesn't have it yet
  const known = new Set(all.map(e => e.id))
  for (const [id, e] of sending) if (known.has(id)) sending.delete(id)
  setEvents([...all, ...[...sending.values()]])
  scrollFromLog()
}

// `whiteboard scroll` is an event in the log (SCROLL), so a scroll sent while this page wasn't
// connected still happens once it is. The latest one counts; the first load only notes which that
// is, so a page loaded later doesn't jump to a place shown before it.
let scrolledTo: string | null | undefined
function scrollFromLog() {
  const last = events.findLast(e => e.type === SCROLL && !fromReader(e))
  if (scrolledTo === undefined) return void (scrolledTo = last?.id ?? null)
  if (!last || last.id === scrolledTo) return
  scrolledTo = last.id
  const to = String(last.data?.to ?? '')
  if (!scrollToTarget(root, to)) console.warn(`whiteboard scroll: nothing on the page matches ${JSON.stringify(to)}`)
}

// Appending is optimistic: the event is in the page's events at once, marked `sending`, so the page
// shows it without waiting; the server's copy replaces it once it is in the log. Its id is made
// here and the server keeps it, so a send that heard nothing back can be sent again without
// appending it twice: it is retried, and only when none goes through is it taken out again and the
// append fails.

/** How long one send may take before it is tried again, in ms; and how many tries in all. */
const SEND_TIMEOUT = 8_000
const TRIES = 4

/** Events appended here that the server hasn't confirmed: kept in the events when they are loaded. */
const sending = new Map<string, WbEvent>()

/** An id as the server makes them (isEventId): the time in base 36, a dash, random hex. */
const newId = () =>
  `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('')}`

async function append(
  type: string,
  data: Record<string, unknown> = {},
  action: string | null = null,
): Promise<WbEvent> {
  if (!live) throw new Error('a built page is a file: there is no log to append to')
  const id = newId()
  const shown: WbEvent = { id, ts: new Date().toISOString(), page, type, action, data, sending: true }
  sending.set(id, shown)
  setEvents([...events, shown])
  const body = JSON.stringify({ id, page, type, action, data })
  let failure: unknown
  for (let attempt = 0; attempt < TRIES; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
    try {
      const res = await fetch(url('/api/events'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        // never left hanging: a browser holds a request while it has no connection to send it on
        signal: AbortSignal.timeout(SEND_TIMEOUT),
      })
      // refused: sending it again changes nothing
      if (res.status >= 400 && res.status < 500) {
        failure = new Error(await res.text())
        break
      }
      if (!res.ok) throw new Error(await res.text())
      const saved: WbEvent = await res.json()
      sending.delete(id)
      // the server's copy in its place (a load may have brought it already)
      setEvents([...events.filter(e => e.id !== id && e.id !== saved.id), saved].toSorted(byTime))
      return saved
    } catch (err) {
      failure = err
    }
  }
  // the log has it already (a load brought it), though no answer to a send came back
  const arrived = !sending.has(id) && events.find(e => e.id === id && !e.sending)
  if (arrived) return arrived
  sending.delete(id)
  setEvents(events.filter(e => e.id !== id))
  throw failure
}

const byTime = (a: WbEvent, b: WbEvent) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)

let listeners: Listener[] = []
const listenersValue = reactive(() => listeners)

async function loadListeners() {
  if (!live) return
  listeners = await (await fetch(url(`/api/listeners?page=${encodeURIComponent(page)}`))).json()
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
  url,
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
const nothing = reactive((): unknown => undefined)
const handle: PageHandle = {
  settings: nothing,
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
    const next = await getJson<RenderedPage>(url(`/api/render?page=${encodeURIComponent(page)}`))
    nextData = next.data ?? null
    nextFrontmatter = next.frontmatter ?? {}
    return next
  },
  stored: () => getJson<StoredPage>(url(`/api/page?page=${encodeURIComponent(page)}`)),
}

/** Did the page change since it was rendered here (its file's time, or it came to be)? Then say so. */
async function caughtUp() {
  let now: number | null
  try {
    now =
      (await getJson<RenderedPage & { mtime: number | null }>(url(`/api/render?page=${encodeURIComponent(page)}`)))
        .mtime ?? null
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

// A WebSocket, not server-sent events: a browser keeps six HTTP/1.1 connections to an origin, and
// every whiteboard tab is on the same one; one stream per tab left none for a form's answer (see
// src/ws.ts). A WebSocket doesn't reconnect by itself: this does, sooner at first, then every few
// seconds, and at once when the tab is shown or the network comes back.
const reloadWhenUp = async () => {
  try {
    if ((await fetch(url('/api/health'), { cache: 'no-store' })).ok) return location.reload()
  } catch {
    /* not up yet */
  }
  setTimeout(reloadWhenUp, 500)
}

/** What the server says on the live channel, by its name. */
const onLive: Record<string, (data: unknown) => void> = {
  change: () => {
    for (const fn of changeListeners) fn()
  },
  events: () => loadEvents(),
  listeners: () => loadListeners(),
  // under a shared server: what waits in another project changed (the page's menu of it listens)
  elsewhere: () => document.dispatchEvent(new Event('wb-elsewhere')),
  // browser code changed; the page keeps what matters across a reload itself. Reload only once
  // the server answers: reloading while it restarts would leave the browser's error page, which
  // has nothing left in it to recover with.
  reload: () => reloadWhenUp(),
  style: () => {
    stamps = null
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')) {
      const url = new URL(link.href)
      if (url.origin !== location.origin) continue
      url.searchParams.set('t', String(Date.now()))
      link.href = url.pathname + url.search
    }
  },
}

// What the browser runs and how it looks, as this page has them; null once a style message refreshed
// the stylesheets without a stamp to go with it (the next comparison takes the server's then).
let stamps: { code: string; style: string } | null = handoff.stamps ?? null

/**
 * Back on the live channel: what changed while this page wasn't on it, it never heard of. Browser
 * code that changed reloads the page; stylesheets that changed are refreshed in place.
 */
async function compareStamps() {
  let now: { code: string; style: string }
  try {
    now = await (await fetch(url('/api/stamps'), { cache: 'no-store' })).json()
  } catch {
    return
  }
  if (stamps && now.code !== stamps.code) return reloadWhenUp()
  if (stamps && now.style !== stamps.style) onLive.style!(null)
  stamps = now
}

let socket: WebSocket | null = null
let retries = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined

function connect() {
  clearTimeout(retryTimer)
  if (socket && socket.readyState <= WebSocket.OPEN) return
  const at = new URL(url(`/api/live?page=${encodeURIComponent(page)}${isDir ? '&dir' : ''}`), location.href)
  at.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = (socket = new WebSocket(at))
  ws.onopen = () => {
    retries = 0
    document.documentElement.dataset.wbLive = ''
    // after a server restart: who is listening now, and what was answered meanwhile, here and
    // elsewhere
    loadListeners()
    loadEvents()
    void compareStamps()
    document.dispatchEvent(new Event('wb-elsewhere'))
    // and the page, if it changed while the channel wasn't open yet (just after loading, or while
    // the server restarted): that change was never announced. Only then: an update that changes
    // nothing still redraws, sorts and scrolls, under the reader's hands
    caughtUp()
  }
  ws.onmessage = e => {
    let message: { event?: string; data?: unknown }
    try {
      message = JSON.parse(String(e.data))
    } catch {
      return
    }
    if (message.event) onLive[message.event]?.(message.data)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    delete document.documentElement.dataset.wbLive
    retryTimer = setTimeout(connect, Math.min(250 * 2 ** retries++, 5000))
  }
}
// back at once: a tab shown again (a browser may have let its connection go), the network back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket) connect()
})
addEventListener('online', () => {
  if (!socket) connect()
})

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
/**
 * A plugin's page handle: the page's, with its own settings, the page's frontmatter under `plugins:`
 * by its name, heard of only when they changed.
 */
function handleFor(name: string): PageHandle {
  const own = () => {
    const plugins = frontmatter.plugins
    return plugins && typeof plugins === 'object' ? (plugins as Record<string, unknown>)[name] : undefined
  }
  const settings = reactive(own)
  let last = JSON.stringify(own() ?? null)
  frontmatterValue.on(() => {
    const now = JSON.stringify(own() ?? null)
    if (now === last) return
    last = now
    settings.notify()
  })
  return { ...handle, settings }
}

// the plugins' modules after the page, so that what they work on is there; one failing leaves the others
await Promise.all(
  (handoff.plugins ?? []).map(async ext => {
    try {
      const mount: PluginMount = (await import(moduleUrl(ext.client))).default
      if (typeof mount !== 'function')
        throw new Error('the client module must export a mount(root, page, api) function as default')
      await mount(root, handleFor(ext.name), api)
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
