// The path the page's project is served under: '' on a server of its own, `/rg/develop` under a
// shared server (see Entries in DESIGN.md). The server says it in the page's handoff. Every request
// the page makes, and every link it writes, starts with it; what the browser keeps (drafts, what
// was seen) is kept per project with it, since the projects of a shared server share one origin.
const handoff = (() => {
  try {
    return JSON.parse(document.getElementById('wb-page')?.textContent ?? '{}') as { base?: string }
  } catch {
    return {}
  }
})()

export const base: string = handoff.base ?? ''

/** A path of the project's server (`/api/events`) as this page requests it. */
export const url = (path: string): string => base + path

/** A localStorage key, kept apart from other projects' on the same origin. */
export const storageKey = (key: string): string => (base ? `${base}|${key}` : key)
