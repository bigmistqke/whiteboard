// The comments plugin in the browser: a comment on a selection, the agent's reply from the command
// line, the passage found again after an edit, and closing the thread.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { browser, project, until } from './project.ts'

const CONFIG = `import { defineConfig } from '@bigmistqke/whiteboard'
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

const DIFF_PAGE = `# Review

\`\`\`\`diff
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export { a }
\`\`\`\`
`

test('comments on lines of a diff: tinted lines, a drag over two, and where they are', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: DIFF_PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })

  await page.goto(proj.url('q'))
  await page.waitForSelector('pre .line[data-diff]')
  assert.deepEqual(await page.$$eval('pre .line', ls => ls.map(l => (l as HTMLElement).dataset.diff)),
    ['file', 'hunk', 'context', 'del', 'add', 'add', 'context'])
  // the headers read as the file's name and where the hunk starts
  assert.deepEqual(await page.$$eval('pre .line[data-diff=file], pre .line[data-diff=hunk]', ls => ls.map(l => l.textContent)), ['src/a.ts', ''])

  // hover "const b = 3", press its "+", drag down to "const c = 4"
  const line = (text: string) => page.locator('pre .line', { hasText: text })
  await line('const b = 3').hover()
  const plus = page.locator('.wb-line-comment')
  await plus.waitFor({ state: 'visible' })
  const from = (await plus.boundingBox())!
  const to = (await line('const c = 4').boundingBox())!
  // the way a hand goes: from the line, left through the block's padding, onto the "+"
  const start = (await line('const b = 3').boundingBox())!
  await page.mouse.move(start.x + 40, start.y + start.height / 2)
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 12 })
  assert.ok(await plus.isVisible(), 'the "+" stays on the way to it')
  // or diagonally, from further down the block across other lines: the "+" follows the pointer's
  // height and is there when the pointer arrives
  const below = (await line('export { a }').boundingBox())!
  await page.mouse.move(below.x + 30, below.y + below.height / 2)
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 30 })
  assert.ok(await plus.isVisible(), 'the "+" stays when the pointer comes diagonally')
  assert.equal(Math.round((await plus.boundingBox())!.y), Math.round(from.y), 'the "+" is for the line at the pointer\'s height')
  // the pointer leaves the page: the "+" goes, and comes back on the next hover
  // (from the "+" itself, which can sit at the window's edge: no move off it reaches the page, only
  // the leave a window gives, which Playwright's mouse doesn't)
  await page.mouse.move(from.x + 10, from.y + 10)
  await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')))
  await plus.waitFor({ state: 'hidden', timeout: 3000 })
  await line('const b = 3').hover()
  await plus.waitFor({ state: 'visible' })
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 12 })
  await page.mouse.down()
  await page.mouse.move(from.x + 10, to.y + to.height / 2, { steps: 4 })
  await page.mouse.up()

  await page.waitForSelector('.wb-comment-new', { state: 'visible' })
  await page.fill('.wb-comment-new textarea', 'why 3?')
  await page.click('.wb-comment-new button[type=submit]')
  const comment = await until('the comment is in the log', () => proj.events().find(e => e.type === 'comments:new'))
  assert.equal(comment.data.quote, '+const b = 3\n+const c = 4')
  assert.equal(comment.data.at, 'src/a.ts:2 – src/a.ts:3')
  await until('its badge', async () => (await page.$$eval('.wb-comment-badge:not([data-detached])', b => b.length)) === 1)
  assert.match(await page.textContent('.wb-thread:not(.wb-comment-new)') ?? '', /src\/a\.ts:2 – src\/a\.ts:3/)
  assert.deepEqual(errors, [], 'no console errors')
})
