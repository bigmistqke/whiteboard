// Form submits, one JSON object per line. Each project keeps its own log in
// `<project>/.visualize/events.ndjson`, so reading answers needs no access outside the repository;
// pages outside any project log to `<root>/events.ndjson`.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT, projectByName } from './config.js'

/** The log of a project (`{ dir }`), or of the shared folder when `project` is null. */
export function eventsFile(project) {
  return path.join(project ? path.join(project.dir, '.visualize') : ROOT, 'events.ndjson')
}

/** The log a page's submits go to: its project's, else the shared folder's. */
export function eventsFileFor(pageId) {
  return eventsFile(projectByName(String(pageId ?? '').split('/')[0]))
}

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
  fs.appendFileSync(eventsFileFor(event.page), JSON.stringify(event) + '\n')
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
