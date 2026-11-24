// Code in a chat message keeps its lines whole and scrolls sideways, as on a page; a fence that says
// {wrap} wraps them. A block that scrolls stays inside the chat and its form, and the text after it
// starts below it (WebKit drew the scrollbar of such a block over the next line).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'
import type { Page } from 'playwright'

const PAGE = `# Code in a chat\n\n:::form{name=q}\n:button[Go]\n:::\n`
const long =
  'return { body: drawer(state, await term.screens(state.sessions), client, and, a, good, deal, more, than, fits) }'
const message = (fence: string) =>
  [
    'Before:',
    '',
    fence,
    '   setup(ctx) {',
    `-    ${long}`,
    `+    ${long.replace('client, ', '')}`,
    '````',
    '',
    'After the block.',
  ].join('\n')

/** The first code block in a chat message: whether it scrolls, how far the chat reaches past its form, and over the text after it. */
async function chatBlock(page: Page) {
  await until('the message', () =>
    page
      .locator('.wb-chat-bubble pre')
      .count()
      .then(n => n > 0 || null),
  )
  return page.evaluate(() => {
    const pre = document.querySelector<HTMLElement>('.wb-chat-bubble pre')!
    // the code inside the block scrolls (code/style.css), never the block itself
    const code = pre.querySelector('code')!
    return {
      scrolls: code.scrollWidth > code.clientWidth,
      blockOverflows: pre.scrollWidth > pre.clientWidth || pre.scrollHeight > pre.clientHeight,
      verticalBar: code.offsetWidth - code.clientWidth,
      chatPastForm: Math.round(
        pre.closest('.wb-chat')!.getBoundingClientRect().right - pre.closest('form')!.getBoundingClientRect().right,
      ),
      overlap: Math.round(pre.getBoundingClientRect().bottom - pre.nextElementSibling!.getBoundingClientRect().top),
    }
  })
}

test(
  'a code block in a chat message keeps its lines whole and scrolls, inside its form, above the text after it',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { c: PAGE } })
    const { browser: b, page } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 900, height: 900 })
    proj.cli(
      'append',
      '--page',
      'c',
      '--type',
      'chat:message',
      '--data',
      JSON.stringify({ chat: 'q', text: message('````diff') }),
    )
    await page.goto(proj.url('c'))
    const got = await chatBlock(page)
    assert.ok(got.scrolls, 'its lines whole: the code scrolls')
    assert.equal(got.blockOverflows, false, 'the block itself neither scrolls nor overflows')
    assert.equal(got.verticalBar, 0, 'no vertical scrollbar')
    assert.ok(got.chatPastForm <= 0, `inside its form (${got.chatPastForm}px past it)`)
    assert.ok(got.overlap <= 0, `the text after it starts below it (${got.overlap}px over it)`)
  },
)

test(
  'a fence that says {wrap} wraps its long lines, a diff too, in a chat message and on a page',
  { timeout: 60000 },
  async t => {
    const proj = await project({
      pages: { c: PAGE, p: `# Page\n\n\`\`\`ts {wrap}\nconst x = ${JSON.stringify(long)}\n\`\`\`\n\nAfter.\n` },
    })
    const { browser: b, page } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 900, height: 900 })
    proj.cli(
      'append',
      '--page',
      'c',
      '--type',
      'chat:message',
      '--data',
      JSON.stringify({ chat: 'q', text: message('````diff {wrap}') }),
    )
    await page.goto(proj.url('c'))
    const got = await chatBlock(page)
    assert.equal(got.scrolls, false, 'in a chat: wrapped')
    assert.ok(got.chatPastForm <= 0)
    await page.goto(proj.url('p'))
    assert.equal(
      await page.evaluate(() => {
        const code = document.querySelector<HTMLElement>('#wb-main pre code')!
        return code.scrollWidth > code.clientWidth
      }),
      false,
      'on a page: wrapped',
    )
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

test(
  'a code block in a chat of its own (no form) scrolls inside the chat, its scrollbar inside the block',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { c: '# A chat\n\n:::chat{name=talk}\n:::\n' } })
    const { browser: b, page } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 700, height: 900 })
    proj.cli(
      'append',
      '--page',
      'c',
      '--type',
      'chat:message',
      '--data',
      JSON.stringify({ chat: 'talk', text: message('````ts') }),
    )
    await page.goto(proj.url('c'))
    await until('the message', () =>
      page
        .locator('.wb-chat-bubble pre')
        .count()
        .then(n => n > 0 || null),
    )
    const got = await page.evaluate(() => {
      const pre = document.querySelector<HTMLElement>('.wb-chat-bubble pre')!
      const code = pre.querySelector('code')!
      return {
        scrolls: code.scrollWidth > code.clientWidth,
        pastChat: Math.round(
          pre.closest('.wb-chat-bubble')!.getBoundingClientRect().right -
            pre.closest('.wb-chat-block')!.getBoundingClientRect().right,
        ),
        // the scroller ends inside the block's background, above its bottom padding
        barInside: Math.round(pre.getBoundingClientRect().bottom - code.getBoundingClientRect().bottom),
      }
    })
    assert.ok(got.scrolls)
    assert.ok(got.pastChat <= 0, `the message stays inside its chat (${got.pastChat}px past it)`)
    assert.ok(got.barInside >= 0, `the scrollbar is inside the block (${got.barInside}px)`)
  },
)
