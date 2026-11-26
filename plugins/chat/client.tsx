// A chat (rendered by the chat block, on its own or under a form): the reader writes, the agent
// answers (`whiteboard append --type chat:message --data '{"chat":"<name>","text":"…"}'`). A message
// is a `chat:message` event, never an answer, so talking about a form's choice never makes it. But
// under a form, an agent's message marked `answer` has a button that answers the form with its
// text, for an answer the two settled on in the chat that is none of the form's options.
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
  /** shown at once, but the server hasn't confirmed it yet */
  sending?: boolean
  /** the agent's, marked as an answer the reader can give the form with */
  answer?: boolean
}

/** The key of a form's answer that names the message it came from (a colon: never a field's name). */
const FROM_MESSAGE = 'chat:message'

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
      out.push({
        id: e.id,
        from: e.from === 'cli' ? 'agent' : 'you',
        text: String(e.data.text ?? ''),
        sending: !!e.sending,
        answer: !!props.form && e.from === 'cli' && e.data.answer === true,
      })
    }
    return out
  })
  // the message the form's latest answer came from, if it came from one
  const answeredWith = createMemo(() => {
    const last = props.form ? wb.events().findLast(e => e.type === props.form) : undefined
    return last ? String(last.data[FROM_MESSAGE] ?? '') : ''
  })
  /** Answer the form with a message's text, as a submit of it would. */
  const answerWith = async (m: Message) => {
    try {
      await wb.append(props.form!, { answer: m.text, [FROM_MESSAGE]: m.id })
    } catch (err) {
      console.error(err)
      wb.toast("Couldn't send the answer", { kind: 'alert', name: 'chat-answer-failed', details: 'Press it again.' })
    }
  }
  let box: HTMLTextAreaElement | undefined
  const post = async () => {
    const text = box?.value.trim()
    if (!text) return
    // optimistic: the message is in the chat at once, grey until the server has it, and the box is
    // empty, so a second Send has nothing to send again
    const write = (value: string) => {
      box!.value = value
      // measure again: a value set from code fires no input event
      box!.dispatchEvent(new Event('input'))
    }
    write('')
    try {
      await wb.append(MESSAGE, { chat: props.chat, text })
    } catch (err) {
      console.error(err)
      // it never got there: back into the box, unless something else was written meanwhile
      if (!box!.value.trim()) write(text)
      wb.toast("Couldn't send the message", {
        kind: 'alert',
        name: 'chat-failed',
        details: "It's back in the box: send it again.",
      })
    }
  }
  return (
    // a div, not a form: forms don't nest, and the box has no name, so it is never part of an answer
    <div class="wb-chat" data-under-form={props.form ? '' : undefined}>
      {/* keyed by id: a new message adds its own element and leaves the others be (the list is
          built anew on every event, so by identity each message would be drawn again, and its
          markdown with it, moving the page under the reader) */}
      <For each={messages()} keyed={m => m.id}>
        {m => (
          // the reader's messages on the right, the agent's on the left
          // the agent's: read once in view (the core marks it, see EventSpec.forReader)
          <div
            class="wb-chat-message"
            data-from={m().from}
            data-sending={m().sending ? '' : undefined}
            data-wb-message={m().from === 'agent' ? m().id : undefined}
          >
            <span class="wb-chat-who">{m().from}</span>
            <Bubble text={m().text} />
            {m().answer && (
              <button
                type="button"
                class="wb-chat-answer"
                disabled={answeredWith() === m().id}
                onClick={() => answerWith(m())}
              >
                {answeredWith() === m().id ? '✓ The answer' : 'Answer with this'}
              </button>
            )}
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
