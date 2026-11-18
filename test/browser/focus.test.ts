// Typing while the page updates: the box keeps its focus, what was typed, the caret, and its place
// on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = (extra = '', beforeForm = '') => `# Focus\n\n${extra}${filler(20, 'Before')}\n\n${beforeForm}:::form{name=q}\n:text[Why]{name=why}\n:::\n\nSome words to comment on.\n\n${filler(20, 'After')}\n`

type Probe = { focused: boolean; value: string; caret: number | null; top: number }
const probe = (selector: string) => (sel: string) => {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)
  if (!el) return null
  return { focused: document.activeElement === el, value: el.value, caret: el.selectionStart, top: Math.round(el.getBoundingClientRect().top) }
}

for (const [what, selector, where] of [
  ['a form field', 'input[name=why]', 'top'],
  ['the chat under a form', 'form[name=q] .wb-chat-new textarea', 'top'],
  ['a form field', 'input[name=why]', 'just above it'],
  ['the chat under a form', 'form[name=q] .wb-chat-new textarea', 'just above it'],
] as const) {
  test(`typing in ${what} while content comes in at the ${where === 'top' ? 'top' : 'form'} (${where}): focus, text, caret and place on screen stay`, { timeout: 60000 }, async t => {
    const proj = await project({ pages: { f: PAGE() } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => { await b.close(); await proj.close() })
    await page.goto(proj.url('f'))
    const box = page.locator(selector)
    await box.scrollIntoViewIfNeeded()
    // low on the screen, with blocks in view above it
    await page.evaluate(sel => { const el = document.querySelector(sel)!; scrollBy(0, el.getBoundingClientRect().top - innerHeight * 0.7) }, selector)
    await box.click()
    await page.keyboard.type('half a thought')
    await page.keyboard.press('ArrowLeft')
    const before = (await page.evaluate(probe(selector), selector)) as Probe
    const added = `A new paragraph above.\n\n${filler(5, 'New')}\n\n`
    proj.page('f', where === 'top' ? PAGE(added) : PAGE('', added))
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
  proj.page('f', PAGE('', `A new paragraph above.\n\n${filler(5, 'New')}\n\n`))
  await page.waitForSelector('text=A new paragraph above.')
  await page.waitForTimeout(600)
  const after = (await page.evaluate(probe(reply), reply)) as Probe
  assert.deepEqual({ focused: after.focused, value: after.value, caret: after.caret }, { focused: before.focused, value: before.value, caret: before.caret })
  assert.ok(Math.abs(after.top - before.top) < 3, `the reply box stays where it was on screen (${before.top} → ${after.top})`)
  assert.deepEqual(errors, [])
})

test('typing in a chat while the agent answers in it: the box stays where it is on screen', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { f: PAGE() } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('f'))
  const selector = 'form[name=q] .wb-chat-new textarea'
  await page.locator(selector).scrollIntoViewIfNeeded()
  await page.evaluate(sel => { const el = document.querySelector(sel)!; scrollBy(0, el.getBoundingClientRect().top - innerHeight * 0.7) }, selector)
  await page.click(selector)
  await page.keyboard.type('asking something')
  const before = (await page.evaluate(probe(selector), selector)) as Probe
  proj.cli('append', '--page', 'f', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'q', text: 'an answer\n\nover a few\n\nparagraphs' }))
  await page.waitForSelector('form[name=q] .wb-chat-bubble[data-md]')
  await page.waitForTimeout(400)
  const after = (await page.evaluate(probe(selector), selector)) as Probe
  assert.ok(after.focused && after.value === 'asking something')
  assert.ok(Math.abs(after.top - before.top) < 3, `the box stays where it was on screen (${before.top} → ${after.top})`)
  assert.deepEqual(errors, [])
})
