// The project's events, one JSON object per line, in `.whiteboard/events.ndjson`. An event has a
// `type`: a submitted form's type is the form's name; a template can append events of its own.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

/**
 * Append one event; `action` is the button that submitted a form, null for anything else. `from`
 * is set only for events the command line writes ('cli'), so that waits skip them and pages can
 * tell them apart; what the browser appends has none.
 */
export function appendEvent(file, input, from = null) {
  const event = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    page: String(input.page ?? ''),
    type: String(input.type ?? ''),
    action: input.action ?? null,
    data: input.data ?? {},
    ...(from ? { from } : {}),
  }
  fs.appendFileSync(file, JSON.stringify(event) + '\n')
  return event
}

export function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue /* a partial or corrupt line */ }
    // logs written before events had a type named it `form`
    if (event && event.type === undefined && 'form' in event) {
      const { id, ts, page, form, ...rest } = event
      event = { id, ts, page, type: form, ...rest }
    }
    out.push(event)
  }
  return out
}

export function readEvents(file) {
  try { return parseLines(fs.readFileSync(file, 'utf8')) } catch { return [] }
}

/** `page` matches the page itself and every page below it. */
export function matches(event, { page, type } = {}) {
  if (page && event.page !== page && !event.page.startsWith(page + '/')) return false
  if (type && event.type !== type) return false
  return true
}

// ---- what was handed out -----------------------------------------------------------------------
// Per filter (page and type), the last event `whiteboard wait` or `watch` handed out, so the next
// command with that filter starts after it. Each filter has a file of its own, written by renaming
// a finished temporary file over it: commands running at once never write the same file, and a
// read never sees half of one.

const filterFile = (dir, key) => path.join(dir, `${encodeURIComponent(key).replace(/\./g, '%2E')}.json`)

/** The last event handed out for `key`, or null. */
export function readDelivered(proj, key) {
  try { return JSON.parse(fs.readFileSync(filterFile(proj.deliveredDir, key), 'utf8')) } catch {}
  // kept in one file for all filters before
  try { return JSON.parse(fs.readFileSync(proj.deliveredFile, 'utf8'))[key] ?? null } catch {}
  return null
}

export function writeDelivered(proj, key, event) {
  fs.mkdirSync(proj.deliveredDir, { recursive: true })
  const file = filterFile(proj.deliveredDir, key)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ id: event.id, ts: event.ts }) + '\n')
  fs.renameSync(tmp, file)
}
