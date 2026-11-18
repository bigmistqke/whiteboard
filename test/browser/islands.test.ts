// Islands (a block's browser part, such as the chat under a form) across a live update of the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

const FORM = (name: string, label = 'Why') => `:::form{name=${name}}\n:text[${label}]{name=why}\n:::\n`

const cases: [string, string, string][] = [
  ['content after the form', `# Notes\n\n${FORM('a')}`, `# Notes\n\n${FORM('a')}\nA new paragraph.\n`],
  ['content before the form', `# Notes\n\n${FORM('a')}`, `# Notes\n\nA new paragraph.\n\n${FORM('a')}`],
  ['the form itself changes', `# Notes\n\n${FORM('a')}`, `# Notes\n\n${FORM('a', 'Why not')}\nA new paragraph.\n`],
  [
    'two forms, one new between',
    `# Notes\n\n${FORM('a')}\n${FORM('b')}`,
    `# Notes\n\n${FORM('a')}\nA new paragraph.\n\n${FORM('c')}\n${FORM('b')}`,
  ],
]

for (const [what, before, after] of cases) {
  test(`the chats under forms stay when the page gets new content: ${what}`, { timeout: 60000 }, async t => {
    const proj = await project({ pages: { q: before } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })

    await page.goto(proj.url('q'))
    for (const name of ['a', 'b'])
      if (before.includes(`name=${name}}`))
        proj.cli(
          'append',
          '--page',
          'q',
          '--type',
          'chat:message',
          '--data',
          JSON.stringify({ chat: name, text: `note on ${name}` }),
        )
    const notes = () =>
      page.$$eval('form .wb-chat-message', ms => ms.map(m => m.textContent!.replace(/^agent/, '')).sort())
    const expected = ['a', 'b'].filter(n => before.includes(`name=${n}}`)).map(n => `note on ${n}`)
    await page.waitForFunction(n => document.querySelectorAll('form .wb-chat-message').length === n, expected.length)

    proj.page('q', after)
    await page.waitForSelector('text=A new paragraph.')
    await page.waitForTimeout(800)
    assert.deepEqual(await notes(), expected, 'the notes are still there')
    const forms = (after.match(/:::form/g) ?? []).length
    assert.equal(await page.locator('form .wb-chat-new textarea').count(), forms, 'and every form has its box')
    assert.deepEqual(errors, [])
  })
}
