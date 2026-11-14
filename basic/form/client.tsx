// Renders a plain <form name=…>. Submitting it is the engine's job; this component only
// pre-fills the last submission and shows which button was used and when.
//
// Each form has a thread under it: the reader asks about the question, the agent answers
// (`whiteboard append --type thread --data '{"form":"<name>","text":"…"}'`). A message is a
// `thread` event of its own, never a submit of the form, so talking about a choice never makes it.
import { createMemo, For, Match, Show, Switch, untrack } from 'solid-js'
import { solid, useWhiteboard } from '@bigmistqke/whiteboard/solid'
import type { Field, FormProps, Option } from './index'
import type { WbEvent } from '@bigmistqke/whiteboard/template'

type Data = Record<string, unknown>

function isChecked(data: Data, field: Field, option?: Option) {
  if (!(field.name in data)) return option ? option.checked : false
  const v = data[field.name]
  if (!option) return !!v
  return Array.isArray(v) ? v.includes(option.value) : v === option.value
}

interface Message { id: string; from: 'you' | 'agent'; text: string }

/**
 * What the reader wrote in a submit of the form: every text in it that is not one of the form's
 * choices (also from a field the form no longer has).
 */
function written(submit: WbEvent, fields: Field[]) {
  const choices = new Set(fields.filter(f => ['radio', 'checkbox', 'select', 'hidden'].includes(f.type)).map(f => f.name))
  return Object.entries(submit.data)
    .filter(([k, v]) => !choices.has(k) && typeof v === 'string' && v.trim())
    .map(([, v]) => String(v).trim())
    .join('\n\n')
}

function Thread(props: { form: string; fields: Field[] }) {
  const wb = useWhiteboard()
  // The thread's messages in order. A message can answer something the reader wrote in a submit of
  // the form (`replyTo` its id): that text shows as theirs, right before the answer. A message can
  // take the place of an earlier one (`replaces` its id), to correct it.
  const messages = createMemo((): Message[] => {
    const events = wb.events()
    const own = events.filter(e => e.type === 'thread' && e.data.form === props.form)
    const replaced = new Set(own.map(e => e.data.replaces).filter(Boolean).map(String))
    const out: Message[] = []
    for (const e of own) {
      if (replaced.has(e.id)) continue
      const to = e.data.replyTo ? events.find(x => x.id === e.data.replyTo && x.type === props.form) : undefined
      const asked = to ? written(to, props.fields) : ''
      if (to && asked && !out.some(m => m.id === to.id)) out.push({ id: to.id, from: 'you', text: asked })
      out.push({ id: e.id, from: e.from === 'cli' ? 'agent' : 'you', text: String(e.data.text ?? '') })
    }
    return out
  })
  let box: HTMLTextAreaElement | undefined
  const post = async () => {
    const text = box?.value.trim()
    if (!text) return
    await wb.append('thread', { form: props.form, text })
    box!.value = ''
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
          ref={el => (box = el)}
          rows={1}
          placeholder="Ask about this question (doesn't choose anything)"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post() } }}
        />
        <button type="button" onClick={post}>Ask</button>
      </div>
    </div>
  )
}

function Form(props: FormProps) {
  const wb = useWhiteboard()
  const last = createMemo(() => wb.last(props.name))
  // fields start from the last submission; later submits never overwrite what is being typed
  const initial = untrack((): Data => last()?.data ?? {})
  const text = (f: Field) => (f.name in initial ? String(initial[f.name] ?? '') : '')

  return (
    <form name={props.name} class={['wb-form', { 'wb-form-answered': !!last() }]}>
      <For each={props.fields}>
        {f => (
          <Switch>
            <Match when={f.type === 'help'}>
              <div class="wb-form-help" innerHTML={f.label} />
            </Match>
            <Match when={f.type === 'hidden'}>
              <input type="hidden" name={f.name} value={f.label} />
            </Match>
            <Match when={f.type === 'textarea'}>
              <label class="wb-form-field">
                <span class="wb-form-label" innerHTML={f.label} />
                <textarea name={f.name} rows={3} placeholder={f.placeholder} value={text(f)} />
              </label>
            </Match>
            <Match when={f.type === 'select'}>
              <label class="wb-form-field">
                <span class="wb-form-label" innerHTML={f.label} />
                <select name={f.name}>
                  <For each={f.options}>{o => <option value={o.value} selected={isChecked(initial, f, o)}>{o.value}</option>}</For>
                </select>
              </label>
            </Match>
            <Match when={f.type === 'checkbox' && !f.options.length}>
              <label class="wb-form-check">
                <input type="checkbox" name={f.name} checked={isChecked(initial, f)} />
                <span innerHTML={f.label} />
              </label>
            </Match>
            <Match when={(f.type === 'radio' || f.type === 'checkbox' || f.type === 'select') && f.options.some(o => o.description)}>
              {/* options with explanations: each one a row to choose, its meaning right beside it */}
              <fieldset class="wb-form-field">
                <legend class="wb-form-label" innerHTML={f.label} />
                <div class="wb-form-choices">
                  <For each={f.options}>
                    {o => (
                      <label class="wb-form-choice">
                        <input type={f.type === 'checkbox' ? 'checkbox' : 'radio'} name={f.name} value={o.value} checked={isChecked(initial, f, o)} />
                        <span class="wb-form-choice-text">
                          <span class="wb-form-choice-title">
                            <span innerHTML={o.label} />
                            <Show when={o.recommended}><span class="wb-form-recommended">recommended</span></Show>
                          </span>
                          <Show when={o.description}><span class="wb-form-choice-description" innerHTML={o.description} /></Show>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </fieldset>
            </Match>
            <Match when={f.type === 'radio' || f.type === 'checkbox'}>
              <fieldset class="wb-form-field">
                <legend class="wb-form-label" innerHTML={f.label} />
                <div class="wb-form-options">
                  <For each={f.options}>
                    {o => (
                      <label class="wb-form-check">
                        <input type={f.type} name={f.name} value={o.value} checked={isChecked(initial, f, o)} />
                        {o.value}
                      </label>
                    )}
                  </For>
                </div>
              </fieldset>
            </Match>
            <Match when={true}>
              <label class="wb-form-field">
                <span class="wb-form-label" innerHTML={f.label} />
                <input type={f.type} name={f.name} placeholder={f.placeholder} value={text(f)} />
              </label>
            </Match>
          </Switch>
        )}
      </For>
      <div class="wb-form-actions">
        <For each={props.buttons}>
          {(b, i) => (
            <button type="submit" name="action" value={b} class={{ 'wb-primary': i() === 0, 'wb-chosen': last()?.action === b }}>
              {b}
            </button>
          )}
        </For>
      </div>
      <Show when={last()}>
        {l => (
          <div class="wb-form-status">
            ✓ sent <Show when={l().action}><b>{l().action}</b></Show> · {new Date(l().ts).toLocaleString()}
          </div>
        )}
      </Show>
      <Thread form={props.name} fields={props.fields} />
    </form>
  )
}

export default solid(Form)
