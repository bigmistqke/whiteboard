// A decided form folds into a card, and its chat with it: a message from the agent opens the chat,
// which stays open once read until the reader folds it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const PAGE = `# Fold\n\n:::form{name=go}\n:radio[Yes, build it]{name=pick} :radio[Not yet]{name=pick}\n\n:textarea[Why]{name=why}\n:::\n\n:::form{name=note}\n:textarea[Anything]{name=text}\n:::\n`

test('folded: a card with the choice and the text; the chat folds, opens for a message, stays open once read', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { f: PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('f'))
  const wait = proj.spawn('watch', '--page', 'f')
  await until('a watch listens', async () => (await (await fetch(proj.url('api/listeners?page=f'))).json()).length === 1 || null)

  await page.check('input[value="Yes, build it"]')
  await page.fill('form[name=go] textarea', 'because it ships together with the font and density fix in the same build')
  await page.click('form[name=go] button.wb-primary')
  await page.waitForSelector('form[name=go][data-wb-folded] .wb-folded')
  assert.equal(await page.textContent('form[name=go] .wb-folded-choice'), '✓ Yes, build it')
  assert.equal(await page.textContent('form[name=go] .wb-folded-text'), 'because it ships together with the font and density fix in the same build')
  assert.ok(await page.locator('form[name=go] .wb-folded-chat').isHidden(), 'no chat yet: no button')

  // only written: the text is the answer, said once, no "sent"
  await page.fill('form[name=note] textarea', 'just a remark, long enough to count as written text rather than a choice')
  await page.click('form[name=note] button.wb-primary')
  await page.waitForSelector('form[name=note][data-wb-folded] .wb-folded')
  assert.match((await page.textContent('form[name=note] .wb-folded-choice'))!, /^✓ just a remark/)
  assert.ok(await page.locator('form[name=note] .wb-folded-text').isHidden())

  // the agent answers in the chat: it opens, and stays open once read
  proj.cli('append', '--page', 'f', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'go', text: 'building it now' }))
  await until('the chat opened', () => page.$eval('form[name=go]', f => f.hasAttribute('data-wb-chat-open')) || null)
  await until('read', () => proj.events().some(e => e.type === 'whiteboard:read') || null)
  await page.waitForTimeout(400)
  assert.ok(await page.$eval('form[name=go]', f => f.hasAttribute('data-wb-chat-open')), 'still open once read')
  assert.equal(await page.textContent('form[name=go] .wb-folded-chat'), '💬 1 message ▾')

  // folded by the reader, and opened again; neither opens the form
  await page.click('form[name=go] .wb-folded-chat')
  assert.ok(await page.locator('form[name=go] .wb-chat-message').isHidden(), 'folded')
  await page.click('form[name=go] .wb-folded-chat')
  assert.ok(await page.locator('form[name=go] .wb-chat-message').isVisible(), 'open again')
  assert.ok(await page.$eval('form[name=go]', f => f.hasAttribute('data-wb-folded')), 'the form stays decided')
  wait.kill()
  assert.deepEqual(errors, [])
})
