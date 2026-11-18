// The page's light and dark theme: the reader's choice (kept in localStorage), else the system's.
import type { Theme } from '../../define.ts'
import { reactive } from '../reactive'

export type ThemePreference = Theme | 'auto'

const media = matchMedia('(prefers-color-scheme: dark)')
const resolve = (): Theme =>
  (document.documentElement.dataset.theme as Theme | undefined) ?? (media.matches ? 'dark' : 'light')
let theme = resolve()

function update() {
  const next = resolve()
  if (next === theme) return
  theme = next
  currentTheme.notify()
}
media.addEventListener('change', update)

/** The theme in effect, as it changes (api.theme). */
export const currentTheme = reactive(() => theme)

export const themePreference = (): ThemePreference =>
  (document.documentElement.dataset.theme as Theme | undefined) ?? 'auto'

export function setThemePreference(pref: ThemePreference) {
  if (pref === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = pref
  try {
    if (pref === 'auto') localStorage.removeItem('wb-theme')
    else localStorage.setItem('wb-theme', pref)
  } catch {
    /* the choice still applies to this visit */
  }
  update()
}
