// Chats no longer on the page. A chat is found by its name: a form's chat by the form's, a chat
// block by its own. So when the writer removes or renames one, what the reader and the agent said in
// it would vanish from the page without a trace. The page lists those chats after its
// content instead, read-only: the agent can still answer in one (`whiteboard append --type chat:message`).
import type { Api, WbEvent } from '../../define.ts'
import { html } from '../../html.ts'

/** A message in a chat: the chat block's event. */
const isMessage = (e: WbEvent) => e.type === 'chat:message' && typeof e.data.chat === 'string'

export function trackOrphanThreads(main: HTMLElement, api: Api) {
  // after the page's content, not in it: #wb-main is compared block by block on every update
  const box = document.createElement('section')
  box.className = 'wb-orphans'
  box.hidden = true
  main.after(box)

  function draw() {
    // the chats on the page: one under every form, and the chat blocks
    const onPage = new Set([
      ...[...main.querySelectorAll('form[name]')].map(f => f.getAttribute('name')),
      ...[...main.querySelectorAll('[data-chat]')].map(c => c.getAttribute('data-chat')),
    ])
    const threads = new Map<string, WbEvent[]>()
    for (const e of api.events()) {
      const chat = String(e.data.chat)
      if (!isMessage(e) || onPage.has(chat)) continue
      threads.set(chat, [...(threads.get(chat) ?? []), e])
    }
    box.hidden = threads.size === 0
    if (box.hidden) return box.replaceChildren()
    box.innerHTML = String(html`<h2>Chats no longer on this page</h2>
${[...threads].map(([chat, messages]) => {
  // a message can take the place of an earlier one (`replaces`), to correct it
  const replaced = new Set(messages.map(m => m.data.replaces).filter(Boolean).map(String))
  return html`<div class="wb-orphan" data-chat="${chat}"><h3>${chat}</h3>${messages.filter(m => !replaced.has(m.id)).map(m => {
    const who = m.from === 'cli' ? 'agent' : 'you'
    return html`<div class="wb-orphan-message" data-from="${who}"><span class="wb-orphan-who">${who}</span><span class="wb-orphan-text">${String(m.data.text ?? '')}</span></div>`
  })}</div>`
})}`)
  }

  api.onEvents(draw)
  api.onRendered(draw)
  draw()
}
