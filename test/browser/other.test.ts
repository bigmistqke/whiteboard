// An option for an answer not on the list (`other`): typing picks it, it sends what was typed, and
// it comes back from the last answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const PAGE = `# Other\n\n:::form{name=where}\n- :radio[Here]{name=place}\n- :radio[There]{name=place}\n- :radio[Somewhere else]{name=place other placeholder="where?"}\n\n:check[Red]{name=colors} :check[Blue]{name=colors} :check[Another]{name=colors other}\n:::\n`

test('other: typing picks the option, it sends the text, and the last answer comes back into the box', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { o: PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('o'))
  const box = page.locator('[data-wb-other-text][placeholder="where?"]')
  await box.fill('on the moon')
  assert.ok(await page.locator('input[name=place][data-wb-other]').isChecked(), 'typing picked it')
  await page.check('input[name=colors][value=Red]')
  await page.locator('label:has-text("Another") [data-wb-other-text]').fill('green')
  await page.click('form[name=where] button')
  const answer = await until('the answer', () => proj.events().find(e => e.type === 'where'))
  assert.deepEqual(answer.data, { place: 'on the moon', colors: ['Red', 'green'] })
  // the browser has the server's answer too, before the reload
  await page.waitForSelector('form[name=where][data-wb-state=sent]')

  // back after a reload, from the last answer
  await page.reload()
  await page.waitForSelector('form[name=where]')
  await until('in its box again', async () => (await box.inputValue()) === 'on the moon' || null)
  assert.ok(await page.locator('input[name=place][data-wb-other]').isChecked())
  assert.equal(await page.locator('label:has-text("Another") [data-wb-other-text]').inputValue(), 'green')
  // a listed option picked instead: the box's text is not sent
  await page.check('input[name=place][value=Here]')
  assert.deepEqual(errors, [])
})
