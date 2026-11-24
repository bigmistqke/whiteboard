// Chats no longer on the page. A chat is found by its name: a form's chat by the form's, a chat
// block by its own. So when the writer removes or renames one, what the reader and the agent said in
// it would vanish from the page without a trace. The page lists those chats after its
// content instead, read-only and folded: the agent can still answer in one (`whiteboard append --type
// chat:message`), and prunes one it is done with (`whiteboard chat prune <page> <name>`).
import type { Api, WbEvent } from '../../define.ts'
import { html, raw } from '../../html.ts'

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
    // folded: talk left over from questions taken off the page, kept for whoever wants it. It says
    // which of the agent's unread messages it holds (data-wb-holds), so the corner's "→ unread" goes
    // to it and opens it (wb-reveal); each agent message is marked (data-wb-message), so it is read
    // once in view, as anywhere on the page.
    const open = box.querySelector('details')?.open ?? false
    const unread = new Set(api.unread().map(e => e.id))
    const holds = [...threads.values()].flat().filter(m => unread.has(m.id)).map(m => m.id)
    box.innerHTML = String(
      html`<details ${open ? raw('open') : ''} data-wb-holds="${holds.join(' ')}">
        <summary>${threads.size} chat${threads.size === 1 ? '' : 's'} no longer on this page</summary>
        ${[...threads].map(([chat, messages]) => {
          // a message can take the place of an earlier one (`replaces`), to correct it
          const replaced = new Set(
            messages
              .map(m => m.data.replaces)
              .filter(Boolean)
              .map(String),
          )
          return html`<div class="wb-orphan" data-chat="${chat}">
            <h3>${chat}</h3>
            ${messages
              .filter(m => !replaced.has(m.id))
              .map(m => {
                const who = m.from === 'cli' ? 'agent' : 'you'
                const mark = who === 'agent' ? html` data-wb-message="${m.id}"` : ''
                return html`<div class="wb-orphan-message" data-from="${who}"${mark}>
                  <span class="wb-orphan-who">${who}</span
                  ><span class="wb-orphan-text">${String(m.data.text ?? '')}</span>
                </div>`
              })}
          </div>`
        })}
      </details>`,
    )
  }

  // gone to from the corner: open, and bring the first unread message into view
  box.addEventListener('wb-reveal', () => {
    const details = box.querySelector('details')
    if (!details) return
    details.open = true
    const unread = new Set(api.unread().map(e => e.id))
    const first = [...box.querySelectorAll<HTMLElement>('[data-wb-message]')].find(m =>
      unread.has(m.dataset.wbMessage!),
    )
    requestAnimationFrame(() => first?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  })

  api.events.on(draw)
  api.onRendered(draw)
  draw()
}
