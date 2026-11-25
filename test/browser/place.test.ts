// The reader's place: what they read stays where it is on screen while the page changes around it.
// A chat message coming in above them (drawn by the chat's island, not a page update, and redrawn
// once its markdown is in), a page update that puts a block above them whose island draws itself
// after the update, and an update to the block they are reading, below where they read in it.
// In Chromium and in WebKit (which has no scroll anchoring of its own).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, webkit, type Page } from 'playwright'
import { project, until } from './project.ts'

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const list = (n: number) => Array.from({ length: n }, (_, i) => `- Item ${i}.`).join('\n')
const LONG = ['A reply that takes', '', 'a few paragraphs,', '', '```ts', 'const and = "code"', '```', '', 'too.'].join(
  '\n',
)

/** Scroll so the paragraph that says `text` is `y` from the top of the view. */
async function scrollTo(page: Page, text: string, y: number) {
  await page.evaluate(
    ([text, y]) => {
      const el = [...document.querySelectorAll('#wb-main p, #wb-main li')].find(p => p.textContent?.trim() === text)!
      scrollBy(0, el.getBoundingClientRect().top - (y as number))
    },
    [text, y] as const,
  )
  // the page has its scroll event before anything changes
  await page.waitForTimeout(200)
}

/** It stayed at `y`: within a pixel, as scrolling goes by whole pixels and layout by fractions. */
function stayed(top: number | null, y: number, what: string) {
  assert.ok(top != null && Math.abs(top - y) <= 1, `${what}: at ${top}, not ${y}`)
}

/** Where the paragraph that says `text` is on screen, once the page has stopped moving. */
async function settledTop(page: Page, text: string) {
  const top = () =>
    page.evaluate(text => {
      const el = [...document.querySelectorAll('#wb-main p, #wb-main li')].find(p => p.textContent?.trim() === text)
      return el ? Math.round(el.getBoundingClientRect().top) : null
    }, text)
  let last = await top()
  for (let still = 0; still < 6;) {
    await page.waitForTimeout(100)
    const now = await top()
    still = now === last ? still + 1 : 0
    last = now
  }
  return last
}

for (const [name, engine] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
] as const) {
  test(
    `${name}: what the reader reads stays where it is while the page changes above and around it`,
    { timeout: 90000 },
    async t => {
      const proj = await project({
        pages: {
          p: `# Place\n\n:::chat{name=talk}\n:::\n\n${filler(60, 'Para')}\n\n${list(40)}\n\n${filler(30, 'End')}\n`,
        },
      })
      const b = await engine.launch()
      t.after(async () => {
        await b.close()
        await proj.close()
      })
      const page = await b.newPage({ viewport: { width: 900, height: 700 } })
      const errors: string[] = []
      // WebKit reports a plugin's ResizeObserver that resizes what it observes, without this change too
      page.on('pageerror', e => {
        if (!/ResizeObserver loop/.test(String(e))) errors.push(String(e))
      })
      await page.goto(proj.url('p'))
      await page.waitForSelector('.wb-chat textarea')

      // a chat message above the reader, its markdown drawn after it shows
      await scrollTo(page, 'Para 30.', 300)
      for (let i = 0; i < 3; i++)
        proj.cli(
          'append',
          '--page',
          'p',
          '--type',
          'chat:message',
          '--data',
          JSON.stringify({ chat: 'talk', text: LONG }),
        )
      await until('the messages, as markdown', () =>
        page.evaluate(() => document.querySelectorAll('.wb-chat-bubble[data-md] pre').length === 3 || null),
      )
      stayed(await settledTop(page, 'Para 30.'), 300, 'messages in a chat above')

      // a block above the reader whose island draws itself after the update: a form, its chat with talk
      for (let i = 0; i < 3; i++)
        proj.cli(
          'append',
          '--page',
          'p',
          '--type',
          'chat:message',
          '--data',
          JSON.stringify({ chat: 'later', text: LONG }),
        )
      proj.page(
        'p',
        `# Place\n\n:::chat{name=talk}\n:::\n\n:::form{name=later}\n:text[Why]{name=why}\n:::\n\n${filler(60, 'Para')}\n\n${list(40)}\n\n${filler(30, 'End')}\n`,
      )
      await until('the form and its chat', () =>
        page.evaluate(
          () => document.querySelectorAll('form[name=later] .wb-chat-bubble[data-md] pre').length === 3 || null,
        ),
      )
      stayed(await settledTop(page, 'Para 30.'), 300, 'a form with a chat put in above')

      // the block being read changes below where it is read: items at the end of the list
      await scrollTo(page, 'Item 10.', 300)
      proj.page(
        'p',
        `# Place\n\n:::chat{name=talk}\n:::\n\n:::form{name=later}\n:text[Why]{name=why}\n:::\n\n${filler(60, 'Para')}\n\n${list(55)}\n\n${filler(30, 'End')}\n`,
      )
      await until('the longer list', () =>
        page.evaluate(
          () => [...document.querySelectorAll('li')].some(li => li.textContent?.trim() === 'Item 54.') || null,
        ),
      )
      stayed(await settledTop(page, 'Item 10.'), 300, 'items put in below, in the block being read')
      assert.deepEqual(errors, [])
    },
  )
}
