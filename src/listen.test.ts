// The fallback's loop over the projects a server names, on logs in a temporary folder: what the
// server would send is given by hand.
import { after, test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendEvent, handOut } from './events.ts'
import { fallback } from './listen.ts'
import type { Listener, WbEvent } from './define.ts'

const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { timeout: 3000 }, fn)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const folders: string[] = []
after(() => {
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true })
})
/** A project folder with an empty log. */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-listen-'))
  folders.push(dir)
  return dir
}
const log = (dir: string) => path.join(dir, 'events.ndjson')
const answer = (dir: string, page: string) => appendEvent(log(dir), { page, type: 'pick', data: {} })

const self: Listener = { page: '', type: null, command: 'watch', fallback: true }
const waitOn = (page: string): Listener => ({ page, type: null, command: 'wait' })

/** A fallback handing out from each project's log; what it got, by project. */
function run() {
  const got: { dir: string; page: string }[] = []
  const update = fallback((p, options) => {
    void handOut(log(p.dir), {}, (e: WbEvent) => got.push({ dir: p.dir, page: e.page }), { ...options, interval: 5 })
  })
  return { got, update }
}

test('the fallback takes what nobody else listens for, and leaves what a wait covers', async () => {
  const a = project()
  answer(a, 'plan')
  answer(a, 'notes')
  const { got, update } = run()
  update({ projects: [{ dir: a, base: '', listeners: [self, waitOn('plan')] }] })
  await sleep(50)
  assert.deepEqual(
    got.map(g => g.page),
    ['notes'],
    'plan is the wait’s',
  )
})

test('once the wait is gone, what it left is the fallback’s', async () => {
  const a = project()
  const { got, update } = run()
  update({ projects: [{ dir: a, base: '', listeners: [self, waitOn('plan')] }] })
  answer(a, 'plan')
  await sleep(50)
  assert.equal(got.length, 0)
  update({ projects: [{ dir: a, base: '', listeners: [self] }] })
  await sleep(50)
  assert.deepEqual(
    got.map(g => g.page),
    ['plan'],
  )
})

test('each project is followed with its own listeners; one no longer named is stopped', async () => {
  const a = project()
  const b = project()
  const { got, update } = run()
  update({
    projects: [
      { dir: a, base: '/a', listeners: [self, waitOn('plan')] },
      { dir: b, base: '/b', listeners: [self] },
    ],
  })
  answer(a, 'plan')
  answer(b, 'plan')
  await sleep(50)
  assert.deepEqual(got, [{ dir: b, page: 'plan' }], "a's plan is its wait's, b's nobody's")
  update({ projects: [{ dir: a, base: '/a', listeners: [self, waitOn('plan')] }] })
  answer(b, 'later')
  await sleep(50)
  assert.equal(got.length, 1, 'b is no longer followed')
})
