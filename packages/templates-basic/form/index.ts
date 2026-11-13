// ```form <name>  — a line-based shorthand for a named form. See README.md for the syntax.
import type { FenceContext, Template } from '@visualize/engine/template'

export interface Option { value: string; checked: boolean }
export interface Field {
  type: 'text' | 'textarea' | 'number' | 'date' | 'range' | 'select' | 'radio' | 'checkbox' | 'hidden' | 'help'
  name: string
  /** HTML */
  label: string
  placeholder: string
  options: Option[]
}
export interface FormProps { name: string; fields: Field[]; buttons: string[] }

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
      ? extra.split(',').map(s => s.trim()).filter(Boolean).map(o => (o.startsWith('*') ? { value: o.slice(1).trim(), checked: true } : { value: o, checked: false }))
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
  return '<div class="vz-form vz-form-pending"></div>'
}

export default {
  name: 'form',
  props,
  html,
  client: new URL('./client.tsx', import.meta.url),
  style: new URL('./style.css', import.meta.url),
  readme: new URL('./README.md', import.meta.url),
} satisfies Template
