import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry, listenerOf } from './listeners.ts'

const wait = (page: string, type: string | null = null) => ({ page, type, command: 'wait' as const })
const fallback = { page: '', type: null, command: 'watch' as const, fallback: true }

test('registry: holds listeners until removed, and lists those covering a page', () => {
  const r = createRegistry()
  const off = r.add(wait('plan'))!
  r.add(wait('notes/a', 'pick'))
  assert.deepEqual(r.list('plan'), [wait('plan')])
  assert.deepEqual(r.list('notes/a/b'), [wait('notes/a', 'pick')])
  assert.equal(r.list().length, 2)
  off()
  assert.deepEqual(r.list('plan'), [])
})

test('registry: one fallback at a time; another once it is gone', () => {
  const r = createRegistry()
  const off = r.add({ ...fallback })!
  assert.equal(r.add({ ...fallback }), null, 'a second fallback is refused')
  assert.ok(r.add(wait('plan')), 'other listeners are not')
  off()
  assert.ok(r.add({ ...fallback }), 'the first is gone: a new one is held')
})

test('registry: tells whoever follows it of each change, until they stop', () => {
  const r = createRegistry()
  let changes = 0
  const stop = r.onChange(() => changes++)
  const off = r.add(wait('plan'))!
  off()
  off()
  assert.equal(changes, 2, 'an add and a remove; removing twice is one change')
  stop()
  r.add(wait('plan'))
  assert.equal(changes, 2)
})

test('the listener a /api/listen request asks for', () => {
  assert.deepEqual(listenerOf(new URLSearchParams('page=plan&type=pick&command=wait')), wait('plan', 'pick'))
  assert.deepEqual(listenerOf(new URLSearchParams('fallback&command=watch')), fallback)
})
