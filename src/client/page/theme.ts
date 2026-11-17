// The page's light and dark theme: the reader's choice (kept in localStorage), else the system's.
import type { Theme } from '../../define.ts'

export type ThemePreference = Theme | 'auto'

const media = matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<(theme: Theme) => void>()
const resolve = (): Theme => (document.documentElement.dataset.theme as Theme | undefined) ?? (media.matches ? 'dark' : 'light')
let theme = resolve()

function update() {
  const next = resolve()
  if (next === theme) return
  theme = next
  for (const fn of listeners) fn(theme)
}
media.addEventListener('change', update)

export const currentTheme = () => theme
export function onTheme(fn: (theme: Theme) => void) { listeners.add(fn); return () => listeners.delete(fn) }

export const themePreference = (): ThemePreference => (document.documentElement.dataset.theme as Theme | undefined) ?? 'auto'

export function setThemePreference(pref: ThemePreference) {
  if (pref === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = pref
  try {
    if (pref === 'auto') localStorage.removeItem('wb-theme')
    else localStorage.setItem('wb-theme', pref)
  } catch { /* the choice still applies to this visit */ }
  update()
}
