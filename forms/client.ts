// Named forms, in the browser: on every page, whatever renderer drew it, a `<form name>` without an
// `action` sends a submit as an event of its type (the form's name), keeps what the reader typed until
// it is sent, and gets its last answer back. And it shows what an agent waits for: each form is
// marked waiting, unheard, sent or decided, a line above the page sums that up, a button jumps
// from one waiting form to the next, and the tab title counts them.
//
// A form waits for the reader when a listener asks for it by name (also when it was answered
// before: the agent wants a new answer), or when a listener takes any answer on the page and the
// form has none yet.
//
// What this adds to a form is in `data-wb-*` attributes, put back after each re-render
// (`api.onRendered`). A form inside a template island looks after its own last answer.
import type { Api, ExtensionMount, PageHandle } from '../src/define'

type FormData = Record<string, unknown>

/** The bottom of the part of the window the page is seen in: above what covers it (`--wb-inset-bottom`). */
function viewBottom(): number {
  const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--wb-inset-bottom')) || 0
  return Math.max(0, innerHeight - inset)
}

let root: HTMLElement
let api: Api
let page = ''

/** Forms this looks after: named, no action attribute (those submit normally). */
const managed = (form: HTMLFormElement) => !!form.getAttribute('name') && !form.hasAttribute('action')
const forms = () => [...root.querySelectorAll('form')].filter(managed)

// ---- reading and writing a form ----------------------------------------------------------------

function readForm(form: HTMLFormElement): FormData {
  const data: FormData = {}
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
    } else if ((el as unknown) instanceof HTMLSelectElement && (el as unknown as HTMLSelectElement).multiple) data[el.name] = [...(el as unknown as HTMLSelectElement).selectedOptions].map(o => o.value)
    else data[el.name] = el.value
  }
  return data
}

function writeForm(form: HTMLFormElement, data: FormData) {
  for (const el of [...form.elements] as HTMLInputElement[]) {
    if (!el.name || !(el.name in data) || ['submit', 'button', 'hidden', 'file'].includes(el.type)) continue
    const v = data[el.name]
    if (el.type === 'checkbox') el.checked = Array.isArray(v) ? v.includes(el.value) : !!v
    else if (el.type === 'radio') el.checked = v === el.value
    else el.value = v == null ? '' : String(v)
  }
}

// ---- drafts ------------------------------------------------------------------------------------
// What the reader typed and has not sent yet survives a reload of the page and a re-render of the
// form: it is kept per page and form in localStorage until the form is sent.

const draftKey = (form: HTMLFormElement) => `wb-draft:${page}:${form.getAttribute('name')}`

function saveDraft(e: Event) {
  const form = (e.target as Element | null)?.closest?.('form')
  if (!form || !managed(form) || !root.contains(form)) return
  try { localStorage.setItem(draftKey(form), JSON.stringify(readForm(form))) } catch { /* storage unavailable */ }
}

/** Put unsent drafts back into their forms; a form being typed in is left alone. */
function restoreDrafts() {
  for (const form of forms()) {
    if (form.contains(document.activeElement)) continue
    let draft: FormData | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey(form)) ?? 'null') } catch { /* storage unavailable */ }
    if (draft) writeForm(form, draft)
  }
}

const dropDraft = (form: HTMLFormElement) => { try { localStorage.removeItem(draftKey(form)) } catch { /* storage unavailable */ } }

/** Plain forms get their last submission back; a form inside a template island handles this itself. */
function restoreLast(prefill: boolean) {
  for (const form of forms()) {
    if (form.closest('[data-wb-island]')) continue
    const last = api.last(form.getAttribute('name')!)
    if (!last) continue
    form.dataset.wbSent = last.action ?? ''
    if (prefill) writeForm(form, last.data)
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

// ---- what waits for the reader -----------------------------------------------------------------

// A form is in one of four states:
//   waiting    an agent is listening and wants its answer
//   unheard    no answer, and no agent is listening
//   sent       answered, but no agent has picked the answer up yet
//   decided    an agent picked up its latest answer: the form folds into one line quoting it
type State = 'waiting' | 'unheard' | 'sent' | 'decided'
const ORDER: State[] = ['waiting', 'unheard', 'sent', 'decided']
const LABEL: Record<State, (n: number) => string> = {
  waiting: n => `${n} waiting for you`,
  unheard: n => `${n} nobody listening`,
  sent: n => `${n} waiting for the agent`,
  decided: n => `${n} decided`,
}
const STATE_ATTR: Record<State, string> = { waiting: 'data-wb-waiting', unheard: 'data-wb-unheard', sent: 'data-wb-pending', decided: 'data-wb-decided' }
const stateOf = (form: HTMLFormElement): State => ORDER.find(st => form.hasAttribute(STATE_ATTR[st])) ?? 'sent'
const formsIn = (state: State) => forms().filter(f => stateOf(f) === state)

// forms the reader opened again to change their answer, by name, with the answer they opened:
// they stay open until a newer answer is decided
const reopened = new Map<string, string>()

/** One line quoting an answer: what was chosen, then what was written. */
function outcome(data: Record<string, unknown>, action: string | null) {
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

const button = document.createElement('button')
button.type = 'button'
button.className = 'wb-waiting-next'
button.hidden = true

// above the page's content: right before its <main> when it has one, else first in the root
const summary = document.createElement('div')
summary.className = 'wb-summary'
summary.hidden = true

/** Mark the page's forms from the current listeners and answers. */
function applyWaiting() {
  const listeners = api.listeners()
  for (const form of forms()) {
    const name = form.getAttribute('name')!
    const last = api.last(name)
    const asked = listeners.some(l => l.type === name)
    const any = listeners.some(l => l.type === null)
    const picked = !!last && api.pickedUp(last.id)
    // a form opened again stays open until a newer answer of it is decided
    if (last && reopened.has(name) && reopened.get(name) !== last.id && picked) reopened.delete(name)
    const state: State =
      asked || (any && !last) ? 'waiting'
      : !last ? 'unheard'
      : picked ? 'decided'
      : 'sent'
    for (const st of ORDER) form.toggleAttribute(STATE_ATTR[st], st === state)
    form.toggleAttribute('data-wb-folded', state === 'decided' && !reopened.has(name))
    if (state === 'decided') form.dataset.wbOutcome = outcome(last!.data, last!.action)
    else delete form.dataset.wbOutcome
  }
  const n = formsIn('waiting').length
  const parts = ORDER.map(state => [state, formsIn(state).length] as const).filter(([, count]) => count)
  summary.hidden = !parts.length
  summary.replaceChildren(...parts.flatMap(([state, count], i) => {
    const link = document.createElement('button')
    link.type = 'button'
    link.dataset.state = state
    link.textContent = LABEL[state](count)
    return i ? [document.createTextNode(' · '), link] : [link]
  }))
  button.hidden = n === 0
  button.textContent = `→ waiting for you (${n})`
  api.badge('forms', n ? `!${n}` : null, -1)
}

// The form a jump went to last, and where the page was scrolled then: jumping again in the same
// state goes to the one after it, round to the first. Once the reader scrolled themselves, the
// next one is the first below where they are.
let current: HTMLFormElement | null = null
let scrolledTo = 0

function next(state: State) {
  const list = formsIn(state)
  const i = current ? list.indexOf(current) : -1
  if (i >= 0 && Math.abs(scrollY - scrolledTo) < 40) return list[(i + 1) % list.length]
  return list.find(f => f.getBoundingClientRect().top > viewBottom() / 2) ?? list[0]
}

function jump(state: State) {
  const form = next(state)
  if (!form) return
  current = form
  // the form centred in the part of the window the page is seen in (above the terminal drawer),
  // as far as the page allows
  const r = form.getBoundingClientRect()
  scrolledTo = Math.max(0, Math.min(scrollY + r.top + r.height / 2 - viewBottom() / 2, document.documentElement.scrollHeight - innerHeight))
  scrollTo({ top: scrolledTo, behavior: 'smooth' })
  if (state === 'waiting') form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select, button')?.focus({ preventScroll: true })
}

// ---- mount -------------------------------------------------------------------------------------

function placeSummary() {
  const content = root.querySelector('main')
  if (content ? summary.nextElementSibling === content : summary.parentElement === root) return
  if (content) content.before(summary)
  else root.prepend(summary)
}

/** After the renderer patched the page: the forms' answers, drafts and marks, back in place. */
function refresh() {
  placeSummary()
  restoreLast(false)
  restoreDrafts()
  applyWaiting()
}

const mount: ExtensionMount = (el: HTMLElement, handle: PageHandle, core: Api) => {
  root = el
  api = core
  page = handle.id
  // the overview and folders have no forms of their own
  if (handle.kind !== 'page' && handle.kind !== 'file') return

  document.addEventListener('input', saveDraft)
  document.addEventListener('change', saveDraft)
  document.addEventListener('submit', onSubmit)

  api.corner().prepend(button)
  button.addEventListener('click', () => jump('waiting'))
  placeSummary()
  summary.addEventListener('click', e => {
    const state = (e.target as HTMLElement).closest<HTMLElement>('button[data-state]')?.dataset.state as State | undefined
    if (state) jump(state)
  })
  // a folded form opens again on a click, to change the answer
  root.addEventListener('click', e => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-wb-folded]')
    if (!form) return
    e.preventDefault()
    const last = api.last(form.getAttribute('name')!)
    if (last) reopened.set(form.getAttribute('name')!, last.id)
    applyWaiting()
    form.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus({ preventScroll: true })
  })

  api.onRendered(refresh)
  api.onListeners(applyWaiting)
  api.onEvents(() => { restoreLast(false); applyWaiting() })
  restoreLast(true)
  restoreDrafts()
  applyWaiting()
}

export default mount
