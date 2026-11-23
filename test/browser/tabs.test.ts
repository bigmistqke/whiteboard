// Many tabs on one server: a browser keeps six HTTP/1.1 connections to an origin, and a live channel
// that held one per tab (server-sent events) left none for a seventh tab to load, nor for a form's
// answer to be sent: the form stayed "sending". The live channel is a WebSocket, which doesn't count.
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

test('with eight tabs open, a page still loads and a form still sends', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: PAGE, other: '# Other\n' } })
  const { browser: b, page, newPage } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  for (let i = 0; i < 7; i++) {
    const other = await newPage()
    await other.goto(proj.url('other'))
    await other.waitForSelector('html[data-wb-live]')
  }
  // the eighth: loads, and goes live
  await page.goto(proj.url('q'), { timeout: 10000 })
  await page.waitForSelector('html[data-wb-live]', { timeout: 10000 })
  await page.waitForSelector('form[name=pick][data-wb-open]')
  await page.check('input[value=Pears]')
  await page.click('form[name=pick] button')
  await until('sent', () => page.$eval('form[name=pick]', f => f.getAttribute('data-wb-state') === 'sent' || null))
  const log = fs.readFileSync(path.join(proj.dir, '.whiteboard', 'events.ndjson'), 'utf8')
  assert.match(log, /"fruit":"Pears"/)
})
