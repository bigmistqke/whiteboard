// Where a question stands: the one definition the server and the page share.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { questionState, statusLines, takenByOther } from './status.ts'
import type { Listener, PageStatus, WbEvent } from './define.ts'

const event = (id: string, type: string, from?: 'cli'): WbEvent =>
  ({ id, ts: '', page: 'p', type, action: null, data: {}, ...(from ? { from } : {}) })
const wait = (type: string | null): Listener => ({ page: 'p', type, command: 'wait' })

const answer = event('a1', 'pick')
const newer = event('a2', 'pick')
const reply = event('r1', 'pick', 'cli')

// [what it is, events, listeners, picked up, expected]
const cases: [string, WbEvent[], Listener[], string[], string][] = [
  ['no answer, nobody listening', [], [], [], 'unheard'],
  ['no answer, a wait for it', [], [wait('pick')], [], 'waiting'],
  ['no answer, a wait for any answer', [], [wait(null)], [], 'waiting'],
  ['no answer, a wait for another question', [], [wait('other')], [], 'unheard'],
  ['answered, not picked up', [answer], [], [], 'pending'],
  ['answered, a wait for any answer about to pick it up', [answer], [wait(null)], [], 'pending'],
  ['answered and picked up', [answer], [], ['a1'], 'decided'],
  ['picked up, and a wait asks for it again: the agent wants a new answer', [answer], [wait('pick')], ['a1'], 'waiting'],
  ['picked up, a wait for any answer', [answer], [wait(null)], ['a1'], 'decided'],
  ['a newer answer, not picked up yet', [answer, newer], [], ['a1'], 'pending'],
  ['an agent\'s event of its name is no answer', [reply], [], [], 'unheard'],
  ['an agent\'s event after the answer does not hide it', [answer, reply], [], ['a1'], 'decided'],
  ['no answer, only the fallback: it waits for no question', [], [{ page: '', type: null, command: 'watch', fallback: true }], [], 'unheard'],
]

for (const [what, events, listeners, picked, expected] of cases) {
  test(`questionState: ${what}`, () => {
    assert.equal(questionState('pick', events, listeners, id => picked.includes(id)).state, expected)
  })
}

test('questionState gives the latest answer', () => {
  assert.equal(questionState('pick', [answer, newer, reply], [], () => false).last?.id, 'a2')
})

const page = (over: Partial<PageStatus>): PageStatus =>
  ({ page: 'p', title: 'p', file: '/x/p.md', owner: null, asks: [], questions: [], open: [], unheard: [], unpicked: [], listeners: [], ...over })

test('statusLines: what is open, the command once, then what an agent waits on', () => {
  const p = page({ open: ['a', 'b'], unheard: ['a'], unpicked: [answer, newer] })
  assert.deepEqual(statusLines(p, 'p.md'), [
    '2 answers no agent picked up (pick)',
    'nobody listens for a',
    '→ whiteboard wait --page p.md',
    'waiting for the reader: b',
  ])
  assert.deepEqual(statusLines(p, 'p.md', { waiting: false }).at(-1), '→ whiteboard wait --page p.md')
})

test('statusLines: nothing open says nothing', () => {
  assert.deepEqual(statusLines(page({}), 'p.md'), [])
})

test('takenByOther: what another listener would take, by page and type; never what only the fallback would', () => {
  const at = (page: string, type: string): WbEvent => ({ id: 'x', ts: '', page, type, action: null, data: {} })
  const fallback: Listener = { page: '', type: null, command: 'watch', fallback: true }
  assert.equal(takenByOther([fallback], at('p', 'pick')), false)
  assert.equal(takenByOther([fallback, wait(null)], at('p', 'pick')), true, 'any type on its page')
  assert.equal(takenByOther([fallback, wait(null)], at('p/sub', 'pick')), true, 'a page below it')
  assert.equal(takenByOther([fallback, wait(null)], at('q', 'pick')), false, 'another page')
  assert.equal(takenByOther([fallback, wait('other')], at('p', 'pick')), false, 'another type')
})
