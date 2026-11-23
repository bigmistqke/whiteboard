// Toasts (api.toast): short labels in the page's corner (api.corner(), above what covers the bottom
// of the window) that say what is going on and take the reader there: "→ unanswered (2)",
// "↓ new (3)", "Sent, but no agent is listening". One goes after a few seconds, or on a click; one
// with `ms: 0` stays until closed, and changes its text, or hides and shows again, through what
// toast() returns. A click runs `onClick` (and closes a toast that goes by itself); `onDismiss`
// adds a ✕ that runs it and closes the toast. A toast stays short: what more there is to say goes in
// `details`, which a ▸ unfolds under it; unfolded, it doesn't go by itself until folded again. Their look is the core's (server.ts), in the page's
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
    { kind = 'info', ms = 7000, onClick, onDismiss, name, order = 0, details }: ToastOptions = {},
  ): Toast {
    const el = document.createElement('button')
    let timer: ReturnType<typeof setTimeout> | undefined
    const close = () => {
      clearTimeout(timer)
      el.remove()
    }
    el.type = 'button'
    el.className = 'wb-toast'
    el.dataset.kind = kind
    if (name) el.dataset.toast = name
    el.style.order = String(order)
    const label = document.createElement('span')
    label.className = 'wb-toast-text'
    label.textContent = text
    el.append(label)
    let more: HTMLElement | null = null
    let detail: HTMLElement | null = null
    if (details) {
      more = document.createElement('span')
      more.className = 'wb-toast-more'
      detail = document.createElement('span')
      detail.className = 'wb-toast-details'
      detail.textContent = details
      // read out with the toast, folded or not
      el.setAttribute('aria-description', details)
      el.append(more, detail)
      fold(false)
    }
    function fold(open: boolean) {
      el.toggleAttribute('data-open', open)
      detail!.hidden = !open
      more!.textContent = open ? '▾' : '▸'
      more!.title = open ? 'Less' : 'More'
      // being read: it stays; folded again, it goes as it would have
      clearTimeout(timer)
      if (!open && ms) timer = setTimeout(close, ms)
    }
    if (onDismiss) {
      const x = document.createElement('span')
      x.className = 'wb-toast-dismiss'
      x.textContent = '✕'
      x.title = x.ariaLabel = 'Dismiss'
      el.append(x)
    }
    el.addEventListener('click', e => {
      const target = e.target as HTMLElement
      if (onDismiss && target.closest('.wb-toast-dismiss')) {
        close()
        onDismiss()
        return
      }
      // the ▸, or the details themselves: fold or unfold, nothing else
      if (details && target.closest('.wb-toast-more, .wb-toast-details')) return fold(!el.hasAttribute('data-open'))
      if (ms) close()
      onClick?.()
    })
    if (ms && !details) timer = setTimeout(close, ms)
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
