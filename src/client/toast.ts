// Toasts (api.toast): a short message at the bottom of the window, above what covers its bottom
// (--wb-inset-bottom), for what the reader should know when it happens, wherever they are scrolled.
// One goes after a few seconds, or on a click (a click runs `onClick` first). One with `ms: 0`
// stays: a click only runs `onClick`, and whoever made it closes it, or changes its text, through
// what toast() returns. Its look is the core's (server.ts), with the page's theme colours.
import type { Toast, ToastOptions } from '../define.ts'

const box = document.createElement('div')
box.id = 'wb-toasts'
box.setAttribute('role', 'status')
box.setAttribute('aria-live', 'polite')

export function toast(text: string, { kind = 'info', ms = 7000, onClick }: ToastOptions = {}): Toast {
  if (!box.isConnected) document.body.append(box)
  const el = document.createElement('div')
  el.className = 'wb-toast'
  el.dataset.kind = kind
  if (onClick) el.dataset.action = ''
  el.textContent = text
  const close = () => el.remove()
  el.addEventListener('click', () => { if (ms) close(); onClick?.() })
  if (ms) setTimeout(close, ms)
  box.append(el)
  return { close, update: next => { el.textContent = next } }
}
