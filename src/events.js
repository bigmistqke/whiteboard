// Form submits, one JSON object per line, in the project's `.whiteboard/events.ndjson`.
import fs from 'node:fs'
import crypto from 'node:crypto'

/** One submitted form. The only kind of event there is. */
export function appendEvent(file, input) {
  const event = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    page: String(input.page ?? ''),
    form: String(input.form ?? ''),
    action: input.action ?? null,
    data: input.data ?? {},
  }
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
  return event
}

export function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a partial or corrupt line */ }
  }
  return out
}

export function readEvents(file) {
  try { return parseLines(fs.readFileSync(file, 'utf8')) } catch { return [] }
}

/** `page` matches the page itself and every page below it. */
export function matches(event, { page, form } = {}) {
  if (page && event.page !== page && !event.page.startsWith(page + '/')) return false
  if (form && event.form !== form) return false
  return true
}
