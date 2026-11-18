// A short message at the bottom of the window, above the terminal drawer: for what the reader
// should know when it happens, wherever they are scrolled. It goes after a few seconds, or on a click.
import { viewBottom } from './view'

const box = document.createElement('div')
box.className = 'wb-toasts'
box.setAttribute('role', 'status')
box.setAttribute('aria-live', 'polite')

export function toast(text: string, { kind = 'info', ms = 7000 }: { kind?: 'info' | 'warn'; ms?: number } = {}) {
  if (!box.isConnected) document.body.append(box)
  box.style.bottom = `${innerHeight - viewBottom() + 16}px`
  const el = document.createElement('div')
  el.className = 'wb-toast'
  el.dataset.kind = kind
  el.textContent = text
  const close = () => el.remove()
  el.addEventListener('click', close)
  setTimeout(close, ms)
  box.append(el)
}
