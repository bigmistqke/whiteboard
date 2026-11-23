// Code in a chat message wraps at the bubble's edge, a diff too: a line longer than the bubble
// neither makes the chat wider than what holds it, nor gives the block a scrollbar (which WebKit
// draws over the text below it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const PAGE = `# Code in a chat\n\n:::form{name=q}\n:button[Go]\n:::\n`
const long =
  'return { body: drawer(state, await term.screens(state.sessions), client, and, a, good, deal, more, than, fits) }'
const MESSAGE = [
  'Before:',
  '',
  '````diff',
  '   setup(ctx) {',
  `-    ${long}`,
  `+    ${long.replace('client, ', '')}`,
  '````',
  '',
  'After the block.',
].join('\n')

test("a diff in a chat message wraps at the bubble's edge, inside its form", { timeout: 60000 }, async t => {
  const proj = await project({ pages: { c: PAGE } })
  const { browser: b, page } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  await page.setViewportSize({ width: 900, height: 900 })
  proj.cli('append', '--page', 'c', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'q', text: MESSAGE }))
  await page.goto(proj.url('c'))
  // a decided-or-not form folds its chat: open it, so the message lays out
  await until('the message', () =>
    page
      .locator('.wb-chat-bubble pre')
      .count()
      .then(n => n > 0 || null),
  )
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => (d.open = true)))
  const sizes = await page.evaluate(() => {
    const pre = document.querySelector<HTMLElement>('.wb-chat-bubble pre')!
    const after = pre.nextElementSibling!
    const form = pre.closest('form')!
    const chat = pre.closest('.wb-chat')!
    return {
      preScrolls: pre.scrollWidth - pre.clientWidth,
      chatPastForm: Math.round(chat.getBoundingClientRect().right - form.getBoundingClientRect().right),
      overlap: Math.round(pre.getBoundingClientRect().bottom - after.getBoundingClientRect().top),
    }
  })
  assert.equal(sizes.preScrolls, 0, 'the block wraps, no scrollbar')
  assert.ok(sizes.chatPastForm <= 0, `the chat stays inside its form (${sizes.chatPastForm}px past it)`)
  assert.ok(sizes.overlap <= 0, `the text after the block starts below it (${sizes.overlap}px over it)`)
})
