// Threads whose form is no longer on the page. A form's thread is attached to it by name, so when
// the writer removes or renames a form, what the reader and the agent said about it would vanish
// from the page without a trace. markboard lists those threads after the page's content instead,
// read-only: the agent can still answer in one (`whiteboard append --type form:thread`).
import type { Api, WbEvent } from '../../src/define'
import { html } from '../../src/html.ts'

/** A thread message: the form template's event, or what it was called before (`thread`). */
const isThread = (e: WbEvent) => (e.type === 'form:thread' || e.type === 'thread') && typeof e.data.form === 'string'

export function trackOrphanThreads(main: HTMLElement, api: Api) {
  // after the page's content, not in it: #wb-main is compared block by block on every update
  const box = document.createElement('section')
  box.className = 'wb-orphans'
  box.hidden = true
  main.after(box)

  function draw() {
    const onPage = new Set([...main.querySelectorAll('form[name]')].map(f => f.getAttribute('name')))
    const threads = new Map<string, WbEvent[]>()
    for (const e of api.events()) {
      const form = String(e.data.form)
      if (!isThread(e) || onPage.has(form)) continue
      threads.set(form, [...(threads.get(form) ?? []), e])
    }
    box.hidden = threads.size === 0
    if (box.hidden) return box.replaceChildren()
    box.innerHTML = String(html`<h2>Threads of questions no longer on this page</h2>
${[...threads].map(([form, messages]) => {
  // a message can take the place of an earlier one (`replaces`), to correct it
  const replaced = new Set(messages.map(m => m.data.replaces).filter(Boolean).map(String))
  return html`<div class="wb-orphan" data-form="${form}"><h3>${form}</h3>${messages.filter(m => !replaced.has(m.id)).map(m => {
    const who = m.from === 'cli' ? 'agent' : 'you'
    return html`<div class="wb-orphan-message" data-from="${who}"><span class="wb-orphan-who">${who}</span><span class="wb-orphan-text">${String(m.data.text ?? '')}</span></div>`
  })}</div>`
})}`)
  }

  api.onEvents(draw)
  api.onRendered(draw)
  draw()
}
