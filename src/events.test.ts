// The event log and handing out, on a log in a temporary folder.
import { after, test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendEvent,
  follow,
  forAgent,
  fromReader,
  editEvent,
  handOut,
  pick,
  pickedUp,
  prune,
  hasData,
  read,
  readEvents,
} from './events.ts'
import type { WbEvent } from './define.ts'

const FAST = { interval: 5 }

// a lost event leaves a hand-out waiting for ever: fail instead
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { timeout: 2000 }, fn)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A fresh log file in a folder of its own, removed once the tests are done. */
const folders: string[] = []
after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true })
})
function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-events-'))
  folders.push(dir)
  return path.join(dir, 'events.ndjson')
}

/** What the reader sends (a form submit) and what an agent writes (through the command line). */
const reader = (log: string, page: string, type = 'pick') => appendEvent(log, { page, type, data: {} })
const agent = (log: string, page: string, type = 'chat:message') => appendEvent(log, { page, type, data: {} }, 'cli')

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
  assert.deepEqual(
    events.map(e => e.id),
    [a.id],
  )
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

test("fromReader: what the command line wrote is not the reader's", () => {
  const log = tempLog()
  assert.equal(fromReader(reader(log, 'p')), true)
  assert.equal(fromReader(agent(log, 'p')), false)
})

test("pickedUp counts only the command line's picks", () => {
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
  assert.deepEqual(
    (await backlog(log)).map(e => e.id),
    [a.id, b.id],
  )
  assert.deepEqual(await backlog(log), [])
  assert.ok(pickedUp(readEvents(log)).has(a.id))
})

test('never hands out what an agent wrote', async () => {
  const log = tempLog()
  agent(log, 'p')
  const a = reader(log, 'p')
  assert.deepEqual(
    (await backlog(log)).map(e => e.id),
    [a.id],
  )
})

test('what one filter picked up, another does not hand out again', async () => {
  const log = tempLog()
  const a = reader(log, 'p', 'pick')
  const b = reader(log, 'p', 'other')
  assert.deepEqual(
    (await backlog(log, { type: 'pick' })).map(e => e.id),
    [a.id],
  )
  assert.deepEqual(
    (await backlog(log, { page: 'p' })).map(e => e.id),
    [b.id],
  )
})

test('a page covers the pages below it, unless exact', async () => {
  const log = tempLog()
  const top = reader(log, 'task')
  const below = reader(log, 'task/plan')
  reader(log, 'taskforce')
  assert.deepEqual(
    (await backlog(log, { page: 'task', exact: true })).map(e => e.id),
    [top.id],
  )
  assert.deepEqual(
    (await backlog(log, { page: 'task' })).map(e => e.id),
    [below.id],
  )
})

test('count stops it; the rest stays for the next', async () => {
  const log = tempLog()
  const a = reader(log, 'p')
  const b = reader(log, 'p')
  assert.equal(await handOut(log, {}, () => {}, { count: 1, ...FAST }), 1)
  assert.deepEqual(
    (await backlog(log)).map(e => e.id),
    [b.id],
  )
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
  const one: string[] = [],
    two: string[] = []
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

test("a plugin's events reach an agent only when declared handOut, or asked for by type", async () => {
  const log = tempLog()
  const answer = reader(log, 'p', 'pick')
  const vote = reader(log, 'p', 'votes:up')
  const message = reader(log, 'p', 'chat:message')
  const isForAgent = forAgent(new Set(['chat:message']))
  assert.deepEqual(
    (await backlog(log, {}, { forAgent: isForAgent })).map(e => e.id),
    [answer.id, message.id],
  )
  // the vote stays in the log, for whoever asks for it by name
  assert.deepEqual(
    (await backlog(log, { type: 'votes:up' }, { forAgent: isForAgent })).map(e => e.id),
    [vote.id],
  )
  // without declarations: a form's answers only
  assert.equal(forAgent()('pick'), true)
  assert.equal(forAgent()('chat:message'), false)
})

test('skip leaves an event for now; a recheck hands it out once it is no longer left, unless picked up meanwhile', async () => {
  const log = tempLog()
  const taken = reader(log, 'taken')
  const free = reader(log, 'free')
  const gone = reader(log, 'gone')
  let covered = new Set(['taken', 'gone'])
  let again = () => {}
  const got: string[] = []
  const ac = new AbortController()
  const done = handOut(log, {}, e => got.push(e.page), {
    ...FAST,
    signal: ac.signal,
    skip: e => covered.has(e.page),
    recheck: fn => {
      again = fn
    },
  })
  await sleep(20)
  assert.deepEqual(got, ['free'], 'only what nobody else would take')
  // another agent picked one of the left ones up; then nobody covers either
  pick(log, gone)
  covered = new Set()
  again()
  assert.deepEqual(got, ['free', 'taken'], 'the left one, once it is free; not the one picked meanwhile')
  void taken
  void free
  ac.abort()
  await done
})

test("prune removes a page's events, and a follow goes on after it without passing anything on twice", async () => {
  const log = tempLog()
  reader(log, 'keep')
  reader(log, 'gone')
  agent(log, 'gone')
  reader(log, 'keep/below')
  const got: string[] = []
  const stop = follow(log, read(log).end, e => got.push(`${e.page}:${e.type}`), FAST)
  reader(log, 'keep', 'before')
  await sleep(30)
  assert.equal(prune(log, 'gone'), 2)
  assert.deepEqual(
    readEvents(log).map(e => e.page),
    ['keep', 'keep/below', 'keep'],
    'only exactly that page, not one that starts like it',
  )
  reader(log, 'keep', 'after')
  await sleep(40)
  stop()
  assert.deepEqual(got, ['keep:before', 'keep:after'], 'each new one once, before and after the rewrite')
  assert.equal(prune(log, 'gone'), 0, 'nothing left of it')
})

test("editEvent: an agent's event changes in place, its id and time kept; the reader's stays as sent", () => {
  const log = tempLog()
  const mine = appendEvent(log, { page: 'p', type: 'chat:message', data: { chat: 'c', text: 'draft' } }, 'cli')
  const theirs = reader(log, 'p')
  const edited = editEvent(log, mine.id, { text: 'formatted' })
  assert.deepEqual(edited, { ...mine, data: { chat: 'c', text: 'formatted' } })
  assert.deepEqual(
    readEvents(log).map(e => e.id),
    [mine.id, theirs.id],
    'the same events, in the same order',
  )
  assert.throws(() => editEvent(log, theirs.id, { text: 'x' }), /the reader's/)
  assert.throws(() => editEvent(log, 'nope', {}), /no event nope/)
})

test('hasData: an event whose data holds every value given; one chat of several', () => {
  const log = tempLog()
  const msg = appendEvent(log, { page: 'p', type: 'chat:message', data: { chat: 'plan', text: 'hi' } }, 'cli')
  assert.ok(hasData(msg, { chat: 'plan' }))
  assert.ok(hasData(msg, {}))
  assert.ok(!hasData(msg, { chat: 'other' }))
  assert.ok(!hasData(msg, { chat: 'plan', text: 'bye' }))
  assert.ok(!hasData({ ...msg, data: {} }, { chat: 'plan' }))
})

test("prune with a filter: one type of a page's events, or one event; the rest stays", () => {
  const log = tempLog()
  reader(log, 'p', 'pick')
  agent(log, 'p', 'chat:message')
  agent(log, 'p', 'chat:message')
  const one = reader(log, 'p', 'other')
  assert.equal(
    prune(log, 'p', e => e.type === 'chat:message'),
    2,
  )
  assert.deepEqual(
    readEvents(log).map(e => e.type),
    ['pick', 'other'],
  )
  assert.equal(
    prune(log, 'p', e => e.id === one.id),
    1,
  )
  assert.deepEqual(
    readEvents(log).map(e => e.type),
    ['pick'],
  )
})
