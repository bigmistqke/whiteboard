// The toc plugin: the page's sections beside it, the one being read, a dot where something waits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const CONFIG = `import toc from '@bigmistqke/whiteboard/toc'\nexport default { plugins: [toc()] }\n`
const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = `# Long page\n\n## Start\n\n${filler(30, 'Start')}\n\n## Middle\n\n${filler(10, 'Middle')}\n\n### A part of it\n\n${filler(30, 'Part')}\n\n## The question\n\n:::form{name=q}\n:text[Why]{name=why}\n:::\n\n${filler(30, 'End')}\n`

test('toc: the sections, numbered; the one being read; a click goes there; a dot where a question waits; a button when narrow', { timeout: 60000 }, async t => {
  const proj = await project({ config: CONFIG, pages: { p: PAGE } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.setViewportSize({ width: 1400, height: 800 })
  await page.goto(proj.url('p'))
  const entries = () => page.$$eval('.wb-toc a', as => as.map(a => a.textContent))
  await until('the contents', async () => (await entries()).length === 4 || null)
  assert.deepEqual(await entries(), ['1Start', '2Middle', '2.1A part of it', '3The question'])
  assert.ok(await page.locator('.wb-toc').isVisible(), 'beside the text on a wide window')
  assert.ok(await page.locator('.wb-toc-toggle').isHidden())
  const current = () => page.$eval('.wb-toc a[aria-current]', a => a.textContent)
  assert.equal(await current(), '1Start')
  assert.deepEqual(await page.$$eval('.wb-toc a[data-waiting]', as => as.map(a => a.textContent)), ['3The question'], 'a dot where a question waits')

  await page.click('.wb-toc a >> text=A part of it')
  await until('there, and marked', async () => {
    const top = await page.$eval('h3', h => h.getBoundingClientRect().top)
    return (top > 0 && top < 120 && (await current()) === '2.1A part of it') || null
  })

  // narrow: a button in the header opens it
  await page.setViewportSize({ width: 700, height: 800 })
  await until('folded into a button', async () => (await page.locator('.wb-toc-toggle').isVisible() && await page.locator('.wb-toc').isHidden()) || null)
  await page.click('.wb-toc-toggle')
  assert.ok(await page.locator('.wb-toc').isVisible())
  await page.click('.wb-toc a >> text=The question')
  await until('there, and closed', async () => (await page.locator('.wb-toc').isHidden()) || null)
  assert.deepEqual(errors, [])
})
