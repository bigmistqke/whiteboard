// Named forms in the browser, with markboard: where each stands, drafts, a submit handed to a wait,
// folding once decided, and live updates.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { browser, project, until } from './project.ts'

const PAGE = `# Test

Intro paragraph.

:::form{name=pick}
**Which?**

- :radio[Apples]{name=fruit}
- :radio[Pears]{name=fruit}

:text[Why]{name=why}
:::
`

test('named forms: waiting, drafts, a submit, decided, live updates', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })

  const state = () => page.evaluate(() => {
    const f = document.querySelector('form[name=pick]')!
    const button = document.querySelector<HTMLElement>('#wb-dock .wb-waiting-next')
    return {
      attrs: [...f.attributes].map(a => a.name).filter(n => n.startsWith('data-wb')),
      summary: document.querySelector('.wb-summary')?.textContent,
      summaryBeforeMain: document.querySelector('.wb-summary')?.nextElementSibling?.tagName,
      title: document.title,
      button: button && !button.hidden ? button.textContent : null,
    }
  })

  await page.goto(proj.url('q'))
  let s = await until('the form is marked', async () => { const x = await state(); return x.attrs.length ? x : null })
  assert.ok(s.attrs.includes('data-wb-unheard'), 'unheard without a listener')
  assert.equal(s.summary, '1 nobody listening')
  assert.equal(s.summaryBeforeMain, 'MAIN', 'the summary line sits right before <main>')

  const wait = proj.spawn('wait', '--page', 'q')
  s = await until('waiting while a wait runs', async () => { const x = await state(); return x.attrs.includes('data-wb-waiting') ? x : null })
  assert.ok(s.title.startsWith('(!1) '), 'title badge (!1)')
  assert.equal(s.button, '→ waiting for you (1)', 'corner button')

  // a draft survives a reload
  await page.fill('input[name=why]', 'because')
  await page.reload()
  await until('the draft is back', async () => (await page.inputValue('input[name=why]')) === 'because')

  await page.check('input[value=Pears]')
  await page.click('form[name=pick] button')
  const out = await until('the wait got the submit', () => wait.output())
  const got = JSON.parse(out)
  assert.equal(got.type, 'pick')
  assert.deepEqual(got.data, { fruit: 'Pears', why: 'because' })

  s = await until('decided and folded', async () => { const x = await state(); return x.attrs.includes('data-wb-folded') ? x : null })
  assert.ok(s.attrs.includes('data-wb-decided'))
  assert.ok(!s.title.startsWith('(!'), 'the badge is gone')

  // a live update: the marks stay, the new block is marked new
  const file = `${proj.dir}/.whiteboard/pages/q.md`
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Intro paragraph.', 'Intro paragraph.\n\nA new paragraph.'))
  await until('the new block is marked', () => page.evaluate(() => !!document.querySelector('.wb-new')))
  s = await state()
  assert.ok(s.attrs.includes('data-wb-folded'), 'still folded after a live update')
  assert.equal(s.summary, '1 decided')
  assert.equal(s.summaryBeforeMain, 'MAIN')

  // a click reopens a folded form
  await page.click('form[name=pick]')
  await until('reopened', async () => !(await state()).attrs.includes('data-wb-folded'))

  assert.deepEqual(errors, [], 'no console errors')
})

test('event names: a form name with a colon is refused, and a thread shows old and new messages', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: `# Q

:::form{name=pick}
:radio[A]{name=x}
:::

:::form{name=comments:new}
:radio[B]{name=y}
:::
` } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  // a message from before event types had their owner's name, and one from now
  proj.cli('append', '--page', 'q', '--type', 'thread', '--data', JSON.stringify({ form: 'pick', text: 'old name' }))
  proj.cli('append', '--page', 'q', '--type', 'form:thread', '--data', JSON.stringify({ form: 'pick', text: 'new name' }))

  await page.goto(proj.url('q'))
  await until('the thread shows both', () => page.evaluate(() => {
    const text = document.querySelector('form[name=pick] .wb-form-thread')?.textContent ?? ''
    return text.includes('old name') && text.includes('new name')
  }))
  assert.match(await page.textContent('.wb-error') ?? '', /form name "comments:new" has a colon/)
  // the page asks only the one question
  assert.match(proj.cli('status', '--page', 'q'), /nobody listens for pick\n/)
  assert.deepEqual(errors, [], 'no console errors')
})

test('a thread whose form is gone shows after the page, until the form is back', { timeout: 60000 }, async t => {
  const FORM = ':::form{name=pick}\n:radio[A]{name=x}\n:::\n'
  const proj = await project({ pages: { q: `# Q\n\n${FORM}` } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  proj.cli('append', '--page', 'q', '--type', 'form:thread', '--data', JSON.stringify({ form: 'pick', text: 'about pick' }))
  await page.goto(proj.url('q'))
  await until('the thread under its form', () => page.evaluate(() => document.querySelector('form[name=pick] .wb-form-thread')?.textContent?.includes('about pick')))
  assert.ok(await page.$eval('.wb-orphans', el => (el as HTMLElement).hidden), 'nothing orphaned yet')

  // the writer removes the form: its thread moves to the end of the page
  proj.page('q', '# Q\n\nThe question is gone.\n')
  await until('the thread after the page', () => page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.wb-orphans')!
    return !box.hidden && box.querySelector('[data-form=pick]')?.textContent?.includes('about pick')
  }))
  // and the agent can still answer in it
  proj.cli('append', '--page', 'q', '--type', 'form:thread', '--data', JSON.stringify({ form: 'pick', text: 'still here' }))
  await until('the answer shows', () => page.evaluate(() => document.querySelector('.wb-orphans')!.textContent!.includes('still here')))

  // the form comes back: so does its thread, and the list is gone
  proj.page('q', `# Q\n\n${FORM}`)
  await until('back under its form', () => page.evaluate(() =>
    document.querySelector<HTMLElement>('.wb-orphans')!.hidden && !!document.querySelector('form[name=pick] .wb-form-thread')?.textContent?.includes('still here')))
  assert.deepEqual(errors, [], 'no console errors')
})
