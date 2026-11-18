// Whose size a session has, with several drawers showing it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handOver, lastUsed, leave, report, type Sizes } from './sizes.ts'

const session = (): Sizes => ({ cols: 100, rows: 30, viewers: new Map(), active: null })

/** Report as the host does: the session takes the size report returns. */
function sized(s: Sizes, viewer: string, cols: number, rows: number, used = false, now = 0) {
  const size = report(s, viewer, cols, rows, used, now)
  s.cols = size.cols
  s.rows = size.rows
  return `${s.cols}x${s.rows}`
}

test('the first drawer to report a size gets it', () => {
  const s = session()
  assert.equal(sized(s, 'a', 80, 24), '80x24')
  assert.equal(s.active, 'a')
})

test('another drawer reporting its size changes nothing until it is used', () => {
  const s = session()
  sized(s, 'a', 80, 24)
  assert.equal(sized(s, 'b', 160, 40), '80x24')
  assert.equal(s.active, 'a')
})

test('the drawer the reader uses takes the session, and the other follows', () => {
  const s = session()
  sized(s, 'a', 80, 24)
  sized(s, 'b', 160, 40)
  assert.equal(sized(s, 'b', 160, 40, true, 1), '160x40')
  assert.equal(s.active, 'b')
  // a drawer that isn't the active one resizing (its window changed) leaves the session alone
  assert.equal(sized(s, 'a', 90, 24), '160x40')
  // the active one resizing changes it
  assert.equal(sized(s, 'b', 150, 40), '150x40')
})

test('when the active drawer goes, the one used most recently takes over', () => {
  const s = session()
  sized(s, 'a', 80, 24, true, 1)
  sized(s, 'b', 120, 30, true, 2)
  sized(s, 'c', 160, 40, true, 3)
  assert.equal(leave(s, 'c'), true)
  const next = handOver(s, 'c')
  assert.deepEqual(next, { cols: 120, rows: 30 })
  assert.equal(s.active, 'b')
})

test('a page switch: the same window claims it again before the handover', () => {
  const s = session()
  sized(s, 'a', 80, 24, true, 1)
  sized(s, 'b', 160, 40)
  // window a loads another page: its old viewer leaves, its new one claims the session
  assert.equal(leave(s, 'a'), true)
  sized(s, 'a2', 80, 24, true, 2)
  assert.equal(handOver(s, 'a'), null)
  assert.equal(s.active, 'a2')
})

test("a drawer that wasn't the active one leaving changes nothing", () => {
  const s = session()
  sized(s, 'a', 80, 24, true, 1)
  sized(s, 'b', 160, 40)
  assert.equal(leave(s, 'b'), false)
  assert.equal(s.active, 'a')
})

test('the last drawer leaving leaves the size as it is', () => {
  const s = session()
  sized(s, 'a', 80, 24)
  leave(s, 'a')
  assert.equal(handOver(s, 'a'), null)
  assert.equal(s.active, null)
  // the next drawer to report gets it
  assert.equal(sized(s, 'b', 120, 30), '120x30')
})

test('of several sessions, the one whose drawer the reader used last', () => {
  const one = session(),
    two = session()
  sized(one, 'a', 80, 24, true, 5)
  sized(two, 'b', 80, 24, true, 9)
  assert.equal(lastUsed([one, two]), two)
  sized(one, 'a', 80, 24, true, 12)
  assert.equal(lastUsed([one, two]), one)
  assert.equal(lastUsed([session()]), undefined)
})
