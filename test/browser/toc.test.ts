// The toc plugin: the page's sections beside it, the one being read, a dot where something waits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const CONFIG = `import toc from '@bigmistqke/whiteboard/toc'\nexport default { plugins: [toc({ always: true })] }\n`
const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = `# Long page\n\n## Start\n\n${filler(30, 'Start')}\n\n## Middle\n\n${filler(10, 'Middle')}\n\n### A part of it\n\n${filler(30, 'Part')}\n\n## The question\n\n:::form{name=q}\n:text[Why]{name=why}\n:::\n\n${filler(30, 'End')}\n`

test(
  'toc: the sections, numbered; the one being read; a click goes there; a dot where a question waits; a button when narrow',
  { timeout: 60000 },
  async t => {
    const proj = await project({ config: CONFIG, pages: { p: PAGE } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 1400, height: 800 })
    await page.goto(proj.url('p'))
    const entries = () => page.$$eval('.wb-toc a', as => as.map(a => a.textContent))
    await until('the contents', async () => (await entries()).length === 4 || null)
    assert.deepEqual(await entries(), ['1Start', '2Middle', '2.1A part of it', '3The question'])
    assert.ok(await page.locator('.wb-toc').isVisible(), 'beside the text on a wide window')
    assert.ok(await page.locator('.wb-toc-toggle').isHidden())
    const current = () => page.$eval('.wb-toc a[aria-current]', a => a.textContent)
    assert.equal(await current(), '1Start')
    assert.deepEqual(
      await page.$$eval('.wb-toc a[data-waiting]', as => as.map(a => a.textContent)),
      ['3The question'],
      'a dot where a question waits',
    )

    await page.click('.wb-toc a >> text=A part of it')
    await until('there, and marked', async () => {
      const top = await page.$eval('h3', h => h.getBoundingClientRect().top)
      return (top > 0 && top < 120 && (await current()) === '2.1A part of it') || null
    })

    // narrow: a button in the header opens it
    await page.setViewportSize({ width: 700, height: 800 })
    await until(
      'folded into a button',
      async () =>
        ((await page.locator('.wb-toc-toggle').isVisible()) && (await page.locator('.wb-toc').isHidden())) || null,
    )
    await page.click('.wb-toc-toggle')
    assert.ok(await page.locator('.wb-toc').isVisible())
    await page.click('.wb-toc a >> text=The question')
    await until('there, and closed', async () => (await page.locator('.wb-toc').isHidden()) || null)
    assert.deepEqual(errors, [])
  },
)

test('toc: a page opts in through its frontmatter', { timeout: 60000 }, async t => {
  const OPT_IN = `import toc from '@bigmistqke/whiteboard/toc'\nexport default { plugins: [toc()] }\n`
  const BODY = `# Long page\n\n## One\n\n${filler(10, 'One')}\n\n## Two\n\n${filler(10, 'Two')}\n`
  const proj = await project({
    config: OPT_IN,
    pages: { plain: BODY, asks: `---\nplugins:\n  toc: true\n---\n${BODY}`, top: `---\ntoc: true\n---\n${BODY}` },
  })
  const { browser: b, page, errors } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  await page.setViewportSize({ width: 1400, height: 800 })
  const shown = async () =>
    (await page.locator('.wb-toc').isVisible()) || (await page.locator('.wb-toc-toggle').isVisible())

  await page.goto(proj.url('asks'))
  await until('contents where the page asks', async () => (await page.locator('.wb-toc a').count()) === 2 || null)
  assert.ok(await shown())
  await page.goto(proj.url('plain'))
  await page.waitForSelector('h2')
  await page.waitForTimeout(300)
  assert.ok(!(await shown()), 'none where it does not')
  await page.goto(proj.url('top'))
  await page.waitForSelector('h2')
  await page.waitForTimeout(300)
  assert.ok(!(await shown()), "a top-level toc: is not the plugin's: its settings are under plugins:")
  await page.goto(proj.url('plain'))
  await page.waitForSelector('h2')
  // the frontmatter changes while the page is open: it comes
  proj.page('plain', `---\nplugins:\n  toc: true\n---\n${BODY}`)
  await until('it came with the frontmatter', async () => (await shown()) || null)
  assert.deepEqual(errors, [])
})

test(
  'toc({ always: true }): on every page, a page says plugins: { toc: false } to go without',
  { timeout: 60000 },
  async t => {
    const proj = await project({ config: CONFIG, pages: { off: `---\nplugins:\n  toc: false\n---\n${PAGE}` } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 1400, height: 800 })
    await page.goto(proj.url('off'))
    await page.waitForSelector('h2')
    await page.waitForTimeout(300)
    assert.ok((await page.locator('.wb-toc').isHidden()) && (await page.locator('.wb-toc-toggle').isHidden()))
    assert.deepEqual(errors, [])
  },
)

test(
  'toc: the panel fits its items, between bounds the options set and a page overrides',
  { timeout: 60000 },
  async t => {
    const BOUNDED = `import toc from '@bigmistqke/whiteboard/toc'\nexport default { plugins: [toc({ maxWidth: 300 })] }\n`
    const short = `# Short\n\n## One\n\n${filler(5, 'One')}\n\n## Two\n\n${filler(5, 'Two')}\n`
    const long = `# Long\n\n## A heading that goes on for quite a while, longer than any panel would be\n\n${filler(5, 'One')}\n\n## Two\n\n${filler(5, 'Two')}\n`
    const proj = await project({
      config: BOUNDED,
      pages: {
        short: `---\nplugins:\n  toc: true\n---\n${short}`,
        long: `---\nplugins:\n  toc: true\n---\n${long}`,
        narrow: `---\nplugins:\n  toc:\n    maxWidth: 200px\n---\n${long}`,
        broken: `---\ntoc: [unclosed\n---\n${short}`,
      },
    })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.setViewportSize({ width: 1500, height: 800 })
    const panel = async (name: string) => {
      await page.goto(proj.url(name))
      await until(`contents on ${name}`, async () => (await page.locator('.wb-toc a').count()) === 2 || null)
      return page.evaluate(() => {
        const r = document.querySelector('.wb-toc')!.getBoundingClientRect()
        const text = document.querySelector('#wb-main')!.getBoundingClientRect().left
        return { width: Math.round(r.width), gap: Math.round(text - r.right) }
      })
    }
    assert.deepEqual(await panel('short'), { width: 160, gap: 40 }, 'short items: the minimum, 40px left of the text')
    assert.deepEqual(await panel('long'), { width: 300, gap: 40 }, "long ones: the project's maximum")
    assert.equal((await panel('narrow')).width, 200, "the page's own maximum, from YAML")

    // frontmatter that isn't YAML: said on the page, and read as none
    await page.goto(proj.url('broken'))
    await page.waitForSelector('h1')
    assert.match((await page.textContent('pre.wb-error'))!, /^frontmatter: /)
    assert.deepEqual(errors, [])
  },
)
