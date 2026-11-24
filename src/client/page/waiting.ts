// How the page shows what waits for the reader: its open questions and the agent's messages they
// haven't read (status.ts). The core marks each named form with where it stands (open, pending, received,
// handled; see `api.forms.on`); the page styles those marks (base.css), folds a handled form into
// one line quoting its answer, counts them in the tab title, and puts two toasts in the page's corner, "→ unanswered (n)" for the questions and "→ unread
// (n)" for the messages, each going from one to the next; the second has a ✕ that puts it away
// until another message comes. A message is found on the page by its
// element (`data-wb-message`), or, when it isn't shown, by the element that holds it
// (`data-wb-holds`: a comment's badge), which is sent `wb-reveal` to show it. Arriving by a link that
// ends in `#wb-waiting` (the header's menu, the overview), the page goes to the first. An answer no
// agent is listening for says so once it is sent, in a toast: the form's own mark may be out of view.
import type { Api, FormState, FormStatus, Toast, WbEvent } from '../../define.ts'
import { answerParts } from '../forms'
import { viewBottom } from './view'
import { WAITING_HASH } from './elsewhere'

let main: HTMLElement
let api: Api
let forms: FormStatus[] = []

// forms the reader opened again to change their answer, by name, with the answer they opened:
// they stay open until a newer answer is handled
const reopened = new Map<string, string>()

const inState = (state: FormState) => forms.filter(f => f.state === state && f.form.isConnected).map(f => f.form)

/** Where an unread message is on the page: its own element, else the one holding it. */
function messageTarget(id: string): HTMLElement | null {
  const own = document.querySelector<HTMLElement>(`[data-wb-message="${CSS.escape(id)}"]`)
  if (own && own.getClientRects().length) return own
  return (
    [...document.querySelectorAll<HTMLElement>('[data-wb-holds]')].find(el =>
      el.dataset.wbHolds!.split(' ').includes(id),
    ) ?? null
  )
}

/** What waits for the reader, top to bottom: open forms and unread messages. */
function targets(kind: 'all' | 'messages' = 'all'): HTMLElement[] {
  const list = [
    ...new Set([
      ...(kind === 'all' ? inState('open') : []),
      ...api
        .unread()
        .map(e => messageTarget(e.id))
        .filter((el): el is HTMLElement => !!el),
    ]),
  ]
  const top = (el: HTMLElement) => el.getBoundingClientRect().top
  return list.sort((a, b) => top(a) - top(b))
}

// the corner's toasts: the questions waiting, and the agent's messages unread; each goes to the next
let waitingToast: Toast
let unreadToast: Toast
let toastTimer = 0
let unreadShown = false
// closed by its ✕: the messages unread then, by id. The toast stays away until one more comes; they
// stay unread (the tab title still counts them)
let dismissed: Set<string> | null = null

// A form an agent received folds into a card, since it is no longer the reader's to do: what was
// chosen, what was written under it (a few lines), and "received · change" while the agent is on it,
// "decided · change" once it handled it (a click on the card opens the form again). Its chat folds too, into
// "💬 n messages", opened by a click; a message from the agent the reader hasn't read opens it, and
// it stays open once read, until the reader folds it, so a reply never hides in the fold. The card is the page's, put back in the
// form after each update.
const chatsOpen = new Set<string>()

function card(form: HTMLFormElement, name: string, last: WbEvent, state: FormStatus['state']) {
  let el = form.querySelector<HTMLElement>(':scope > .wb-folded')
  if (!el) {
    el = document.createElement('div')
    el.className = 'wb-folded'
    el.innerHTML =
      '<div class="wb-folded-head"><span class="wb-folded-choice"></span><span class="wb-folded-change"></span></div><ul class="wb-folded-choices"></ul><div class="wb-folded-text"></div><button type="button" class="wb-folded-chat"></button>'
    form.prepend(el)
  }
  const { action, chosen, written } = answerParts(last.data, last.action)
  // One answer and no button: it is the title. Else the button it was sent with is the title (or
  // "answered"), and each answer a line under it. Nothing chosen, only written: the text is the
  // answer, said once.
  const list = action || chosen.length > 1 ? chosen : []
  const head = action ?? (chosen.length > 1 ? 'answered' : (chosen[0] ?? written.shift() ?? 'answered'))
  el.querySelector('.wb-folded-choice')!.textContent = `✓ ${head}`
  const choices = el.querySelector<HTMLElement>('.wb-folded-choices')!
  choices.replaceChildren(...list.map(c => Object.assign(document.createElement('li'), { textContent: c })))
  choices.hidden = !list.length
  el.querySelector('.wb-folded-change')!.textContent = state === 'received' ? 'received · change' : 'decided · change'
  const text = el.querySelector<HTMLElement>('.wb-folded-text')!
  text.textContent = written.join('\n\n')
  text.hidden = !written.length
  // the chat: how many messages, and open or folded
  const messages = api.events().filter(e => e.type === 'chat:message' && e.data.chat === name).length
  const thread = form.querySelector<HTMLElement>(':scope > [data-block=chat-thread]')
  const unreadHere =
    !!thread &&
    api
      .unread()
      .some(
        m =>
          thread.querySelector(`[data-wb-message="${CSS.escape(m.id)}"]`) ||
          (m.type === 'chat:message' && m.data.chat === name),
      )
  // a message to read opens it, and it stays open once read, until the reader folds it; and it
  // doesn't fold from under a message being written: its box has the focus, or text not sent yet
  const box = thread?.querySelector<HTMLTextAreaElement>('textarea')
  const writing = !!box && (document.activeElement === box || box.value.trim() !== '')
  if (unreadHere || writing) chatsOpen.add(name)
  const open = chatsOpen.has(name)
  form.toggleAttribute('data-wb-chat-open', open)
  const chat = el.querySelector<HTMLButtonElement>('.wb-folded-chat')!
  chat.hidden = !messages
  chat.textContent = `💬 ${messages} message${messages === 1 ? '' : 's'} ${open ? '▾' : '▸'}`
  chat.setAttribute('aria-expanded', String(open))
}

function show(list: FormStatus[] = forms) {
  forms = list
  for (const { form, name, state, last } of forms) {
    const done = state === 'received' || state === 'handled'
    if (last && reopened.has(name) && reopened.get(name) !== last.id && done) reopened.delete(name)
    const folded = done && !reopened.has(name)
    form.toggleAttribute('data-wb-folded', folded)
    if (folded && last) card(form, name, last, state)
    else {
      form.querySelector(':scope > .wb-folded')?.remove()
      form.removeAttribute('data-wb-chat-open')
    }
  }
  const unread = api.unread().length
  const n = inState('open').length + unread
  const questions = inState('open').length
  if (questions) {
    waitingToast.update(`→ unanswered (${questions})`)
    waitingToast.show()
  } else waitingToast.hide()
  api.badge('waiting', n ? `!${n}` : null, -1)
  // the agent's messages: a toast while there are any. It comes a moment late: a message that
  // arrives in view (an open thread) is read before it would show.
  clearTimeout(toastTimer)
  const ids = api.unread().map(e => e.id)
  if (dismissed && (!unread || ids.some(id => !dismissed!.has(id)))) dismissed = null
  if (dismissed) unreadToast.hide()
  else if (!unread) unreadToast.hide()
  else if (unreadShown) unreadToast.update(`→ unread (${unread})`)
  else
    toastTimer = window.setTimeout(() => {
      const left = api.unread().length
      if (!left) return
      unreadToast.update(`→ unread (${left})`)
      unreadToast.show()
      unreadShown = true
    }, 1000)
  if (!unread) unreadShown = false
  // arrived to answer: the first thing waiting, once the page knows (the log loads after the page)
  if (arriving && n) {
    arriving = false
    history.replaceState(history.state, '', location.pathname + location.search)
    requestAnimationFrame(() => {
      const first = targets()[0]
      if (first) jumpTo(first)
    })
  }
}

let arriving = location.hash === WAITING_HASH
// a page whose questions were answered meanwhile has none left to go to
setTimeout(() => {
  arriving = false
}, 5000)

// What a jump went to last, and where the page was scrolled then: jumping again goes to the one
// after it, round to the first. Once the reader scrolled themselves, the next one is the first
// below where they are.
let current: HTMLElement | null = null
let scrolledTo = 0

function next(list: HTMLElement[]) {
  const i = current ? list.indexOf(current) : -1
  if (i >= 0 && Math.abs(scrollY - scrolledTo) < 40) return list[(i + 1) % list.length]
  return list.find(f => f.getBoundingClientRect().top > viewBottom() / 2) ?? list[0]
}

function jump(what: 'open' | 'messages') {
  const list = what === 'messages' ? targets('messages') : inState('open')
  const target = next(list)
  if (target) jumpTo(target)
}

function jumpTo(target: HTMLElement) {
  current = target
  // centred in the part of the window the page is seen in (above the terminal drawer), as far as
  // the page allows
  const r = target.getBoundingClientRect()
  scrolledTo = Math.max(
    0,
    Math.min(scrollY + r.top + r.height / 2 - viewBottom() / 2, document.documentElement.scrollHeight - innerHeight),
  )
  scrollTo({ top: scrolledTo, behavior: 'smooth' })
  if (target instanceof HTMLFormElement) {
    if (target.hasAttribute('data-wb-open'))
      target
        .querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button')
        ?.focus({ preventScroll: true })
  } else target.dispatchEvent(new CustomEvent('wb-reveal', { bubbles: true }))
}

export function trackWaiting(root: HTMLElement, core: Api) {
  main = root
  api = core
  waitingToast = api.toast('', { ms: 0, name: 'waiting', order: -2, onClick: () => jump('open') })
  unreadToast = api.toast('', {
    ms: 0,
    name: 'unread',
    order: -1,
    onClick: () => jump('messages'),
    onDismiss: () => {
      dismissed = new Set(api.unread().map(e => e.id))
      unreadShown = false
    },
  })
  waitingToast.hide()
  unreadToast.hide()
  // a folded form opens again on a click, to change the answer; not on one in its thread, which
  // stays open under it
  main.addEventListener('click', e => {
    const target = e.target as HTMLElement
    const form = target.closest<HTMLFormElement>('form[data-wb-folded]')
    if (!form || target.closest('[data-block=chat-thread]')) return
    e.preventDefault()
    // its chat, folded or open: not the form
    if (target.closest('.wb-folded-chat')) {
      const name = form.getAttribute('name')!
      if (chatsOpen.has(name) || form.hasAttribute('data-wb-chat-open')) {
        chatsOpen.delete(name)
        form.removeAttribute('data-wb-chat-open')
      } else chatsOpen.add(name)
      show(forms)
      return
    }
    const name = form.getAttribute('name')!
    const last = api.last(name)
    if (last) reopened.set(name, last.id)
    show(forms)
    form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus({ preventScroll: true })
  })
  api.forms.on(show)
  // a message read, or a new one
  api.events.on(() => show())
  show(api.forms())
  document.addEventListener('submit', e => {
    const form = e.target as HTMLFormElement
    const name = form.getAttribute('name')
    if (!name || !main.contains(form) || !forms.some(f => f.form === form)) return
    // who listens as it is sent: an agent that takes it ends its wait right after
    const takes = (fallback: boolean) =>
      api.listeners().some(l => !!l.fallback === fallback && (l.type === name || l.type === null))
    if (takes(false)) return
    const fallback = takes(true)
    const sent = new MutationObserver(() => {
      if (form.dataset.wbState === 'sending') return
      sent.disconnect()
      if (form.dataset.wbState !== 'sent') return
      if (fallback)
        api.toast('Sent · to the fallback agent', {
          name: 'sent',
          details: 'No agent waits on this page, so the fallback agent receives it.',
        })
      else
        api.toast('Sent · no agent listening', {
          kind: 'warn',
          name: 'sent',
          details: 'Your answer stays in the log until an agent checks this page.',
        })
    })
    sent.observe(form, { attributes: true, attributeFilter: ['data-wb-state'] })
  })
}
