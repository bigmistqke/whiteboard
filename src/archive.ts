// An archived page (`whiteboard archive`): a page that did its job leaves the live pages, and what
// was answered on it stays readable without a server. Its file goes to `.whiteboard/archive/`, as
// the page's markdown with what happened on it written after: each form's answers with when they
// came (forms are the core's), then what each plugin makes of its own events there (a chat's
// messages, the comments: `Plugin.archive`). Then its events leave the log, as `destroy` does.
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin, WbEvent } from './define.ts'
import { isQuestionName } from './status.ts'

/** When it came, to the minute, in UTC: `2026-11-26 10:14`. */
export const when = (e: WbEvent) => e.ts.slice(0, 16).replace('T', ' ')

/** A list item: its head, then text on the lines under it, indented to stay in the item. */
export const item = (head: string, text = '') =>
  `- ${head}${text.trim() ? `\n\n${text.trim().replace(/^/gm, '  ')}` : ''}`

/** One answer to a form, in a line: its fields as given, and the button when it was another than Send. */
function answer(e: WbEvent) {
  // a key with a colon is no field's: where the answer came from (a chat's message), not what
  const own = Object.entries(e.data).filter(([k]) => !k.includes(':'))
  const fields = own
    .filter(([, v]) => v != null && v !== '' && v !== false && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => {
      const value = Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : String(v)
      return value.includes('\n') ? null : `${k}: ${value}`
    })
  const long = own.filter(([, v]) => typeof v === 'string' && v.includes('\n'))
  const button = e.action && !['Send', 'Submit'].includes(e.action) ? [`(${e.action})`] : []
  const line = [...fields.filter(Boolean), ...button].join(' · ') || 'sent'
  return item(`${when(e)}: ${line}`, long.map(([k, v]) => `${k}:\n\n${v}`).join('\n\n'))
}

/** The forms' answers: the reader's events of a question's type, by form, in the order they came. */
function answers(events: WbEvent[]) {
  const byForm = new Map<string, WbEvent[]>()
  for (const e of events)
    if (isQuestionName(e.type) && e.from !== 'cli') byForm.set(e.type, [...(byForm.get(e.type) ?? []), e])
  if (!byForm.size) return ''
  return ['## Answers', ...[...byForm].map(([form, list]) => `### ${form}\n\n${list.map(answer).join('\n')}`)].join(
    '\n\n',
  )
}

/** The archived page: its markdown, then what was answered on it. */
export async function archived(options: {
  page: string
  source: string
  events: WbEvent[]
  plugins: Plugin[]
  at?: Date
}): Promise<string> {
  const { page, source, events, plugins, at = new Date() } = options
  const parts = [answers(events)]
  for (const p of plugins) if (p.archive) parts.push((await p.archive(events))?.trim() ?? '')
  const said = parts.filter(Boolean)
  return [
    source.trimEnd(),
    '---',
    `# Archived`,
    `The page \`${page}\`, archived ${at.toISOString().slice(0, 16).replace('T', ' ')} (UTC), with what was answered on it.`,
    ...(said.length ? said : ['Nothing was answered on it.']),
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}

/** Where an archived page goes: `.whiteboard/archive/<page>-<date>.md`, `-2` and on for another that day. */
export function archiveFile(wb: string, page: string, at = new Date()) {
  const base = path.join(wb, 'archive', `${page}-${at.toISOString().slice(0, 10)}`)
  let file = `${base}.md`
  for (let n = 2; fs.existsSync(file); n++) file = `${base}-${n}.md`
  return file
}
