import fs from 'node:fs'
import crypto from 'node:crypto'
import { EVENTS_FILE } from './config.js'

/** One submitted form. The only kind of event there is. */
export function appendEvent(input) {
  const event = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    page: String(input.page ?? ''),
    form: String(input.form ?? ''),
    action: input.action ?? null,
    data: input.data ?? {},
  }
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n')
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

export function readEvents() {
  try { return parseLines(fs.readFileSync(EVENTS_FILE, 'utf8')) } catch { return [] }
}

/** `page` matches the page itself and every page below it. */
export function matches(event, { page, form } = {}) {
  if (page && event.page !== page && !event.page.startsWith(page + '/')) return false
  if (form && event.form !== form) return false
  return true
}
