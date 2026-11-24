// `whiteboard edit` and `whiteboard prune`: an agent's message changed in place, a page's events
// removed with the page kept; an open tab follows both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

test(
  'edit and prune: the tab shows the new text, then an empty chat; the answer and the page stay',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { p: '# Page\n\n:::form{name=q}\n:text[Why]{name=why}\n:::\n' } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.goto(proj.url('p'))
    await page.fill('input[name=why]', 'my answer')
    await page.click('form[name=q] button')
    await page.waitForSelector('form[name=q][data-wb-state=sent]')
    const message = JSON.parse(
      proj.cli(
        'append',
        '--page',
        'p',
        '--type',
        'chat:message',
        '--data',
        JSON.stringify({ chat: 'q', text: 'a rough draft' }),
      ),
    )
    await page.waitForSelector('.wb-chat-bubble >> text=a rough draft')

    const edited = JSON.parse(proj.cli('edit', message.id, '--data', JSON.stringify({ text: 'a **formatted** reply' })))
    assert.equal(edited.id, message.id)
    assert.deepEqual(edited.data, { chat: 'q', text: 'a **formatted** reply' })
    await page.waitForSelector('.wb-chat-bubble[data-md] strong >> text=formatted')
    assert.equal(await page.locator('text=a rough draft').count(), 0)

    // the reader's answer is theirs
    const answer = proj.events().find(e => e.type === 'q')!
    assert.throws(() => proj.cli('edit', answer.id, '--data', '{"why":"not what they said"}'))

    // one chat's messages, by their data: another chat's name prunes nothing
    assert.match(
      proj.cli('prune', 'p', '--type', 'chat:message', '--data', '{"chat":"other"}'),
      /pruned 0 events of p/,
    )
    assert.match(proj.cli('prune', 'p', '--type', 'chat:message'), /pruned 1 event of p \(of type chat:message\)/)
    await until('the chat is empty', async () => (await page.locator('.wb-chat-message').count()) === 0 || null)
    assert.deepEqual(
      proj
        .events()
        .map(e => e.type)
        .filter(t => t === 'q'),
      ['q'],
      'the answer stays',
    )
    assert.ok(await page.locator('form[name=q]').isVisible(), 'the page stays')
    assert.deepEqual(errors, [])
  },
)
