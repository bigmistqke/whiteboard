// :::form{name=…} — a named form whose body is ordinary markdown, with inputs written inline anywhere in
// it: `:radio[This **week**]{name=when}`, `:check[…]`, `:text[…]`, `:button[Send]` and so on. See
// README.md.
//
// Everything here renders on the server as plain HTML: a `<form name>` the core looks after (it
// sends a submit as an event, keeps drafts, puts the last answer back and marks where the form
// stands, which the page shows). The chat under the form is the chat plugin's.
import fs from 'node:fs'
import { definePlugin, type Plugin } from '@bigmistqke/whiteboard'
import { html, raw, type Block, type DirectiveContext } from '@bigmistqke/whiteboard'
import { chatThread } from '../chat/index.ts'
import { isQuestionName } from '../../src/status.ts'
import { builtinPublic } from '../../src/package.ts'

const style = 'style.css'

const CHOICES = new Set(['radio', 'check', 'select', 'hidden'])

interface Node { type: string; name?: string; attributes?: Record<string, string>; children?: Node[] }

/** The inputs written inside a form's markdown (forms inside it excluded: forms don't nest). */
function inputsOf(nodes: Node[]) {
  const found: { name: string; attrs: Record<string, string> }[] = []
  const walk = (node: Node) => {
    if ((node.type === 'textDirective' || node.type === 'leafDirective') && node.name) found.push({ name: node.name, attrs: node.attributes ?? {} })
    if (node.type === 'containerDirective' && node.name === 'form') return
    for (const child of node.children ?? []) walk(child)
  }
  nodes.forEach(walk)
  return found
}

const recommendedTag = html`<span class="wb-form-recommended">recommended</span>`

const form: Block = {
  style,
  async html(ctx) {
    const c = ctx as DirectiveContext
    const name = c.attrs.name || c.attrs.id || 'form'
    // a colon marks the events of whiteboard or a plugin (`chat:message`), never an answer
    if (!isQuestionName(name)) throw new Error(`form name "${name}" has a colon: those names are reserved for events of whiteboard and plugins`)
    const inputs = inputsOf(c.children as Node[])
    const choices = [...new Set(inputs.filter(i => CHOICES.has(i.name) && i.attrs.name).map(i => i.attrs.name))]
    const hasButton = inputs.some(i => i.name === 'button')
    // the first button is the form's primary one; the markup is the button block's own
    const body = (await c.toHtml(c.children)).replace('<button name="action"', '<button class="wb-primary" name="action"')
    // the form's chat: talk about the question, named after the form (see ../chat)
    const thread = await chatThread(c, name, { choices })
    return html`<form name="${name}" class="wb-form">${raw(body)}${!hasButton && html`<p><button class="wb-primary">Send</button></p>`}${raw(thread)}</form>`
  },
}

/** The label of an inline input as HTML, else its fallback. */
const labelOf = (c: DirectiveContext, fallback = '') => (c.label ? raw(c.label) : fallback)

/**
 * :radio[label]{name=… value=… recommended checked} and :check[…]{…}. With `other`, an answer not on
 * the list: the option has a text box, typing in it picks the option, and it sends what was typed
 * (the core's forms.ts, `data-wb-other`).
 */
const option = (type: 'radio' | 'checkbox'): Block['html'] => (ctx) => {
  const c = ctx as DirectiveContext
  if ('other' in c.attrs) {
    const placeholder = c.attrs.placeholder ?? 'something else'
    return html`<label class="wb-form-option wb-form-other"><input type="${type}" name="${c.attrs.name}" value="" data-wb-other><span class="wb-form-option-label">${labelOf(c, 'Other')}</span><input type="text" class="wb-form-other-text" data-wb-other-text placeholder="${placeholder}" aria-label="${c.labelText ?? 'Other'}"></label>`
  }
  const value = c.attrs.value ?? c.labelText ?? ''
  return html`<label class="wb-form-option"><input type="${type}" name="${c.attrs.name}" value="${value}"${'checked' in c.attrs && raw(' checked')}><span class="wb-form-option-label">${labelOf(c, value)}</span>${'recommended' in c.attrs && recommendedTag}</label>`
}

/** :text[label]{name=… placeholder=…}, and number, date, range */
const field = (type: string): Block['html'] => (ctx) => {
  const c = ctx as DirectiveContext
  const extra = ['placeholder', 'min', 'max', 'step', 'value'].filter(k => k in c.attrs).map(k => html` ${raw(k)}="${c.attrs[k]}"`)
  return html`<label class="wb-form-field"><span class="wb-form-label">${labelOf(c)}</span><input type="${type}" name="${c.attrs.name}"${extra}></label>`
}

const input = (name: string, render: Block['html']): [string, Block] => [name, { html: render, style }]

const inputs: [string, Block][] = [
  input('radio', option('radio')),
  input('check', option('checkbox')),
  input('text', field('text')),
  input('number', field('number')),
  input('date', field('date')),
  input('range', field('range')),
  input('textarea', (ctx) => {
    const c = ctx as DirectiveContext
    return html`<label class="wb-form-field"><span class="wb-form-label">${labelOf(c)}</span><textarea name="${c.attrs.name}" rows="3" placeholder="${c.attrs.placeholder ?? ''}">${c.attrs.value ?? ''}</textarea></label>`
  }),
  input('select', (ctx) => {
    const c = ctx as DirectiveContext
    const options = (c.attrs.options ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return html`<label class="wb-form-field"><span class="wb-form-label">${labelOf(c)}</span><select name="${c.attrs.name}">${options.map(o => html`<option${o === c.attrs.value && raw(' selected')}>${o}</option>`)}</select></label>`
  }),
  input('hidden', (ctx) => {
    const c = ctx as DirectiveContext
    return html`<input type="hidden" name="${c.attrs.name}" value="${c.attrs.value ?? ''}">`
  }),
  input('button', (ctx) => {
    const c = ctx as DirectiveContext
    const value = c.labelText ?? 'Send'
    return html`<button name="action" value="${value}">${labelOf(c, 'Send')}</button>`
  }),
]

export default function formPlugin(): Plugin {
  return definePlugin({
    name: 'form',
    public: builtinPublic('form'),
    blocks: { form, ...Object.fromEntries(inputs) },
    docs: () => fs.readFileSync(new URL('./README.md', import.meta.url), 'utf8'),
  })
}
