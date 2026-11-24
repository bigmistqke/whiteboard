// `whiteboard wait`: everything the agent hasn't handled at once; an answer printed before and not
// handled comes again, marked; `handled` (or a reply) handles it; one wait a page, unless --force, which
// stops the first (exit 3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { project, until } from './project.ts'

test('wait: a batch, again until handled, one wait a page', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { p: '# P\n\n:::form{name=q}\n:button[Go]\n:::\n' } })
  t.after(() => proj.close())
  const log = path.join(proj.dir, '.whiteboard', 'events.ndjson')
  const answer = (id: string, data: Record<string, unknown> = {}, type = 'q') =>
    fs.appendFileSync(log, JSON.stringify({ id, ts: new Date().toISOString(), page: 'p', type, action: 'Go', data }) + '\n')
  answer('a1')
  answer('a2')
  answer('c1', { chat: 'talk', text: 'a question' }, 'chat:message')

  const lines = (out: string) => out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const first = proj.run(['wait', '--page', 'p'])
  assert.equal(first.status, 0)
  assert.deepEqual(
    lines(first.stdout).map(e => [e.id, !!e.again]),
    [
      ['a1', false],
      ['a2', false],
      ['c1', false],
    ],
    'all at once',
  )
  assert.match(first.stderr, /handle these on p .*whiteboard handled a1 a2 c1/)
  assert.match(first.stderr, /waiting for your reply on p: the chat talk/)

  // not handled: they come again, marked; a reply in the chat handles its question, `handled` the others
  assert.deepEqual(
    lines(proj.cli('wait', '--page', 'p')).map(e => [e.id, e.again]),
    [
      ['a1', true],
      ['a2', true],
      ['c1', true],
    ],
  )
  proj.cli('append', '--page', 'p', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'talk', text: 'yes' }))
  proj.cli('handled', 'a1')
  const third = proj.run(['wait', '--page', 'p'])
  assert.deepEqual(lines(third.stdout).map(e => e.id), ['a2'])
  assert.doesNotMatch(third.stderr, /waiting for your reply/)
  proj.cli('handled', 'a2')

  // one wait a page: a second is refused; with --force it takes over, and the first exits 3
  const one = proj.spawn('wait', '--page', 'p')
  let oneErr = ''
  one.stderr!.on('data', d => (oneErr += d))
  await until(
    'the first wait listens',
    async () => (await (await fetch(proj.url('api/listeners?page=p'))).json()).length === 1 || null,
  )
  const refused = proj.run(['wait', '--page', 'p', '--timeout', '1'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /another wait has waited on p since .*--force takes it over/)
  const two = proj.spawn('wait', '--page', 'p', '--force')
  await until('the first is stopped', () => (one.exitCode != null ? true : null))
  assert.equal(one.exitCode, 3)
  assert.match(oneErr, /stopped waiting on p: a newer wait took it over/)
  answer('a3')
  await until('the second gets the next', () => (two.exitCode != null ? true : null))
  assert.deepEqual(lines(two.output()).map(e => e.id), ['a3'])
})
