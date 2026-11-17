// Named forms: whiteboard's one interaction primitive, in the browser. A `<form name>` without an
// `action` (one with an action submits normally) is a question; submitting it appends an event
// whose type is the form's name, the button its `action` and the fields its `data`. This holds on
// every page, whatever renderer drew it.
//
// What the core does with such a form, without drawing anything:
// - sends a submit as an event, and says how that went: `data-wb-state` is sending, sent or failed;
// - keeps what the reader typed until it is sent (localStorage, per page and form), across
//   re-renders and reloads;
// - puts the last answer back into the form, and its button in `data-wb-sent`;
// - marks where the form stands, from the log and the listeners, with one of these attributes:
//     data-wb-waiting   an agent is listening and wants its answer (also when it was answered
//                       before: the agent wants a new one), or takes any answer and it has none
//     data-wb-unheard   no answer, and no agent is listening
//     data-wb-pending   answered, but no agent has picked the answer up yet
//     data-wb-decided   an agent picked up its latest answer; data-wb-outcome quotes it in one line
//
// How that looks is the renderer's: it styles the attributes, and can follow `api.onForms`. A form
// marked `data-wb-self` (or inside an element that is) keeps its own fields: no drafts and no last
// answer are written into it, for a renderer's component that shows them itself.
import type { Api, FormState, FormStatus } from '../define'
import { STATES, isQuestionName, questionState } from '../status.ts'

type Data = Record<string, unknown>

let root: HTMLElement
let api: Api
let page = ''
const listeners = new Set<(forms: FormStatus[]) => void>()

/** The forms the core looks after: named (a name without a colon: see isQuestionName), without an action. */
const managed = (form: HTMLFormElement) => isQuestionName(form.getAttribute('name') ?? '') && !form.hasAttribute('action')
const forms = () => [...root.querySelectorAll('form')].filter(managed)
const keepsOwnFields = (form: HTMLFormElement) => !!form.closest('[data-wb-self]')

// ---- reading and writing a form ----------------------------------------------------------------

function readForm(form: HTMLFormElement): Data {
  const data: Data = {}
  const elements = [...form.elements] as HTMLInputElement[]
  const boxes: Record<string, number> = {}
  for (const el of elements) if (el.name && el.type === 'checkbox') boxes[el.name] = (boxes[el.name] ?? 0) + 1
  for (const el of elements) {
    if (!el.name || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'file') continue
    if (el.type === 'checkbox') {
      if (boxes[el.name] > 1) { const list = (data[el.name] ??= []) as string[]; if (el.checked) list.push(el.value) }
      else data[el.name] = el.checked
    } else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value
      else data[el.name] ??= null
    } else if ((el as unknown) instanceof HTMLSelectElement && (el as unknown as HTMLSelectElement).multiple) {
      data[el.name] = [...(el as unknown as HTMLSelectElement).selectedOptions].map(o => o.value)
    } else data[el.name] = el.value
  }
  return data
}

function writeForm(form: HTMLFormElement, data: Data) {
  for (const el of [...form.elements] as HTMLInputElement[]) {
    if (!el.name || !(el.name in data) || ['submit', 'button', 'hidden', 'file'].includes(el.type)) continue
    const v = data[el.name]
    if (el.type === 'checkbox') el.checked = Array.isArray(v) ? v.includes(el.value) : !!v
    else if (el.type === 'radio') el.checked = v === el.value
    else el.value = v == null ? '' : String(v)
  }
}

// ---- drafts ------------------------------------------------------------------------------------

const draftKey = (form: HTMLFormElement) => `wb-draft:${page}:${form.getAttribute('name')}`

function saveDraft(e: Event) {
  const form = (e.target as Element | null)?.closest?.('form')
  if (!form || !managed(form) || !root.contains(form) || keepsOwnFields(form)) return
  try { localStorage.setItem(draftKey(form), JSON.stringify(readForm(form))) } catch { /* storage unavailable */ }
}

/** Unsent drafts back into their forms; a form being typed in is left alone. */
function restoreDrafts() {
  for (const form of forms()) {
    if (keepsOwnFields(form) || form.contains(document.activeElement)) continue
    let draft: Data | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey(form)) ?? 'null') } catch { /* storage unavailable */ }
    if (draft) writeForm(form, draft)
  }
}

const dropDraft = (form: HTMLFormElement) => { try { localStorage.removeItem(draftKey(form)) } catch { /* storage unavailable */ } }

/** Each form's last answer: its button in data-wb-sent, and with `prefill` its fields. */
function restoreLast(prefill: boolean) {
  for (const form of forms()) {
    const last = api.last(form.getAttribute('name')!)
    if (!last) continue
    form.dataset.wbSent = last.action ?? ''
    if (prefill && !keepsOwnFields(form)) writeForm(form, last.data)
  }
}

async function onSubmit(e: SubmitEvent) {
  const form = e.target as HTMLFormElement
  if (!managed(form) || !root.contains(form)) return
  e.preventDefault()
  const button = e.submitter as HTMLButtonElement | null
  const action = button ? button.value || button.textContent?.trim() || null : null
  form.dataset.wbState = 'sending'
  try {
    await api.append(form.getAttribute('name')!, readForm(form), action)
    dropDraft(form)
    form.dataset.wbState = 'sent'
    form.dataset.wbSent = action ?? ''
  } catch (err) {
    form.dataset.wbState = 'failed'
    console.error(err)
  }
}

// ---- where each form stands --------------------------------------------------------------------

const ATTR: Record<FormState, string> = { waiting: 'data-wb-waiting', unheard: 'data-wb-unheard', pending: 'data-wb-pending', decided: 'data-wb-decided' }

/** One line quoting an answer: what was chosen, then what was written. */
function outcome(data: Data, action: string | null) {
  const chosen: string[] = [], written: string[] = []
  for (const v of Object.values(data)) {
    if (v == null || v === '' || v === false) continue
    if (Array.isArray(v)) { if (v.length) chosen.push(v.join(', ')) }
    else if (v === true) continue
    else if (String(v).length > 60 || String(v).includes('\n')) written.push(String(v))
    else chosen.push(String(v))
  }
  if (action && !['Send', 'Submit'].includes(action)) chosen.unshift(action)
  return [chosen.join(' · ') || 'sent', ...written.map(w => `“${w.length > 240 ? w.slice(0, 240) + '…' : w}”`)].join('\n')
}

let current: FormStatus[] = []

/** Mark every form from the log and the listeners, then tell whoever follows. */
function mark() {
  const waitingFor = api.listeners()
  current = forms().map(form => {
    const name = form.getAttribute('name')!
    const { state, last } = questionState(name, api.events(), waitingFor, api.pickedUp)
    for (const st of STATES) form.toggleAttribute(ATTR[st], st === state)
    if (state === 'decided') form.dataset.wbOutcome = outcome(last!.data, last!.action)
    else delete form.dataset.wbOutcome
    return { form, name, state, last }
  })
  for (const fn of listeners) fn(current)
}

/** After the renderer re-rendered: answers, drafts and marks back on its forms. */
function refresh() {
  restoreLast(false)
  restoreDrafts()
  mark()
}

/** Look after the page's named forms; called once the renderer has mounted. */
export function trackForms(el: HTMLElement, pageId: string, core: Api) {
  root = el
  page = pageId
  api = core
  document.addEventListener('input', saveDraft)
  document.addEventListener('change', saveDraft)
  document.addEventListener('submit', onSubmit)
  api.onRendered(refresh)
  api.onListeners(mark)
  api.onEvents(() => { restoreLast(false); mark() })
  restoreLast(true)
  restoreDrafts()
  mark()
}

/** For the api: every named form and where it stands, and following that. */
export const formsApi = {
  forms: (): FormStatus[] => current,
  onForms(fn: (forms: FormStatus[]) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
}
