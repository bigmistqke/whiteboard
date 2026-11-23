// The agent's messages the reader hasn't read (status.ts: unreadMessages), and reading them: an
// element marked `data-wb-message="<event id>"` (a reply in an open thread, a chat bubble) reads
// its message once it has been mostly in view (most of it on screen, or filling most of the window)
// while the tab is visible. Reads are sent together, a
// moment later, as one `whiteboard:read` event.
import type { WbEvent } from '../define.ts'
import { READ, unreadMessages } from '../status.ts'

let isMessage: (type: string) => boolean = () => false
let getEvents: () => WbEvent[] = () => []
let send: (ids: string[]) => void = () => {}
// read here but not in the log yet: they don't count as unread meanwhile
const sending = new Set<string>()

export const unread = (): WbEvent[] => unreadMessages(getEvents(), isMessage).filter(e => !sending.has(e.id))

// read, to send in the next batch
const queued = new Set<string>()
let timer = 0
export function markRead(ids: string[]) {
  const open = new Set(unread().map(e => e.id))
  const fresh = ids.filter(id => open.has(id))
  if (!fresh.length) return
  for (const id of fresh) {
    sending.add(id)
    queued.add(id)
  }
  clearTimeout(timer)
  timer = window.setTimeout(() => {
    const batch = [...queued]
    queued.clear()
    if (batch.length) send(batch)
  }, 300)
}

/** Once the log has the reads, they need no holding. */
export function readsArrived(events: WbEvent[]) {
  for (const e of events)
    if (e.type === READ) for (const id of (e.data?.ids as unknown[] | undefined) ?? []) sending.delete(String(id))
}

// Mostly in view: most of the message is on screen, or, for one taller than the window, it fills
// most of the window.
const MOSTLY = 0.6
function mostlyInView(entry: IntersectionObserverEntry) {
  if (!entry.isIntersecting) return false
  if (entry.intersectionRatio >= MOSTLY) return true
  const viewport = entry.rootBounds?.height ?? window.innerHeight
  return entry.intersectionRect.height >= MOSTLY * viewport
}

// what is in view now, read once the tab is visible too
const inView = new Set<string>()
const seen = new IntersectionObserver(
  entries => {
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset.wbMessage!
      if (mostlyInView(entry)) inView.add(id)
      else inView.delete(id)
    }
    readVisible()
  },
  // steps: a message taller than the window never reaches 0.6 of itself in view, so its share is
  // reported as it scrolls by
  { threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
)

function readVisible() {
  if (document.visibilityState === 'visible' && inView.size) markRead([...inView])
}

const observed = new WeakSet<Element>()
function observeMessages() {
  const open = new Set(unread().map(e => e.id))
  for (const el of document.querySelectorAll<HTMLElement>('[data-wb-message]')) {
    if (observed.has(el) || !open.has(el.dataset.wbMessage!)) continue
    observed.add(el)
    seen.observe(el)
  }
}

export function trackReading(options: { messages: string[]; events: () => WbEvent[]; send: (ids: string[]) => void }) {
  const types = new Set(options.messages)
  isMessage = type => types.has(type)
  getEvents = options.events
  send = options.send
  new MutationObserver(observeMessages).observe(document.body, { childList: true, subtree: true })
  document.addEventListener('visibilitychange', readVisible)
  observeMessages()
}

/** After the events changed: messages that came since may already be on screen. */
export const messagesChanged = () => observeMessages()
