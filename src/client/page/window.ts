// A window (src/pages/window.ts: the iframe block, `:::window`, any block that draws one) filling the
// browser window, and back: its header's button, or Esc. Which one is kept across the page's
// updates, which can write the block anew: by its place among the page's windows.
import type { Api } from '../../define.ts'

const windows = () => [...document.querySelectorAll<HTMLElement>('#wb-main .wb-window')]
let maximized: number | null = null

function apply() {
  const all = windows()
  if (maximized != null && !all[maximized]) maximized = null
  all.forEach((win, i) => {
    const on = i === maximized
    win.toggleAttribute('data-wb-maximized', on)
    const button = win.querySelector<HTMLButtonElement>('[data-wb-maximize]')
    if (button) {
      button.title = on ? 'Back into the page (Esc)' : 'Fill the window'
      button.setAttribute('aria-label', button.title)
      button.setAttribute('aria-pressed', String(on))
    }
  })
  document.documentElement.toggleAttribute('data-wb-window-maximized', maximized != null)
}

export function trackWindows(api: Api) {
  document.addEventListener('click', e => {
    const win = (e.target as Element).closest?.('[data-wb-maximize]')?.closest<HTMLElement>('.wb-window')
    if (!win) return
    const i = windows().indexOf(win)
    maximized = maximized === i ? null : i
    apply()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && maximized != null) {
      maximized = null
      apply()
    }
  })
  api.onRendered(apply)
}
