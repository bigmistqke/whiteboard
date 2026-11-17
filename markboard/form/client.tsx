// The thread under a form (rendered by the form template as plain HTML around this island): the
// reader asks about the question, the agent answers
// (`whiteboard append --type form:thread --data '{"form":"<name>","text":"…"}'`). A message is a `form:thread`
// event of its own, never a submit of the form, so talking about a choice never makes it.
import { createMemo, For } from 'solid-js'
import { solid, useWhiteboard } from '@bigmistqke/whiteboard/solid'
import type { ThreadProps } from './index'
import type { WbEvent } from '@bigmistqke/whiteboard/template'
import { autosize } from './autosize'

/** A message in a form's thread: the form template's own event type. */
const THREAD = 'form:thread'

interface Message { id: string; from: 'you' | 'agent'; text: string }

/**
 * What the reader wrote in a submit of the form: every text in it that is not one of the form's
 * choices (also from a field the form no longer has).
 */
function written(submit: WbEvent, choiceNames: string[]) {
  const choices = new Set(choiceNames)
  return Object.entries(submit.data)
    .filter(([k, v]) => !choices.has(k) && typeof v === 'string' && v.trim())
    .map(([, v]) => String(v).trim())
    .join('\n\n')
}

function Thread(props: ThreadProps) {
  const wb = useWhiteboard()
  // The thread's messages in order. A message can answer something the reader wrote in a submit of
  // the form (`replyTo` its id): that text shows as theirs, right before the answer. A message can
  // take the place of an earlier one (`replaces` its id), to correct it.
  const messages = createMemo((): Message[] => {
    const events = wb.events()
    const own = events.filter(e => e.type === THREAD && e.data.form === props.form)
    const replaced = new Set(own.map(e => e.data.replaces).filter(Boolean).map(String))
    const out: Message[] = []
    for (const e of own) {
      if (replaced.has(e.id)) continue
      const to = e.data.replyTo ? events.find(x => x.id === e.data.replyTo && x.type === props.form) : undefined
      const asked = to ? written(to, props.choices) : ''
      if (to && asked && !out.some(m => m.id === to.id)) out.push({ id: to.id, from: 'you', text: asked })
      out.push({ id: e.id, from: e.from === 'cli' ? 'agent' : 'you', text: String(e.data.text ?? '') })
    }
    return out
  })
  let box: HTMLTextAreaElement | undefined
  const post = async () => {
    const text = box?.value.trim()
    if (!text) return
    await wb.append(THREAD, { form: props.form, text })
    box!.value = ''
    // measure again: a value set from code fires no input event
    box!.dispatchEvent(new Event('input'))
  }
  return (
    // a div, not a form: forms don't nest, and the box has no name, so it is never part of the answer
    <div class="wb-form-thread">
      <For each={messages()}>
        {m => (
          // a chat: the reader's messages on the right, the agent's on the left
          <div class="wb-chat-message" data-from={m.from}>
            <span class="wb-chat-who">{m.from}</span>
            <div class="wb-chat-bubble">{m.text}</div>
          </div>
        )}
      </For>
      <div class="wb-form-thread-new">
        <textarea
          ref={[el => (box = el), autosize({ maxRows: 10 })]}
          rows={1}
          placeholder="Ask about this question (doesn't choose anything)"
          // Enter sends, Shift+Enter starts a new line; not while an input method is composing
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); post() } }}
        />
        <button type="button" onClick={post}>Ask</button>
      </div>
    </div>
  )
}

export default solid(Thread)
