// Open details: their summaries stick below the header, and nested ones stack below their parents'.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = `# Details\n\n::::details[Outer]{open}\n${filler(10, 'Outer text')}\n\n:::details[Inner]{open}\n${filler(80, 'Inner text')}\n:::\n\n${filler(40, 'More outer')}\n::::\n\n${filler(40, 'After')}\n`

test('an open details keeps its summary at the top, and a nested one stacks below it', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { d: PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  await page.goto(proj.url('d'))
  const nav = await page.$eval('.wb-nav', el => el.getBoundingClientRect().height)
  const outer = 'details > summary >> text=Outer',
    inner = 'details details > summary >> text=Inner'
  const outerHeight = await page.locator(outer).evaluate(el => el.closest('summary')!.getBoundingClientRect().height)

  // in the middle of the inner details: both summaries stick, stacked under the header
  await page.locator('text=Inner text 40.').scrollIntoViewIfNeeded()
  await page.evaluate(() => scrollBy(0, 200))
  await page.waitForTimeout(100)
  assert.ok(
    Math.abs((await page.locator(outer).evaluate(el => el.closest('summary')!.getBoundingClientRect().top)) - nav) <
      1.5,
    'the outer one under the header',
  )
  assert.ok(
    Math.abs(
      (await page.locator(inner).evaluate(el => el.closest('summary')!.getBoundingClientRect().top)) -
        (nav + outerHeight),
    ) < 1.5,
    'the inner one under the outer',
  )

  // past the inner details, in the outer one: only the outer one sticks
  await page.locator('text=More outer 30.').scrollIntoViewIfNeeded()
  await page.waitForTimeout(100)
  assert.ok(
    Math.abs((await page.locator(outer).evaluate(el => el.closest('summary')!.getBoundingClientRect().top)) - nav) <
      1.5,
  )
  assert.ok(
    (await page.locator(inner).evaluate(el => el.closest('summary')!.getBoundingClientRect().bottom)) <
      nav + outerHeight + 1,
    'the inner one went up with its details',
  )

  // closing the outer details by its stuck title: the page goes back to the title
  await page.locator('text=Inner text 40.').scrollIntoViewIfNeeded()
  await page.locator(outer).click()
  await page.waitForTimeout(200)
  const summaryTop = await page.locator(outer).evaluate(el => el.closest('summary')!.getBoundingClientRect().top)
  assert.ok(await page.locator(outer).evaluate(el => !el.closest('details')!.open), 'closed')
  assert.ok(Math.abs(summaryTop - nav) < 1.5, `the title is where it was stuck (${summaryTop} vs ${nav})`)
  assert.deepEqual(errors, [])
})
