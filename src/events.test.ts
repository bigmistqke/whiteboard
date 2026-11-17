// The event log and handing out, on a log in a temporary folder.
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendEvent, follow, fromReader, handOut, pick, pickedUp, read, readEvents } from './events.ts'
import type { WbEvent } from './define.ts'

const FAST = { interval: 5 }

// a lost event leaves a hand-out waiting for ever: fail instead
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { timeout: 2000 }, fn)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A fresh log file in a folder of its own. */
function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-events-'))
  return path.join(dir, 'events.ndjson')
}

/** What the reader sends (a form submit) and what an agent writes (through the command line). */
const reader = (log: string, page: string, type = 'pick') => appendEvent(log, { page, type, data: {} })
const agent = (log: string, page: string, type = 'thread') => appendEvent(log, { page, type, data: {} }, 'cli')

/** Hand out without following, collecting what is handed. */
async function backlog(log: string, filter = {}, options = {}) {
  const got: WbEvent[] = []
  await handOut(log, filter, e => got.push(e), { follow: false, ...options })
  return got
}

// ---- primitives ----------------------------------------------------------------------------------

test('read: a missing log is empty', () => {
  assert.deepEqual(read(tempLog()), { events: [], end: 0 })
})

test('read ends after the last whole line, leaving out one still being written', () => {
  const log = tempLog()
  const a = reader(log, 'p')
  fs.appendFileSync(log, '{"id":"half')
  const { events, end } = read(log)
  assert.deepEqual(events.map(e => e.id), [a.id])
  assert.equal(end, fs.readFileSync(log, 'utf8').indexOf('\n') + 1)
})

test('follow gets new events in order, and a line written in two parts once, whole', async () => {
  const log = tempLog()
  reader(log, 'p')
  const got: string[] = []
  const stop = follow(log, read(log).end, e => got.push(e.id), FAST)
  const b = reader(log, 'p')
  fs.appendFileSync(log, '{"id":"c","ts":"","page":"p","type":"x","action":null,')
  await sleep(30)
  fs.appendFileSync(log, '"data":{}}\n')
  await sleep(30)
  stop()
  reader(log, 'p')
  await sleep(30)
  assert.deepEqual(got, [b.id, 'c'])
})

test('fromReader: what the command line wrote is not the reader\'s', () => {
  const log = tempLog()
  assert.equal(fromReader(reader(log, 'p')), true)
  assert.equal(fromReader(agent(log, 'p')), false)
})

test('pickedUp counts only the command line\'s picks', () => {
  const log = tempLog()
  const e = reader(log, 'p')
  // a browser could append an event of this type; it must not count
  appendEvent(log, { page: 'p', type: 'whiteboard:picked', data: { event: e.id } })
  assert.equal(pickedUp(readEvents(log)).has(e.id), false)
  pick(log, e)
  assert.equal(pickedUp(readEvents(log)).has(e.id), true)
})

// ---- handing out ---------------------------------------------------------------------------------

test('hands out the backlog once, and marks it picked up', async () => {
  const log = tempLog()
  const a = reader(log, 'p')
  const b = reader(log, 'p')
  assert.deepEqual((await backlog(log)).map(e => e.id), [a.id, b.id])
  assert.deepEqual(await backlog(log), [])
  assert.ok(pickedUp(readEvents(log)).has(a.id))
})

test('never hands out what an agent wrote', async () => {
  const log = tempLog()
  agent(log, 'p')
  const a = reader(log, 'p')
  assert.deepEqual((await backlog(log)).map(e => e.id), [a.id])
})

test('what one filter picked up, another does not hand out again', async () => {
  const log = tempLog()
  const a = reader(log, 'p', 'pick')
  const b = reader(log, 'p', 'other')
  assert.deepEqual((await backlog(log, { type: 'pick' })).map(e => e.id), [a.id])
  assert.deepEqual((await backlog(log, { page: 'p' })).map(e => e.id), [b.id])
})

test('a page covers the pages below it, unless exact', async () => {
  const log = tempLog()
  const top = reader(log, 'task')
  const below = reader(log, 'task/plan')
  reader(log, 'taskforce')
  assert.deepEqual((await backlog(log, { page: 'task', exact: true })).map(e => e.id), [top.id])
  assert.deepEqual((await backlog(log, { page: 'task' })).map(e => e.id), [below.id])
})

test('count stops it; the rest stays for the next', async () => {
  const log = tempLog()
  const a = reader(log, 'p')
  const b = reader(log, 'p')
  assert.equal(await handOut(log, {}, () => {}, { count: 1, ...FAST }), 1)
  assert.deepEqual((await backlog(log)).map(e => e.id), [b.id])
  assert.ok(pickedUp(readEvents(log)).has(a.id))
})

test('follows new events after the backlog, and resolves at count', async () => {
  const log = tempLog()
  const got: string[] = []
  const done = handOut(log, {}, e => got.push(e.id), { count: 2, ...FAST })
  const a = reader(log, 'p')
  agent(log, 'p')
  const b = reader(log, 'p')
  assert.equal(await done, 2)
  assert.deepEqual(got, [a.id, b.id])
})

test('two running hand-outs both get a new event', async () => {
  const log = tempLog()
  const one: string[] = [], two: string[] = []
  const done = Promise.all([
    handOut(log, {}, e => one.push(e.id), { count: 1, ...FAST }),
    handOut(log, {}, e => two.push(e.id), { count: 1, ...FAST }),
  ])
  const a = reader(log, 'p')
  await done
  assert.deepEqual([one, two], [[a.id], [a.id]])
})

test('an event half written when it starts is handed out whole, once', async () => {
  const log = tempLog()
  fs.appendFileSync(log, '{"id":"late","ts":"","page":"p","type":"pick",')
  const got: string[] = []
  const done = handOut(log, {}, e => got.push(e.id), { count: 1, ...FAST })
  await sleep(20)
  fs.appendFileSync(log, '"action":null,"data":{}}\n')
  await done
  assert.deepEqual(got, ['late'])
})

test('a signal stops following', async () => {
  const log = tempLog()
  const controller = new AbortController()
  const done = handOut(log, {}, () => {}, { signal: controller.signal, ...FAST })
  await sleep(20)
  controller.abort()
  assert.equal(await done, 0)
  // nothing is handed out once stopped
  reader(log, 'p')
  await sleep(30)
  assert.equal(pickedUp(readEvents(log)).size, 0)
})
