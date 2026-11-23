// Where a question stands: the one definition the server and the page share.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { awaiting, heard, projectStatus, questionState, statusLines, takenByOther, unreadMessages } from './status.ts'
import type { Listener, PageStatus, WbEvent } from './define.ts'

const event = (id: string, type: string, from?: 'cli'): WbEvent => ({
  id,
  ts: '',
  page: 'p',
  type,
  action: null,
  data: {},
  ...(from ? { from } : {}),
})
const wait = (type: string | null): Listener => ({ page: 'p', type, command: 'wait' })

const answer = event('a1', 'pick')
const newer = event('a2', 'pick')
const reply = event('r1', 'pick', 'cli')

// [what it is, events, listeners, picked up, expected]
const cases: [string, WbEvent[], Listener[], string[], string][] = [
  ['no answer, nobody listening: it waits for the reader', [], [], [], 'open'],
  ['no answer, a wait for it', [], [wait('pick')], [], 'open'],
  ['no answer, only the fallback', [], [{ page: '', type: null, command: 'watch', fallback: true }], [], 'open'],
  ['answered, not picked up', [answer], [], [], 'pending'],
  ['answered, a wait for any answer about to pick it up', [answer], [wait(null)], [], 'pending'],
  ['answered and picked up', [answer], [], ['a1'], 'decided'],
  ['picked up, and a wait asks for it again: the agent wants a new answer', [answer], [wait('pick')], ['a1'], 'open'],
  ['picked up, a wait for any answer: not asked again', [answer], [wait(null)], ['a1'], 'decided'],
  [
    'picked up, the fallback asks for it by name: it asks nobody again',
    [answer],
    [{ page: '', type: 'pick', command: 'watch', fallback: true }],
    ['a1'],
    'decided',
  ],
  ['a newer answer, not picked up yet', [answer, newer], [], ['a1'], 'pending'],
  ["an agent's event of its name is no answer", [reply], [], [], 'open'],
  ["an agent's event after the answer does not hide it", [answer, reply], [], ['a1'], 'decided'],
]

for (const [what, events, listeners, picked, expected] of cases) {
  test(`questionState: ${what}`, () => {
    assert.equal(questionState('pick', events, listeners, id => picked.includes(id)).state, expected)
  })
}

test('questionState gives the latest answer', () => {
  assert.equal(questionState('pick', [answer, newer, reply], [], () => false).last?.id, 'a2')
})

const page = (over: Partial<PageStatus>): PageStatus => ({
  page: 'p',
  title: 'p',
  file: '/x/p.md',
  owner: null,
  asks: [],
  questions: [],
  open: [],
  unheard: [],
  unread: [],
  unpicked: [],
  listeners: [],
  ...over,
})

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

test("unreadMessages: the agent's messages of a reader type, until a read names them or a later one replaces them", () => {
  const msg = (id: string, extra: Record<string, unknown> = {}, from: 'cli' | null = 'cli'): WbEvent => ({
    id,
    ts: '',
    page: 'p',
    type: 'chat:message',
    action: null,
    data: extra,
    ...(from ? { from } : {}),
  })
  const read = (ids: string[], from?: 'cli'): WbEvent => ({
    id: 'r' + ids.join(),
    ts: '',
    page: 'p',
    type: 'whiteboard:read',
    action: null,
    data: { ids },
    ...(from ? { from } : {}),
  })
  const isMessage = (t: string) => t === 'chat:message'
  const events = [
    msg('m1'),
    msg('m2'),
    msg('mine', {}, null),
    msg('m3', { replaces: 'm2' }),
    read(['m1']),
    read(['m3'], 'cli'),
  ]
  assert.deepEqual(
    unreadMessages(events, isMessage).map(e => e.id),
    ['m3'],
    "m1 read, m2 replaced, the reader's own none; a read from the agent counts for nothing",
  )
  assert.deepEqual(
    unreadMessages([msg('m1')], () => false),
    [],
    'not a type for the reader',
  )
  assert.equal(awaiting({ open: ['a'], unread: [msg('m1')] }), 2)
})

test('heard: a wait or watch takes the answer; the fallback does not count', () => {
  assert.equal(heard('pick', [wait(null)]), true)
  assert.equal(heard('pick', [wait('other')]), false)
  assert.equal(heard('pick', [{ page: '', type: null, command: 'watch', fallback: true }]), false)
})

test('projectStatus: per page from the log and who listens; picked marks and when each was last answered', () => {
  const at = (id: string, page: string, type: string, ts: string, extra: Partial<WbEvent> = {}): WbEvent => ({
    id,
    ts,
    page,
    type,
    action: null,
    data: {},
    ...extra,
  })
  const events = [
    at('c1', 'plan', 'whiteboard:claim', '1', { from: 'cli', data: { session: 's1' } }),
    at('a1', 'plan', 'pick', '2'),
    at('p1', 'plan', 'whiteboard:picked', '3', { from: 'cli', data: { event: 'a1' } }),
    at('a2', 'notes', 'pick', '4'),
    at('m1', 'notes', 'chat:message', '5', { from: 'cli' }),
    at('x1', 'notes', 'comments:new', '6'),
  ]
  const s = projectStatus({
    pages: [
      { id: 'plan', file: '/p/plan.md', title: 'Plan', asks: ['pick', 'other'] },
      { id: 'notes', file: '/p/notes.md', title: 'Notes', asks: ['pick'] },
    ],
    events,
    listeners: page => (page === 'plan' ? [{ page: 'plan', type: null, command: 'wait' }] : []),
    forAgent: type => !type.includes(':'),
    forReader: type => type === 'chat:message',
  })
  const [plan, notes] = s.pages
  assert.deepEqual(
    [plan!.owner, plan!.questions, plan!.open, plan!.unheard, plan!.unpicked.length],
    [
      's1',
      [
        { name: 'pick', state: 'decided' },
        { name: 'other', state: 'open' },
      ],
      ['other'],
      [],
      0,
    ],
  )
  assert.deepEqual(
    [notes!.owner, notes!.open, notes!.unpicked.map(e => e.id), notes!.unread.map(e => e.id), awaiting(notes!)],
    [null, [], ['a2'], ['m1'], 1],
    "notes: answered, not picked up (comments:new isn't for an agent), one unread message",
  )
  assert.deepEqual([...s.picked], ['a1'])
  assert.equal(s.lastAnswered('notes'), '6', 'the reader’s last event, of any type')
  assert.equal(s.lastAnswered('plan'), '2', 'the agent’s pick and claim do not count')
  assert.equal(s.lastAnswered('gone'), null)
})
