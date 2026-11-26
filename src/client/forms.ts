// Named forms: whiteboard's one interaction primitive, in the browser. A `<form name>` without an
// `action` (one with an action submits normally) is a question; submitting it appends an event
// whose type is the form's name, the button its `action` and the fields its `data`. This holds on
// every page.
//
// What the core does with such a form, without drawing anything:
// - sends a submit as an event, shown at once (optimistic), and says how that went: `data-wb-state`
//   is sending (shown, not yet confirmed), sent or failed (taken back);
// - keeps what the reader typed until it is sent (localStorage, per page and form), across
//   re-renders and reloads;
// - puts the last answer back into the form, and its button in `data-wb-sent`;
// - marks where the form stands, from the log and the listeners, with one of these attributes:
//     data-wb-open      no answer yet, or the agent asks again (a wait asks for it by name after
//                       its answer was handled)
//     data-wb-pending   answered, but no agent has received the answer yet
//     data-wb-received  an agent received the answer, and hasn't handled it yet
//     data-wb-handled   the agent handled its latest answer; data-wb-outcome quotes it in one line
// and, for a few seconds after a send went through, `data-wb-just-sent`, to confirm it
//
// How that looks is the page's: it styles the attributes, and can follow `api.forms.on`. A form
// marked `data-wb-self` (or inside an element that is) keeps its own fields: no drafts and no last
// answer are written into it, for a block's component that shows them itself.
import type { Api, FormState, FormStatus } from '../define'
import { STATES, isQuestionName, questionState } from '../status.ts'
import { reactive } from './reactive'
import { storageKey } from './base.ts'

type Data = Record<string, unknown>

let root: HTMLElement
let api: Api
let page = ''

/** The forms the core looks after: named (a name without a colon: see isQuestionName), without an action. */
const managed = (form: HTMLFormElement) =>
  isQuestionName(form.getAttribute('name') ?? '') && !form.hasAttribute('action')
const forms = () => [...root.querySelectorAll('form')].filter(managed)
const keepsOwnFields = (form: HTMLFormElement) => !!form.closest('[data-wb-self]')

// ---- reading and writing a form ----------------------------------------------------------------

// An option for an answer not on the list (`:radio[Other]{name=… other}`): a radio or checkbox
// marked `data-wb-other`, with a text box (`data-wb-other-text`, no name of its own) in its label.
// It sends what was typed; typing picks it; an answer that is none of the other options goes back
// into its box.
const otherText = (option: HTMLInputElement) =>
  option.closest('label')?.querySelector<HTMLInputElement>('[data-wb-other-text]') ?? null
const isOther = (el: Element): boolean => el instanceof HTMLInputElement && el.hasAttribute('data-wb-other')

function readForm(form: HTMLFormElement): Data {
  const data: Data = {}
  const elements = [...form.elements] as HTMLInputElement[]
  const boxes: Record<string, number> = {}
  for (const el of elements) if (el.name && el.type === 'checkbox') boxes[el.name] = (boxes[el.name] ?? 0) + 1
  for (const el of elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'file') continue
    // an other-option sends what was typed in its box: read, not written into the option (for a
    // radio or checkbox that would change its value attribute, and so the page's HTML)
    const value = isOther(el) ? (otherText(el)?.value.trim() ?? '') : el.value
    if (el.type === 'checkbox') {
      if (boxes[el.name] > 1) {
        const list = (data[el.name] ??= []) as string[]
        if (el.checked) list.push(value)
      } else data[el.name] = el.checked
    } else if (el.type === 'radio') {
      if (el.checked) data[el.name] = value
      else data[el.name] ??= null
    } else if ((el as unknown) instanceof HTMLSelectElement && (el as unknown as HTMLSelectElement).multiple) {
      data[el.name] = [...(el as unknown as HTMLSelectElement).selectedOptions].map(o => o.value)
    } else data[el.name] = el.value
  }
  return data
}

function writeForm(form: HTMLFormElement, data: Data) {
  const elements = [...form.elements] as HTMLInputElement[]
  // what the listed options of a name send, so an answer that is none of them is the other one's
  const listed = (name: string) =>
    elements
      .filter(e => e.name === name && !isOther(e) && (e.type === 'radio' || e.type === 'checkbox'))
      .map(e => e.value)
  for (const el of elements) {
    if (!el.name || !(el.name in data) || ['submit', 'button', 'hidden', 'file'].includes(el.type)) continue
    const v = data[el.name]
    if (isOther(el)) {
      const own = listed(el.name)
      const rest = (Array.isArray(v) ? v : [v]).filter(
        x => typeof x === 'string' && x !== '' && !own.includes(x),
      ) as string[]
      el.checked = rest.length > 0
      const text = otherText(el)
      if (text && text !== document.activeElement) text.value = rest.join(', ')
      continue
    }
    if (el.type === 'checkbox') el.checked = Array.isArray(v) ? v.includes(el.value) : !!v
    else if (el.type === 'radio') el.checked = v === el.value
    else el.value = v == null ? '' : String(v)
  }
}

/** Typing in an other-option's box picks it (and an empty box, for a checkbox, unpicks it). */
function onOtherInput(e: Event) {
  const text = e.target as HTMLInputElement
  if (!text.matches?.('[data-wb-other-text]')) return
  const option = text.closest('label')?.querySelector<HTMLInputElement>('[data-wb-other]')
  if (!option) return
  if (text.value.trim()) option.checked = true
  else if (option.type === 'checkbox') option.checked = false
}

// ---- drafts ------------------------------------------------------------------------------------

const draftKey = (form: HTMLFormElement) => storageKey(`wb-draft:${page}:${form.getAttribute('name')}`)

function saveDraft(e: Event) {
  const form = (e.target as Element | null)?.closest?.('form')
  if (!form || !managed(form) || !root.contains(form) || keepsOwnFields(form)) return
  try {
    localStorage.setItem(draftKey(form), JSON.stringify(readForm(form)))
  } catch {
    /* storage unavailable */
  }
}

/** Unsent drafts back into their forms; a form being typed in is left alone. */
function restoreDrafts() {
  for (const form of forms()) {
    if (keepsOwnFields(form) || form.contains(document.activeElement)) continue
    let draft: Data | null = null
    try {
      draft = JSON.parse(localStorage.getItem(draftKey(form)) ?? 'null')
    } catch {
      /* storage unavailable */
    }
    if (draft) writeForm(form, draft)
  }
}

const dropDraft = (form: HTMLFormElement) => {
  try {
    localStorage.removeItem(draftKey(form))
  } catch {
    /* storage unavailable */
  }
}

/** Each form's last answer: its button in data-wb-sent, and with `prefill` its fields. */
function restoreLast(prefill: boolean) {
  for (const form of forms()) {
    const last = api.last(form.getAttribute('name')!)
    if (!last) continue
    form.dataset.wbSent = last.action ?? ''
    if (prefill && !keepsOwnFields(form)) writeForm(form, last.data)
  }
}

/** What each form is sending now, as sent: the same answer again is not sent twice. */
const inFlight = new WeakMap<HTMLFormElement, string>()

// The button that sent it says how that goes, in its own text and colour (`data-wb-send` on it):
// "Sending…" (grey) while on its way, "✓ Sent" (green) a moment once the server has it, then its own
// label again; "Try again" (red) when no try got through, until it is pressed. It keeps its width
// meanwhile.
type Send = 'sending' | 'sent' | 'failed'
/** A button's own label, while it says how a send goes. */
const labelOf = (button: HTMLButtonElement) => {
  const el = document.createElement('div')
  el.innerHTML = labels.get(button)!.html
  return el.textContent?.trim() ?? ''
}
const SEND_TEXT: Record<Send, string> = { sending: 'Sending…', sent: '✓ Sent', failed: 'Try again' }
const labels = new WeakMap<HTMLButtonElement, { html: string; timer?: ReturnType<typeof setTimeout> }>()

function sendState(button: HTMLButtonElement | null, state: Send | null) {
  if (!button) return
  let saved = labels.get(button)
  clearTimeout(saved?.timer)
  if (!state) {
    if (!saved) return
    button.innerHTML = saved.html
    button.style.minWidth = ''
    delete button.dataset.wbSend
    labels.delete(button)
    return
  }
  if (!saved) {
    saved = { html: button.innerHTML }
    labels.set(button, saved)
    button.style.minWidth = `${button.getBoundingClientRect().width}px`
  }
  button.dataset.wbSend = state
  button.textContent = SEND_TEXT[state]
  // confirmed: said for a moment, then the button is itself again
  if (state === 'sent') saved.timer = setTimeout(() => sendState(button, null), 2000)
}

// Optimistic: the answer is the form's at once (api.append puts it in the events, so the form is
// marked pending), with `data-wb-state="sending"` saying it is still on its way, and its button
// saying so (sendState); `sent` once the server has it, with the short `data-wb-just-sent` to
// confirm it. Should it not get through, the answer leaves the form again: `failed`, the button
// the form had before, the draft kept.
async function onSubmit(e: SubmitEvent) {
  const form = e.target as HTMLFormElement
  if (!managed(form) || !root.contains(form)) return
  e.preventDefault()
  const button = e.submitter as HTMLButtonElement | null
  // its label as it is, not as it says how a send goes
  const label = button ? (labels.get(button) ? labelOf(button) : button.textContent?.trim()) : null
  const action = button ? button.value || label || null : null
  const data = readForm(form)
  const sent = JSON.stringify([action, data])
  if (inFlight.get(form) === sent) return
  inFlight.set(form, sent)
  const before = form.dataset.wbSent
  form.dataset.wbState = 'sending'
  form.dataset.wbSent = action ?? ''
  form.removeAttribute('data-wb-just-sent')
  sendState(button, 'sending')
  showStatus(form)
  try {
    await api.append(form.getAttribute('name')!, data, action)
    if (inFlight.get(form) !== sent) return // a newer answer took its place
    dropDraft(form)
    form.dataset.wbState = 'sent'
    sendState(button, 'sent')
    // for the page to confirm the send: set for a few seconds after it
    form.toggleAttribute('data-wb-just-sent', true)
    clearTimeout(justSent.get(form))
    justSent.set(
      form,
      setTimeout(() => {
        form.removeAttribute('data-wb-just-sent')
        showStatus(form)
      }, 3000),
    )
    showStatus(form)
  } catch (err) {
    if (inFlight.get(form) !== sent) return
    form.dataset.wbState = 'failed'
    sendState(button, 'failed')
    if (before == null) delete form.dataset.wbSent
    else form.dataset.wbSent = before
    showStatus(form)
    console.error(err)
  } finally {
    if (inFlight.get(form) === sent) inFlight.delete(form)
  }
}

// ---- where each form stands --------------------------------------------------------------------

// What a sent answer came to, said beside the form's last send button, where the eye is when it is
// pressed (a line over the form was out of view below a long list of options): `.wb-form-status`,
// "waiting for an agent to receive it", or `data-kind="bad"` "couldn't send it". Never what the
// button says already (sendState): nothing while sending, no "sent".
const sendButtons = (form: HTMLFormElement) =>
  [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type=submit]')].filter(
    b => (b instanceof HTMLInputElement || (b.type !== 'button' && b.type !== 'reset')) && b.form === form,
  )

function showStatus(form: HTMLFormElement) {
  const text =
    form.dataset.wbState === 'failed'
      ? (["couldn't send it", 'bad'] as const)
      : form.dataset.wbState === 'sending'
        ? null
        : form.hasAttribute('data-wb-pending')
          ? (['waiting for an agent to receive it', null] as const)
          : form.hasAttribute('data-wb-received')
            ? (['the agent has it', null] as const)
            : null
  let el = form.querySelector<HTMLElement>('.wb-form-status')
  const last = sendButtons(form).at(-1)
  if (!text || !last) return void el?.remove()
  if (!el) el = Object.assign(document.createElement('span'), { className: 'wb-form-status' })
  el.setAttribute('role', 'status')
  if (el.previousElementSibling !== last) last.after(el)
  el.textContent = text[0]
  if (text[1]) el.dataset.kind = text[1]
  else delete el.dataset.kind
}

const ATTR: Record<FormState, string> = {
  open: 'data-wb-open',
  pending: 'data-wb-pending',
  received: 'data-wb-received',
  handled: 'data-wb-handled',
}

/** One line quoting an answer: what was chosen, then what was written. */
/**
 * An answer, told apart: the button it was sent with (none for a plain Send), what was chosen
 * (options, short values), and what was written.
 */
export function answerParts(
  data: Data,
  action: string | null,
): { action: string | null; chosen: string[]; written: string[] } {
  const chosen: string[] = [],
    written: string[] = []
  // a key with a colon is no field's: it says where the answer came from (a chat's message), not what
  for (const [k, v] of Object.entries(data)) {
    if (k.includes(':') || v == null || v === '' || v === false) continue
    if (Array.isArray(v)) {
      if (v.length) chosen.push(v.join(', '))
    } else if (v === true) continue
    else if (String(v).length > 60 || String(v).includes('\n')) written.push(String(v))
    else chosen.push(String(v))
  }
  return { action: action && !['Send', 'Submit'].includes(action) ? action : null, chosen, written }
}

/** One line quoting an answer: what was chosen, then what was written. */
function outcome(data: Data, action: string | null) {
  const { action: button, chosen, written } = answerParts(data, action)
  return [
    [button, ...chosen].filter(Boolean).join(' · ') || 'sent',
    ...written.map(w => `“${w.length > 240 ? w.slice(0, 240) + '…' : w}”`),
  ].join('\n')
}

let current: FormStatus[] = []
const justSent = new WeakMap<HTMLFormElement, ReturnType<typeof setTimeout>>()

/** Mark every form from the log and the listeners, then tell whoever follows. */
function mark() {
  const listening = api.listeners()
  current = forms().map(form => {
    const name = form.getAttribute('name')!
    const { state, last } = questionState(name, api.events(), listening, api.marks)
    for (const st of STATES) form.toggleAttribute(ATTR[st], st === state)
    if (state === 'received' || state === 'handled') form.dataset.wbOutcome = outcome(last!.data, last!.action)
    else delete form.dataset.wbOutcome
    showStatus(form)
    return { form, name, state, last }
  })
  forms_.notify()
}

/** After the page re-rendered: answers, drafts and marks back on its forms. */
function refresh() {
  restoreLast(false)
  restoreDrafts()
  mark()
}

/** Look after the page's named forms; called once the page has mounted. */
export function trackForms(el: HTMLElement, pageId: string, core: Api) {
  root = el
  page = pageId
  api = core
  // before the draft is saved: what was typed picks its option
  document.addEventListener('input', onOtherInput)
  document.addEventListener('input', saveDraft)
  document.addEventListener('change', saveDraft)
  document.addEventListener('submit', onSubmit)
  api.onRendered(refresh)
  api.listeners.on(mark)
  api.events.on(() => {
    restoreLast(false)
    mark()
  })
  restoreLast(true)
  restoreDrafts()
  mark()
}

/** For the api: every named form and where it stands, as it changes. */
const forms_ = reactive((): FormStatus[] => current)
export const formsApi = { forms: forms_ }
