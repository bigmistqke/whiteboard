// ```form <name>  — a line-based shorthand for a named form. See README.md for the syntax.
import type { FenceContext, Template } from '@bigmistqke/whiteboard/template'

export interface Option {
  /** what is sent: the label as plain text */
  value: string
  /** the label as HTML (inline markdown); for an option with a description */
  label: string
  /** preselected (a plain option marked with `*`) */
  checked: boolean
  /** the writer's recommendation (an option with a description marked with `*`): tagged, never
   * preselected, so a send without a pick leaves the choice open */
  recommended: boolean
  /** what choosing it means, as HTML; empty for a plain option */
  description: string
}
export interface Field {
  type: 'text' | 'textarea' | 'number' | 'date' | 'range' | 'select' | 'radio' | 'checkbox' | 'hidden' | 'help'
  name: string
  /** HTML */
  label: string
  placeholder: string
  options: Option[]
}
export interface FormProps { name: string; fields: Field[]; buttons: string[] }

/** HTML from inline markdown → its text: what an option sends. */
const plain = (html: string) => html.replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

const FIELD = /^(text|textarea|number|date|range|select|radio|checkbox|hidden|submit):\s*(.*)$/

export async function props(ctx: FenceContext): Promise<FormProps> {
  const bare = Object.keys(ctx.attrs).find(k => ctx.attrs[k] === '')
  const name = ctx.attrs.name || bare || 'form'
  const inline = ctx.inline
  const fields: Field[] = []
  let buttons: string[] | null = null
  for (const raw of ctx.text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // `- label | what it means` under a select, radio or checkbox: an option with its explanation
    const choice = /^[-*]\s+(.*)$/.exec(line)
    const owner = fields.at(-1)
    if (choice && owner && ['select', 'radio', 'checkbox'].includes(owner.type)) {
      const [label, ...rest] = choice[1].split('|')
      const value = label.trim()
      const recommended = value.startsWith('*')
      const html = await inline(recommended ? value.slice(1).trim() : value)
      owner.options.push({ value: plain(html), label: html, checked: false, recommended, description: rest.length ? await inline(rest.join('|').trim()) : '' })
      continue
    }
    const m = FIELD.exec(line)
    if (!m) {
      fields.push({ type: 'help', name: '', label: await inline(line), placeholder: '', options: [] })
      continue
    }
    const type = m[1] as Field['type'] | 'submit'
    const seg = m[2].split('|').map(s => s.trim())
    if (type === 'submit') {
      buttons = seg[0].split(',').map(s => s.trim()).filter(Boolean)
      continue
    }
    const [fieldName, label = fieldName, extra = ''] = seg
    const options = ['select', 'radio', 'checkbox'].includes(type)
      ? extra.split(',').map(s => s.trim()).filter(Boolean).map(o => (o.startsWith('*') ? { value: o.slice(1).trim(), label: '', checked: true, recommended: false, description: '' } : { value: o, label: '', checked: false, recommended: false, description: '' }))
      : []
    fields.push({
      type,
      name: fieldName,
      label: type === 'hidden' ? label : await inline(label),
      placeholder: options.length ? '' : extra,
      options,
    })
  }
  return { name, fields, buttons: buttons ?? ['Send'] }
}

/** Shown until the component mounts. */
export function html() {
  return '<div class="wb-form wb-form-pending"></div>'
}

export default {
  name: 'form',
  props,
  html,
  client: new URL('./client.js', import.meta.url),
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
