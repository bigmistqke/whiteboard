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

test(
  'a fence says whether it wraps: {nowrap} in a chat scrolls inside its form, {wrap} on a page wraps',
  { timeout: 60000 },
  async t => {
    const nowrap = MESSAGE.replace('````diff', '````diff {nowrap}')
    const proj = await project({
      pages: { c: PAGE, p: `# Page\n\n\`\`\`ts {wrap}\nconst x = ${JSON.stringify(long)}\n\`\`\`\n\nAfter.\n` },
    })
    const { browser: b, page } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 900, height: 900 })
    proj.cli('append', '--page', 'c', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'q', text: nowrap }))
    await page.goto(proj.url('c'))
    await until('the message', () =>
      page
        .locator('.wb-chat-bubble pre')
        .count()
        .then(n => n > 0 || null),
    )
    const chat = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>('.wb-chat-bubble pre')!
      return {
        wrap: pre.dataset.wrap,
        scrolls: pre.scrollWidth > pre.clientWidth,
        chatPastForm: Math.round(
          pre.closest('.wb-chat')!.getBoundingClientRect().right - pre.closest('form')!.getBoundingClientRect().right,
        ),
        overlap: Math.round(pre.getBoundingClientRect().bottom - pre.nextElementSibling!.getBoundingClientRect().top),
      }
    })
    assert.equal(chat.wrap, 'false')
    assert.ok(chat.scrolls, 'its lines whole: the block scrolls')
    assert.ok(chat.chatPastForm <= 0, `inside its form (${chat.chatPastForm}px past it)`)
    assert.ok(chat.overlap <= 0, `the text after it starts below it (${chat.overlap}px over it)`)

    await page.goto(proj.url('p'))
    const onPage = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>('#wb-main pre')!
      return { wrap: pre.dataset.wrap, scrolls: pre.scrollWidth > pre.clientWidth }
    })
    assert.deepEqual(onPage, { wrap: 'true', scrolls: false })
  },
)

test('a table in a chat message keeps its words whole and its spacing', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { c: PAGE } })
  const { browser: b, page } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  await page.setViewportSize({ width: 700, height: 900 })
  const table = [
    'Today plugins place things by hand:',
    '',
    '| plugin | where | how |',
    '| --- | --- | --- |',
    '| terminal | a drawer at the bottom | its own `<aside id=wb-terminal>`, found again with `getElementById` |',
    '| comments | buttons and a layer over the page | appended to `<body>` |',
  ].join('\n')
  proj.cli('append', '--page', 'c', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'q', text: table }))
  await page.goto(proj.url('c'))
  await until('the table', () =>
    page
      .locator('.wb-chat-bubble table')
      .count()
      .then(n => n > 0 || null),
  )
  const got = await page.evaluate(() => {
    const t = document.querySelector('.wb-chat-bubble table') as HTMLTableElement
    // how many lines each first-column word takes: one, unless it was broken inside
    const lines = [...t.rows].map(r => {
      const range = document.createRange()
      range.selectNodeContents(r.cells[0]!)
      return new Set([...range.getClientRects()].map(x => Math.round(x.top))).size
    })
    return {
      lines,
      gap: Math.round(t.getBoundingClientRect().top - t.previousElementSibling!.getBoundingClientRect().bottom),
    }
  })
  assert.deepEqual(got.lines, [1, 1, 1], 'plugin, terminal, comments: each on one line')
  assert.ok(got.gap < 20, `the table sits as a paragraph would (${got.gap}px above it)`)
})
