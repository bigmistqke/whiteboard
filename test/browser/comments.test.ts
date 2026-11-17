// The comments plugin in the browser: a comment on a selection, the agent's reply from the command
// line, the passage found again after an edit, and closing the thread.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { browser, project, until } from './project.ts'

const CONFIG = `import { defineConfig } from '@bigmistqke/whiteboard/config'
import comments from '@bigmistqke/whiteboard/comments'
export default defineConfig({ plugins: [comments()] })
`

const PAGE = `# Test

Intro paragraph with some words to select here.

:::form{name=pick}
- :radio[Apples]{name=fruit}
:::
`

test('comments: comment, reply, a live edit, close', { timeout: 60000 }, async t => {
  const proj = await project({ config: CONFIG, pages: { q: PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })

  await page.goto(proj.url('q'))
  await page.waitForSelector('main p')
  // select "some words" in the intro paragraph
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('main p')].find(x => x.textContent!.includes('some words'))!.firstChild as Text
    const i = t.data.indexOf('some words')
    const r = document.createRange()
    r.setStart(t, i); r.setEnd(t, i + 10)
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r)
  })
  await page.waitForSelector('.wb-comment-start', { state: 'visible' })
  await page.click('.wb-comment-start')
  await page.fill('.wb-comment-new textarea', 'why these words?')
  await page.click('.wb-comment-new button[type=submit]')

  const comment = await until('the comment is in the log', () => proj.events().find(e => e.type === 'comments:new'))
  assert.equal(comment.data.quote, 'some words')
  assert.equal(comment.data.text, 'why these words?')
  await page.waitForSelector('.wb-thread:not(.wb-comment-new)', { state: 'visible' })
  assert.equal(await page.$$eval('.wb-comment-badge', b => b.length), 1, 'one badge')

  // the agent replies from the command line
  proj.cli('append', '--page', 'q', '--type', 'comments:reply', '--data', JSON.stringify({ replyTo: comment.id, text: 'because' }))
  await until('the badge shows the agent replied', () => page.$eval('.wb-comment-badge', b => b.hasAttribute('data-agent') && b.textContent === '2'))

  // a live edit elsewhere keeps the passage
  const file = `${proj.dir}/.whiteboard/pages/q.md`
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('# Test\n', '# Test\n\nA new first paragraph.\n'))
  await until('the edit arrived', () => page.evaluate(() => document.body.textContent!.includes('A new first paragraph')))
  await until('the passage is still highlighted', () => page.evaluate(() =>
    (CSS as any).highlights?.get('wb-comment-active')?.size === 1 || (CSS as any).highlights?.get('wb-comment')?.size === 1))
  assert.ok(await page.$eval('.wb-comment-badge', b => !b.hasAttribute('data-detached')), 'the badge is still attached')

  // forms work next to it
  assert.ok(await page.$eval('form[name=pick]', f => f.hasAttribute('data-wb-unheard')))

  await page.click('.wb-thread [data-close]')
  await until('closing the thread removes it', async () => (await page.$$eval('.wb-comment-badge', b => b.length)) === 0)

  assert.deepEqual(errors, [], 'no console errors')
})
