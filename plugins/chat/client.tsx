// A chat (rendered by the chat block, on its own or under a form): the reader writes, the agent
// answers (`whiteboard append --type chat:message --data '{"chat":"<name>","text":"…"}'`). A message
// is a `chat:message` event, never an answer, so talking about a form's choice never makes it.
import { createMemo, For, Loading } from 'solid-js'
import { solid, useWhiteboard } from '@bigmistqke/whiteboard/solid'
import type { ChatProps } from './index'
import type { WbEvent } from '@bigmistqke/whiteboard'
import { autosize } from './autosize'

/** A message in a chat: the chat block's own event type. */
const MESSAGE = 'chat:message'

interface Message {
  id: string
  from: 'you' | 'agent'
  text: string
}

/**
 * What the reader wrote in a submit of a form: every text in it that is not one of the form's
 * choices (also from a field the form no longer has).
 */
function written(submit: WbEvent, choiceNames: string[]) {
  const choices = new Set(choiceNames)
  return Object.entries(submit.data)
    .filter(([k, v]) => !choices.has(k) && typeof v === 'string' && v.trim())
    .map(([, v]) => String(v).trim())
    .join('\n\n')
}

function Chat(props: ChatProps) {
  const wb = useWhiteboard()
  // The chat's messages in order. A message can take the place of an earlier one (`replaces` its
  // id), to correct it. Under a form, a message can answer something the reader wrote in a submit
  // of the form (`replyTo` its id): that text shows as theirs, right before the answer.
  const messages = createMemo((): Message[] => {
    const events = wb.events()
    const own = events.filter(e => e.type === MESSAGE && e.data.chat === props.chat)
    const replaced = new Set(
      own
        .map(e => e.data.replaces)
        .filter(Boolean)
        .map(String),
    )
    const out: Message[] = []
    for (const e of own) {
      if (replaced.has(e.id)) continue
      const to =
        props.form && e.data.replyTo ? events.find(x => x.id === e.data.replyTo && x.type === props.form) : undefined
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
    await wb.append(MESSAGE, { chat: props.chat, text })
    box!.value = ''
    // measure again: a value set from code fires no input event
    box!.dispatchEvent(new Event('input'))
  }
  return (
    // a div, not a form: forms don't nest, and the box has no name, so it is never part of an answer
    <div class="wb-chat" data-under-form={props.form ? '' : undefined}>
      <For each={messages()}>
        {m => (
          // the reader's messages on the right, the agent's on the left
          // the agent's: read once in view (the core marks it, see EventSpec.forReader)
          <div class="wb-chat-message" data-from={m.from} data-wb-message={m.from === 'agent' ? m.id : undefined}>
            <span class="wb-chat-who">{m.from}</span>
            <Bubble text={m.text} />
          </div>
        )}
      </For>
      <div class="wb-chat-new">
        <textarea
          ref={[el => (box = el), autosize({ maxRows: 10 })]}
          rows={1}
          placeholder={props.form ? "Ask about this question (doesn't choose anything)" : 'Write a message'}
          // Enter sends, Shift+Enter starts a new line; not while an input method is composing
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              post()
            }
          }}
        />
        <button type="button" onClick={post}>
          {props.form ? 'Ask' : 'Send'}
        </button>
      </div>
    </div>
  )
}

/** A message as markdown, rendered by the server; its plain text until then. */
function Bubble(props: { text: string }) {
  const wb = useWhiteboard()
  const md = createMemo(() => wb.markdown(props.text))
  return (
    <Loading fallback={<div class="wb-chat-bubble">{props.text}</div>}>
      <div class="wb-chat-bubble" data-md="" innerHTML={md()} />
    </Loading>
  )
}

export default solid(Chat)
