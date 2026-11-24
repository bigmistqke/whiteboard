// Browser-only, WebKit: a code block that scrolls sideways inside a chat message (flex) in a form
// (grid) keeps its scrollbar inside its height, and the text after it below. WebKit lays out an
// `overflow-x: auto` scrollbar under a flex or grid ancestor after the ancestors, which keep the
// height they had without it (https://github.com/block/buzz-app/pull/1677); the code plugin
// measures overflow and chooses the scrollbar in style (plugins/code/client.ts).
//
// Playwright's WebKit draws overlay scrollbars, which take no space; these rules make them take
// space, as macOS does when set to always show scroll bars (WebKit ignores ::-webkit-scrollbar while
// the standard scrollbar properties are set, so those are reset).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { project, until } from './project.ts'

const SCROLLBARS = `* { scrollbar-width: auto !important; scrollbar-color: auto !important; }
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: gray; }`

const PAGE = `# Code in a chat\n\n:::form{name=q}\n:button[Go]\n:::\n`
// too long for a narrow window, short enough for the page's text column in a wide one
const long = `const x = ${JSON.stringify('abcdefghij'.repeat(5))}`
const MESSAGE = ['Short:', '', '```ts', 'const x = 1', '```', '', 'Long:', '', '```ts', long, '```', '', 'After.'].join(
  '\n',
)

test(
  'WebKit: a code block in a chat message has its scrollbar inside its height; one that fits has none',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { c: PAGE } })
    const b = await webkit.launch()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    const page = await b.newPage({ viewport: { width: 420, height: 900 } })
    await page.addInitScript(css => {
      const style = document.createElement('style')
      style.textContent = css
      new MutationObserver(() => {
        if (!style.isConnected) document.head?.append(style)
      }).observe(document, { childList: true, subtree: true })
    }, SCROLLBARS)
    proj.cli('append', '--page', 'c', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'q', text: MESSAGE }))
    await page.goto(proj.url('c'))
    await until('the message', () =>
      page
        .locator('.wb-chat-bubble pre')
        .count()
        .then(n => n === 2 || null),
    )
    // what a block looks like: whether it has a scrollbar, and how far its background falls short of
    // its code (scrollbar and all), and of the next line
    const blocks = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.wb-chat-bubble pre')].map(p => {
          const code = p.querySelector('code')!
          const cs = getComputedStyle(p)
          return {
            bar: code.offsetHeight - code.clientHeight > 0,
            short: Math.round(
              code.offsetHeight +
                parseFloat(cs.paddingTop) +
                parseFloat(cs.paddingBottom) -
                p.getBoundingClientRect().height,
            ),
            over: Math.round(p.getBoundingClientRect().bottom - p.nextElementSibling!.getBoundingClientRect().top) > 0,
          }
        }),
      )
    const expected = [
      { bar: false, short: 0, over: false },
      { bar: true, short: 0, over: false },
    ]
    assert.deepEqual(await blocks(), expected, 'as the page loads')
    // a message arriving into a laid-out page: the case the bug shows in
    proj.cli('append', '--page', 'c', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'q', text: MESSAGE }))
    await until('the second message', () =>
      page
        .locator('.wb-chat-bubble pre')
        .count()
        .then(n => n === 4 || null),
    )
    assert.deepEqual((await blocks()).slice(2), expected, 'as a message arrives')
    // wide enough for the long line: no scrollbar, nothing left under it
    await page.setViewportSize({ width: 1600, height: 900 })
    await until('no scrollbar once it fits', async () => (await blocks()).every(x => !x.bar && x.short === 0) || null)
  },
)
