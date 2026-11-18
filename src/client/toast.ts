// Toasts (api.toast): short labels in the page's corner (api.corner(), above what covers the bottom
// of the window) that say what is going on and take the reader there: "→ unanswered (2)",
// "↓ new (3)", "Sent, but no agent is listening". One goes after a few seconds, or on a click; one
// with `ms: 0` stays until closed, and changes its text, or hides and shows again, through what
// toast() returns. A click runs `onClick` (and closes a toast that goes by itself); `onDismiss`
// adds a ✕ that runs it and closes the toast. Their look is the core's (server.ts), in the page's
// theme colours.
import type { Toast, ToastOptions } from '../define.ts'

let box: HTMLElement | null = null
function place(corner: HTMLElement) {
  if (box?.isConnected) return box
  box = document.createElement('div')
  box.className = 'wb-toasts'
  box.setAttribute('role', 'status')
  box.setAttribute('aria-live', 'polite')
  corner.append(box)
  return box
}

export function createToast(corner: () => HTMLElement) {
  return function toast(
    text: string,
    { kind = 'info', ms = 7000, onClick, onDismiss, name, order = 0 }: ToastOptions = {},
  ): Toast {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'wb-toast'
    el.dataset.kind = kind
    if (name) el.dataset.toast = name
    el.style.order = String(order)
    const label = document.createElement('span')
    label.className = 'wb-toast-text'
    label.textContent = text
    el.append(label)
    if (onDismiss) {
      const x = document.createElement('span')
      x.className = 'wb-toast-dismiss'
      x.textContent = '✕'
      x.title = x.ariaLabel = 'Dismiss'
      el.append(x)
    }
    const close = () => el.remove()
    el.addEventListener('click', e => {
      if (onDismiss && (e.target as HTMLElement).closest('.wb-toast-dismiss')) {
        close()
        onDismiss()
        return
      }
      if (ms) close()
      onClick?.()
    })
    if (ms) setTimeout(close, ms)
    place(corner()).append(el)
    return {
      close,
      update: next => {
        label.textContent = next
      },
      hide: () => {
        el.hidden = true
      },
      show: () => {
        if (!el.isConnected) place(corner()).append(el)
        el.hidden = false
      },
    }
  }
}
