// Typing while the page updates: the box keeps its focus, what was typed, the caret, and its place
// on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = (extra = '') => `# Focus\n\n${extra}${filler(20, 'Before')}\n\n:::form{name=q}\n:text[Why]{name=why}\n:::\n\nSome words to comment on.\n\n${filler(20, 'After')}\n`

type Probe = { focused: boolean; value: string; caret: number | null; top: number }
const probe = (selector: string) => (sel: string) => {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)
  if (!el) return null
  return { focused: document.activeElement === el, value: el.value, caret: el.selectionStart, top: Math.round(el.getBoundingClientRect().top) }
}

for (const [what, selector] of [['a form field', 'input[name=why]'], ['the chat under a form', 'form[name=q] .wb-chat-new textarea']] as const) {
  test(`typing in ${what} while the page updates above it: focus, text, caret and place stay`, { timeout: 60000 }, async t => {
    const proj = await project({ pages: { f: PAGE() } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => { await b.close(); await proj.close() })
    await page.goto(proj.url('f'))
    const box = page.locator(selector)
    await box.scrollIntoViewIfNeeded()
    await box.click()
    await page.keyboard.type('half a thought')
    await page.keyboard.press('ArrowLeft')
    const before = (await page.evaluate(probe(selector), selector)) as Probe
    proj.page('f', PAGE(`A new paragraph above.\n\n${filler(5, 'New')}\n\n`))
    await page.waitForSelector('text=A new paragraph above.')
    await page.waitForTimeout(600)
    const after = (await page.evaluate(probe(selector), selector)) as Probe
    assert.deepEqual({ ...after, top: Math.abs(after.top - before.top) < 3 }, { ...before, top: true })
    assert.deepEqual(errors, [])
  })
}

test('typing a comment reply while another reply arrives: focus, text and caret stay', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { f: PAGE() } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('f'))
  await page.locator('text=Some words to comment on.').scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find(p => p.textContent!.includes('Some words to comment on.'))!
    const range = document.createRange(); range.selectNodeContents(p)
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  })
  await page.click('.wb-comment-start')
  await page.fill('.wb-comment-new textarea', 'a comment')
  await page.press('.wb-comment-new textarea', 'Enter')
  const comment = await until('the comment', () => proj.events().find(e => e.type === 'comments:new'))
  const reply = '.wb-thread:not(.wb-comment-new) textarea'
  await page.waitForSelector(reply)
  await page.click(reply)
  await page.keyboard.type('my reply so far')
  const before = (await page.evaluate(probe(reply), reply)) as Probe
  proj.cli('append', '--page', 'f', '--type', 'comments:reply', '--data', JSON.stringify({ replyTo: comment.id, text: 'the agent says' }))
  await page.waitForSelector('.wb-thread-message[data-from=agent]')
  proj.page('f', PAGE('A new paragraph above.\n\n'))
  await page.waitForSelector('text=A new paragraph above.')
  await page.waitForTimeout(600)
  const after = (await page.evaluate(probe(reply), reply)) as Probe
  assert.deepEqual({ focused: after.focused, value: after.value, caret: after.caret }, { focused: before.focused, value: before.value, caret: before.caret })
  assert.deepEqual(errors, [])
})
