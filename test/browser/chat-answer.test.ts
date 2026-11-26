// An answer settled on in a form's chat: the agent's message marked `answer` has a button that
// answers the form with its text, as a submit would; the form folds with that text as its answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

test(
  "chat answer: the agent's message answers the form with its text, on the reader's press",
  { timeout: 60000 },
  async t => {
    const proj = await project({
      pages: { p: '# P\n\n:::form{name=when}\n:radio[Today]{name=day} :radio[Tomorrow]{name=day}\n:::\n' },
    })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.goto(proj.url('p'))
    const message = (data: object) =>
      proj.cli('append', '--page', 'p', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'when', ...data }))
    message({ text: 'Neither works for me.' })
    message({ text: 'Ship on Monday, after the migration', answer: true })
    await until('both messages', () =>
      page.evaluate(() => document.querySelectorAll('form[name=when] .wb-chat-message').length === 2 || null),
    )
    assert.equal(await page.locator('.wb-chat-answer').count(), 1, 'only the message marked as an answer')

    const watch = proj.spawn('watch', '--page', 'p', '--type', 'when')
    await until(
      'a watch listens',
      async () => (await (await fetch(proj.url('api/listeners?page=p'))).json()).length === 1 || null,
    )
    await page.click('.wb-chat-answer')
    const got = JSON.parse(await until('the answer handed out', () => watch.output().trim() || null))
    const from = proj.events().find(e => e.type === 'chat:message' && e.data.answer)!
    assert.equal(got.type, 'when')
    assert.deepEqual(got.data, { answer: 'Ship on Monday, after the migration', 'chat:message': from.id })

    await proj.handle('when')
    await page.waitForSelector('form[name=when][data-wb-folded] .wb-folded')
    assert.equal(await page.textContent('form[name=when] .wb-folded-choice'), '✓ Ship on Monday, after the migration')
    await page.click('form[name=when] .wb-folded-chat')
    assert.equal(await page.textContent('.wb-chat-answer'), '✓ The answer')
    assert.ok(await page.locator('.wb-chat-answer').isDisabled())
    assert.deepEqual(errors, [])
  },
)
