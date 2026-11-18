// Two forms on a page whose choices share a name: each form's answer is its own, also across a
// live update of the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const FORM = (name: string, a: string, b: string) =>
  `:::form{name=${name}}\n- :radio[${a}]{name=q2}\n- :radio[${b}]{name=q2}\n:::\n`
const PAGE = (extra = '') => `# Two forms\n\n${extra}${FORM('state', 'Idle', 'Busy')}\n${FORM('hooks', 'Yes', 'No')}`

for (const update of [false, true]) {
  test(
    `two forms with choices of the same name keep their own answers${update ? ', across an update' : ''}`,
    { timeout: 60000 },
    async t => {
      const proj = await project({ pages: { r: PAGE() } })
      const { browser: b, page, errors } = await browser()
      t.after(async () => {
        await b.close()
        await proj.close()
      })
      await page.goto(proj.url('r'))
      await page.check('form[name=state] input[value=Busy]')
      await page.click('form[name=state] button')
      await until('the first answer', () => proj.events().find(e => e.type === 'state'))
      await page.waitForSelector('form[name=state][data-wb-state=sent]')
      if (update) {
        proj.page('r', PAGE('A new paragraph.\n\n'))
        await page.waitForSelector('text=A new paragraph.')
        await page.waitForTimeout(500)
      }
      await page.check('form[name=hooks] input[value=Yes]')
      await page.click('form[name=hooks] button')
      const hooks = await until('the second answer', () => proj.events().find(e => e.type === 'hooks'))
      assert.deepEqual(hooks.data, { q2: 'Yes' })
      assert.deepEqual(proj.events().find(e => e.type === 'state')!.data, { q2: 'Busy' })
      assert.ok(
        await page.locator('form[name=state] input[value=Busy]').isChecked(),
        'the first form still shows its own',
      )
      assert.deepEqual(errors, [])
    },
  )
}
