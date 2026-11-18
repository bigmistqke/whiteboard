// An iframe block filling the window, and back: its header's button, or Escape. Which one is
// maximized is kept across the page's updates, which put back the block as the server wrote it.
import type { PluginMount } from '../../src/define.ts'

const figures = () => [...document.querySelectorAll<HTMLElement>('#wb-main div.wb-iframe')]
// the maximized block, by its place among the page's iframe blocks and its address
let maximized: { index: number; src: string } | null = null

function apply() {
  const all = figures()
  let found: HTMLElement | null = null
  all.forEach((fig, i) => {
    const on = !!maximized && i === maximized.index && fig.querySelector('iframe')?.getAttribute('src') === maximized.src
    fig.toggleAttribute('data-maximized', on)
    const button = fig.querySelector<HTMLButtonElement>('[data-wb-maximize]')
    if (button) {
      button.title = on ? 'Back into the page (Esc)' : 'Fill the window'
      button.setAttribute('aria-label', button.title)
      button.setAttribute('aria-pressed', String(on))
    }
    if (on) found = fig
  })
  if (maximized && !found) maximized = null
  document.documentElement.toggleAttribute('data-wb-iframe-maximized', !!found)
}

function toggle(fig: HTMLElement) {
  const index = figures().indexOf(fig)
  const src = fig.querySelector('iframe')?.getAttribute('src') ?? ''
  maximized = maximized && maximized.index === index ? null : { index, src }
  apply()
}

const mount: PluginMount = (_root, _handle, api) => {
  document.addEventListener('click', e => {
    const button = (e.target as Element).closest?.('[data-wb-maximize]')
    const fig = button?.closest<HTMLElement>('div.wb-iframe')
    if (fig) toggle(fig)
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && maximized) { maximized = null; apply() }
  })
  api.onRendered(apply)
}

export default mount
