// Whose size a session has. A session has one size, and several drawers (browser windows) can show
// it at once. It takes the size of the drawer the reader used last, its active viewer: the one that
// last reported being used (opening it, focus, a keystroke), else the first to report a size. The
// others show it at that size. When the active drawer goes, the session passes to the drawer used
// most recently of those left: after a moment, since a page switch reconnects the same window under
// a new viewer, which claims it again.
//
// No terminal in here: host.ts applies what these return.

export interface Sizes {
  cols: number
  rows: number
  /** the drawers showing the session, by viewer id: the size that fits each, and when each was last used */
  viewers: Map<string, { cols: number; rows: number; used: number }>
  /** the viewer whose size the session has */
  active: string | null
}

/**
 * A drawer reports the size that fits it; `used`: the reader uses it now. Returns the size the
 * session should have: its own when the drawer is (now) the active one, else the session's as it is.
 */
export function report(s: Sizes, viewer: string, cols: number, rows: number, used: boolean, now = Date.now()): { cols: number; rows: number } {
  const known = s.viewers.get(viewer)
  s.viewers.set(viewer, { cols, rows, used: used ? now : known?.used ?? 0 })
  if (used || !s.active || !s.viewers.has(s.active)) s.active = viewer
  return s.active === viewer ? { cols, rows } : { cols: s.cols, rows: s.rows }
}

/** A drawer stopped showing the session. True when it was the active one: call `handOver` after a moment. */
export function leave(s: Sizes, viewer: string): boolean {
  s.viewers.delete(viewer)
  return s.active === viewer
}

/**
 * After the active drawer `viewer` left: the drawer used most recently of those left becomes the
 * active one. Returns the size the session should take, or null to leave it as it is (another drawer
 * claimed the session in the meantime, or none is left).
 */
export function handOver(s: Sizes, viewer: string): { cols: number; rows: number } | null {
  if (s.active !== viewer || s.viewers.has(viewer)) return null
  const next = [...s.viewers].sort((a, b) => b[1].used - a[1].used)[0]
  s.active = next?.[0] ?? null
  return next ? { cols: next[1].cols, rows: next[1].rows } : null
}

/**
 * Of several sessions, the one whose active drawer the reader used last: where "the browser the
 * reader is in" is, for a program that doesn't know its own tab. Undefined when no drawer is active.
 */
export function lastUsed<S extends Sizes>(sessions: S[]): S | undefined {
  let best: S | undefined
  let at = -1
  for (const s of sessions) {
    const viewer = s.active ? s.viewers.get(s.active) : undefined
    if (viewer && viewer.used > at) { best = s; at = viewer.used }
  }
  return best
}
