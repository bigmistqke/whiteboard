// The page's client state, framework-free. Every template's mount() receives `api` (a ClientApi);
// framework adapters such as @bigmistqke/whiteboard/solid turn the subscriptions into their own reactivity.
import type { ClientApi, Theme, WbEvent } from '../define'

export type { ClientApi, Theme, WbEvent }
export type ThemePreference = Theme | 'auto'

/** This page's id, e.g. "plan". */
export const page: string = document.body.dataset.page ?? ''

// ---- events ------------------------------------------------------------------------------------

let events: WbEvent[] = []
const eventListeners = new Set<(events: WbEvent[]) => void>()
function setEvents(next: WbEvent[]) {
  events = next
  for (const fn of eventListeners) fn(events)
}

export async function loadEvents(): Promise<void> {
  const res = await fetch(`/api/events?page=${encodeURIComponent(page)}`)
  const all: WbEvent[] = await res.json()
  setEvents(all.filter(e => e.page === page))
}

/** Record a submission. The engine calls this for every named <form>. */
export async function submit(form: string, action: string | null, data: Record<string, unknown>): Promise<WbEvent> {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page, form, action, data }),
  })
  if (!res.ok) throw new Error(await res.text())
  const saved: WbEvent = await res.json()
  if (!events.some(e => e.id === saved.id)) setEvents([...events, saved])
  return saved
}

// ---- theme -------------------------------------------------------------------------------------

const media = matchMedia('(prefers-color-scheme: dark)')
const themeListeners = new Set<(theme: Theme) => void>()
const resolveTheme = (): Theme => (document.documentElement.dataset.theme as Theme | undefined) ?? (media.matches ? 'dark' : 'light')
let theme = resolveTheme()
function updateTheme() {
  const next = resolveTheme()
  if (next === theme) return
  theme = next
  for (const fn of themeListeners) fn(theme)
}
media.addEventListener('change', updateTheme)

export const themePreference = (): ThemePreference => (document.documentElement.dataset.theme as Theme | undefined) ?? 'auto'

export function setThemePreference(pref: ThemePreference) {
  if (pref === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = pref
  try {
    if (pref === 'auto') localStorage.removeItem('wb-theme')
    else localStorage.setItem('wb-theme', pref)
  } catch { /* the choice still applies to this visit */ }
  updateTheme()
}

// ---- the api handed to templates ---------------------------------------------------------------

export const api: ClientApi = {
  page,
  events: () => events,
  onEvents(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) },
  lastSubmit: form => events.findLast(e => e.form === form),
  theme: () => theme,
  onTheme(fn) { themeListeners.add(fn); return () => themeListeners.delete(fn) },
}
