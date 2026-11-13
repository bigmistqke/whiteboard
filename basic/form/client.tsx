// Renders a plain <form name=…>. Submitting it is the engine's job; this component only
// pre-fills the last submission and shows which button was used and when.
import { createMemo, For, Match, Show, Switch, untrack } from 'solid-js'
import { solid, useWhiteboard } from '@bigmistqke/whiteboard/solid'
import type { Field, FormProps, Option } from './index'

type Data = Record<string, unknown>

function isChecked(data: Data, field: Field, option?: Option) {
  if (!(field.name in data)) return option ? option.checked : false
  const v = data[field.name]
  if (!option) return !!v
  return Array.isArray(v) ? v.includes(option.value) : v === option.value
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
    </form>
  )
}

export default solid(Form)
