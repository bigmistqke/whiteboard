// Optimistic: an answer is the form's at once, marked as still on its way (sending), whatever the
// server takes; confirmed once it has it. One that never gets there leaves the form again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { browser, project, until } from './project.ts'

const PAGE = `# Test

:::form{name=pick}
- :radio[Apples]{name=fruit}
- :radio[Pears]{name=fruit}
:::
`

test('a slow send shows at once as sending, then sent; one that fails is taken back', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: PAGE } })
  const { browser: b, page } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  // no log until the first event
  const log = () => {
    try {
      return fs.readFileSync(path.join(proj.dir, '.whiteboard', 'events.ndjson'), 'utf8')
    } catch {
      return ''
    }
  }
  const form = () =>
    page.$eval('form[name=pick]', f => ({
      state: f.getAttribute('data-wb-state'),
      pending: f.hasAttribute('data-wb-pending'),
      open: f.hasAttribute('data-wb-open'),
      label: getComputedStyle(f, '::before').content,
    }))

  // a server that takes its time
  let release!: () => void
  const held = new Promise<void>(r => (release = r))
  await page.route('**/api/events', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    await held
    return route.continue()
  })
  await page.goto(proj.url('q'))
  await page.waitForSelector('form[name=pick][data-wb-open]')
  await page.check('input[value=Pears]')
  await page.click('form[name=pick] button')
  // at once, before the server answered: answered here, and saying it is still on its way
  const now = await form()
  assert.equal(now.state, 'sending')
  assert.equal(now.pending, true, 'the answer is the form’s already')
  assert.equal(now.label, '"sending…"')
  assert.doesNotMatch(log(), /Pears/, 'the server has nothing yet')
  release()
  await until('confirmed', async () => (await form()).state === 'sent' || null)
  assert.match((await form()).label, /✓ sent/)
  assert.equal(log().match(/Pears/g)?.length, 1, 'appended once')

  // a server that never takes it: shown at once, then taken back
  await page.unroute('**/api/events')
  await page.route('**/api/events', route => (route.request().method() === 'POST' ? route.abort() : route.continue()))
  await page.check('input[value=Apples]')
  await page.click('form[name=pick] button')
  assert.equal((await form()).state, 'sending')
  await until('failed', async () => (await form()).state === 'failed' || null, 20000)
  assert.equal((await form()).pending, true, 'back to the answer the server has')
  // and it says so, over the line of the answer the server has
  assert.equal((await form()).label, '"couldn\'t send it: try again"')
  assert.doesNotMatch(log(), /Apples/)
  assert.equal(await page.isChecked('input[value=Apples]'), true, 'what was chosen stays, to send again')
})
