// Named forms in the browser: where each stands, drafts, a submit handed to a wait,
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
  // unanswered, it waits for the reader, whether or not an agent listens
  assert.ok(s.attrs.includes('data-wb-open'), 'open without an answer')
  assert.equal(s.summary, '1 waiting for you')
  assert.equal(s.summaryBeforeMain, 'MAIN', 'the summary line sits right before <main>')
  s = await until('the title badge', async () => { const x = await state(); return x.title.startsWith('(!1) ') ? x : null })
  assert.equal(s.button, '→ waiting for you (1)', 'corner button')

  const wait = proj.spawn('wait', '--page', 'q')
  await until('the wait listens', async () => (await (await fetch(proj.url('api/listeners?page=q'))).json()).length === 1 || null)
  assert.ok((await state()).attrs.includes('data-wb-open'), 'a wait changes nothing for the reader')

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

test('event names: a form name with a colon is refused, and its chat is chat:message', { timeout: 60000 }, async t => {
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
  proj.cli('append', '--page', 'q', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'pick', text: 'about pick' }))

  await page.goto(proj.url('q'))
  await until('the thread shows it', () => page.evaluate(() =>
    (document.querySelector('form[name=pick] .wb-chat')?.textContent ?? '').includes('about pick')))
  assert.match(await page.textContent('.wb-error') ?? '', /form name "comments:new" has a colon/)
  // the page asks only the one question
  assert.match(proj.cli('status', '--page', 'q'), /nobody listens for pick\n/)
  assert.deepEqual(errors, [], 'no console errors')
})

test('a chat whose form is gone shows after the page, until the form is back', { timeout: 60000 }, async t => {
  const FORM = ':::form{name=pick}\n:radio[A]{name=x}\n:::\n'
  const proj = await project({ pages: { q: `# Q\n\n${FORM}` } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  proj.cli('append', '--page', 'q', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'pick', text: 'about pick' }))
  await page.goto(proj.url('q'))
  await until('the thread under its form', () => page.evaluate(() => document.querySelector('form[name=pick] .wb-chat')?.textContent?.includes('about pick')))
  assert.ok(await page.$eval('.wb-orphans', el => (el as HTMLElement).hidden), 'nothing orphaned yet')

  // the writer removes the form: its thread moves to the end of the page
  proj.page('q', '# Q\n\nThe question is gone.\n')
  await until('the thread after the page', () => page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.wb-orphans')!
    return !box.hidden && box.querySelector('[data-chat=pick]')?.textContent?.includes('about pick')
  }))
  // and the agent can still answer in it
  proj.cli('append', '--page', 'q', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'pick', text: 'still here' }))
  await until('the answer shows', () => page.evaluate(() => document.querySelector('.wb-orphans')!.textContent!.includes('still here')))

  // the form comes back: so does its thread, and the list is gone
  proj.page('q', `# Q\n\n${FORM}`)
  await until('back under its form', () => page.evaluate(() =>
    document.querySelector<HTMLElement>('.wb-orphans')!.hidden && !!document.querySelector('form[name=pick] .wb-chat')?.textContent?.includes('still here')))
  assert.deepEqual(errors, [], 'no console errors')
})

test('a chat block: the reader writes, the agent answers, and a wait hands the message out', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: '# Q\n\n:::chat{name=notes}\nAnything that is not a decision.\n:::\n' } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('q'))
  await page.waitForSelector('[data-chat=notes] .wb-chat textarea')
  assert.match(await page.textContent('[data-chat=notes]') ?? '', /Anything that is not a decision/)
  assert.equal(await page.getAttribute('[data-chat=notes] textarea', 'placeholder'), 'Write a message')

  const wait = proj.spawn('wait', '--page', 'q')
  await page.fill('[data-chat=notes] textarea', 'a thought')
  await page.keyboard.press('Enter')
  const got = JSON.parse(await until('the wait got the message', () => wait.output()))
  assert.equal(got.type, 'chat:message')
  assert.deepEqual(got.data, { chat: 'notes', text: 'a thought' })

  proj.cli('append', '--page', 'q', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'notes', text: 'noted' }))
  await until('the answer, as the agent', () => page.evaluate(() =>
    [...document.querySelectorAll('[data-chat=notes] .wb-chat-message[data-from=agent]')].some(m => m.textContent!.includes('noted'))))
  // the agent's message is for the reader: in view, it is read, in the log
  const noted = proj.events().find(e => e.type === 'chat:message' && e.data.text === 'noted')!
  await until('the message is read', () => proj.events().some(e => e.type === 'whiteboard:read' && e.data.ids.includes(noted.id)) || null)
  // a chat block asks nothing: the page has no open question
  assert.match(proj.cli('status', '--page', 'q'), /nothing open/)
  assert.deepEqual(errors, [], 'no console errors')
})

test('the header lists what waits on other pages, and its link goes to the first waiting form', { timeout: 60000 }, async t => {
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
  const proj = await project({ pages: {
    here: '# Here\n\n:::form{name=mine}\n:text[Note]{name=note}\n:::\n',
    there: `# Over there\n\n${filler}\n\n:::form{name=first}\n:text[A]{name=a}\n:::\n\n${filler}\n\n:::form{name=second}\n:text[B]{name=b}\n:::\n`,
  } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })

  const menu = page.locator('.wb-nav .wb-elsewhere')
  await page.goto(proj.url('here'))
  await page.waitForSelector('form[name=mine][data-wb-open]')
  // the other page's questions wait for the reader, whether or not an agent listens
  await menu.waitFor({ state: 'visible' })
  assert.equal(await page.textContent('.wb-elsewhere-toggle'), '2')
  assert.equal(await page.getAttribute('.wb-elsewhere-toggle', 'aria-label'), 'Awaiting you: 2 questions and messages on another page')
  assert.ok(await page.locator('.wb-elsewhere-list').isHidden(), 'closed until clicked')
  await page.click('.wb-elsewhere-toggle')
  assert.deepEqual(await page.$$eval('.wb-elsewhere-list a', as => as.map(a => a.textContent)), ['Over there (2)'])

  // the overview: the same inbox, after the page's title, and no word on who listens elsewhere
  const overview = await b.newPage()
  await overview.goto(proj.url(''))
  // every page with something for the reader, this one too: the overview is no page of its own
  assert.deepEqual(await overview.$$eval('.wb-index .wb-awaiting', as => as.map(a => [a.textContent, a.getAttribute('href')])), [['2', '/there#wb-waiting'], ['1', '/here#wb-waiting']])
  assert.ok(!(await overview.textContent('.wb-index'))!.includes('agent waiting'))
  await overview.close()

  // its page has no menu for itself: what waits there is in its corner
  await page.click('.wb-elsewhere-list a')
  await page.waitForURL(u => u.pathname === '/there')
  const first = page.locator('form[name=first]')
  await until('scrolled to the first waiting form', async () => {
    const box = await first.boundingBox()
    return box && box.y > 0 && box.y < (page.viewportSize()?.height ?? 720) ? true : null
  })
  assert.equal(new URL(page.url()).hash, '', 'the link\'s #wb-waiting is gone once used')
  // here, the other page is the first one, with its question
  await menu.waitFor({ state: 'visible' })
  assert.equal(await page.textContent('.wb-elsewhere-toggle'), '1')
  assert.deepEqual(errors, [])
})

test('an answer no agent is listening for says so in a toast; one an agent waits for does not', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: '# Q\n\n:::form{name=ask}\n:text[Why]{name=why}\n:::\n' } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })

  await page.goto(proj.url('q'))
  await page.waitForSelector('form[name=ask][data-wb-open]')
  await page.fill('input[name=why]', 'nobody hears this')
  await page.click('form[name=ask] button')
  const toast = page.locator('.wb-toast')
  await toast.waitFor({ state: 'visible' })
  assert.match((await toast.textContent())!, /no agent is listening/)
  await toast.click()
  await toast.waitFor({ state: 'detached' })

  // a wait first hands out the answer nobody picked up yet; the next one waits for a new one
  const first = proj.spawn('wait', '--page', 'q', '--type', 'ask')
  assert.equal(JSON.parse(await until('the first wait got the old answer', () => first.output())).data.why, 'nobody hears this')
  const wait = proj.spawn('wait', '--page', 'q', '--type', 'ask')
  // asked again by name, the decided question is open again
  await page.waitForSelector('form[name=ask][data-wb-open]')
  await page.fill('input[name=why]', 'heard')
  await page.click('form[name=ask] button')
  await until('the wait got it', () => wait.output())
  await page.waitForTimeout(500)
  assert.equal(await page.locator('.wb-toast').count(), 0, 'no toast when an agent took it')
  assert.deepEqual(errors, [])
})
