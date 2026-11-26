// `whiteboard destroy` and `archive`: a page that did its job goes, with its events; nothing else
// does, and a watch running across it hands nothing out twice. Archived, it is kept as markdown with
// what was answered on it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { browser, project, until } from './project.ts'

const FORM = (name: string) => `:::form{name=${name}}\n:text[Why]{name=why}\n:::\n`

test(
  'destroy: the page and its events go, other pages keep theirs, the tab says so, a watch goes on',
  { timeout: 60000 },
  async t => {
    const proj = await project({
      pages: { temp: `# Temporary\n\n${FORM('quick')}`, stays: `# Stays\n\n${FORM('lasting')}` },
    })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    const watch = proj.spawn('watch')
    for (const [p, q] of [
      ['stays', 'lasting'],
      ['temp', 'quick'],
    ] as const) {
      await page.goto(proj.url(p))
      await page.fill(`form[name=${q}] input[name=why]`, `an answer on ${p}`)
      await page.click(`form[name=${q}] button`)
      await page.waitForSelector(`form[name=${q}][data-wb-state=sent]`)
    }
    proj.cli(
      'append',
      '--page',
      'temp',
      '--type',
      'chat:message',
      '--data',
      JSON.stringify({ chat: 'quick', text: 'noted' }),
    )
    await until('the watch had both answers', () => (watch.output().match(/\n/g) ?? []).length === 2 || null)
    // the open tab reads the agent's message: that, too, is an event of the page, before it closes
    await until(
      'the message was read',
      () => proj.events().some(e => e.page === 'temp' && e.type === 'whiteboard:read') || null,
    )
    assert.ok(proj.events().some(e => e.page === 'temp'))

    const out = proj.cli('destroy', 'temp')
    assert.match(out, /destroyed temp: removed its file, and \d+ events from the log/)
    assert.ok(!fs.existsSync(`${proj.dir}/.whiteboard/pages/temp.md`), 'the file is gone')
    assert.deepEqual(
      proj.events().filter(e => e.page === 'temp'),
      [],
      'its events are gone',
    )
    assert.ok(
      proj.events().some(e => e.page === 'stays' && e.type === 'lasting'),
      'the other page keeps its answer',
    )
    await page.waitForSelector('h1:text("Not found")')

    // the watch goes on after the rewrite: a new answer comes once, nothing old comes again
    await page.goto(proj.url('stays'))
    await page.click('form[name=lasting][data-wb-folded]', { position: { x: 20, y: 12 } }).catch(() => {})
    await page.fill('form[name=lasting] input[name=why]', 'a second answer')
    await page.click('form[name=lasting] button')
    await until('the watch had the new one', () => watch.output().includes('a second answer') || null)
    await new Promise(r => setTimeout(r, 400))
    const lines = watch
      .output()
      .trim()
      .split('\n')
      .map(l => JSON.parse(l).data.why)
    assert.deepEqual(lines, ['an answer on stays', 'an answer on temp', 'a second answer'])
    assert.match(
      (() => {
        try {
          proj.cli('destroy', 'temp')
          return ''
        } catch (err) {
          return String((err as { stderr?: string }).stderr)
        }
      })(),
      /there is no page temp/,
    )
    watch.kill()
    assert.deepEqual(
      errors.filter(e => !/404/.test(e)),
      [],
    )
  },
)

test('archive: the page leaves, kept as markdown with its answers, chats and comments', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { done: `# Done\n\n${FORM('quick')}` } })
  t.after(() => proj.close())
  const log = (e: object) =>
    fs.appendFileSync(
      `${proj.dir}/.whiteboard/events.ndjson`,
      JSON.stringify({ ts: '2026-11-26T10:14:00.000Z', page: 'done', action: null, ...e }) + '\n',
    )
  log({ id: 'a1', type: 'quick', action: 'Send', data: { why: 'because it ships' } })
  log({ id: 'c1', type: 'chat:message', data: { chat: 'quick', text: 'Why now?' } })
  log({ id: 'c2', type: 'chat:message', from: 'cli', data: { chat: 'quick', text: 'First draft' } })
  log({
    id: 'c3',
    type: 'chat:message',
    from: 'cli',
    data: { chat: 'quick', text: 'Because of\nthe release.', replaces: 'c2' },
  })
  log({ id: 'k1', type: 'comments:new', data: { quote: 'Done', text: 'Is it?' } })
  log({ id: 'k2', type: 'comments:reply', from: 'cli', data: { replyTo: 'k1', text: 'Yes.' } })
  log({ id: 'k3', type: 'comments:resolve', data: { replyTo: 'k1' } })

  const out = proj.cli('archive', 'done')
  const kept = /kept with its answers in (\S+),/.exec(out)?.[1]
  assert.ok(kept, out)
  assert.match(kept, /\.whiteboard\/archive\/done-\d{4}-\d\d-\d\d\.md$/)
  assert.ok(!fs.existsSync(`${proj.dir}/.whiteboard/pages/done.md`), 'it left the pages')
  assert.deepEqual(
    proj.events().filter(e => e.page === 'done'),
    [],
    'and its events the log',
  )
  const md = fs.readFileSync(`${proj.dir}/${kept}`, 'utf8')
  assert.ok(md.startsWith(`# Done\n\n${FORM('quick')}`), 'the page as it was')
  for (const part of [
    '## Answers\n\n### quick\n\n- 2026-11-26 10:14: why: because it ships',
    '## Chats\n\n### quick\n\n- you, 2026-11-26 10:14\n\n  Why now?\n- agent, 2026-11-26 10:14\n\n  Because of\n  the release.',
    '## Comments\n\n### On “Done” (closed)\n\n- you, 2026-11-26 10:14\n\n  Is it?\n- agent, 2026-11-26 10:14\n\n  Yes.',
  ])
    assert.ok(md.includes(part), `${part}\n\nnot in:\n\n${md}`)
  assert.ok(!md.includes('First draft'), 'a corrected message in its correction')
  // another the same day goes beside it
  proj.page('done', '# Done again\n')
  const again = /kept with its answers in (\S+),/.exec(proj.cli('archive', 'done'))?.[1]
  assert.match(again ?? '', /done-\d{4}-\d\d-\d\d-2\.md$/)
})
