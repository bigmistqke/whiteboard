// The lightbox: composed around a container, its pictures open large on a click and step through
// the container's pictures and videos; outside one, a picture does nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('latin1')

const PAGE = [
  '# Pictures',
  ':::grid{cols=3 compose=lightbox}',
  '### One\n::image[The first]{src="a.png"}',
  '### Two\n![the second](b.png)',
  '### Three\n::video[A clip]{src="clip.mp4"}',
  ':::',
  '::image[Outside]{src="a.png"}',
  '',
].join('\n\n')

test(
  'lightbox: a picture in the container opens; ← → through its pictures and the video; Esc; none outside',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { l: PAGE } })
    const fs = await import('node:fs')
    for (const f of ['a.png', 'b.png']) fs.writeFileSync(`${proj.dir}/.whiteboard/pages/${f}`, PNG, 'latin1')
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.goto(proj.url('l'))
    await page.waitForSelector('[data-lightbox]')
    assert.equal(
      await page.locator('#wb-main > .wb-grid[data-lightbox], #wb-main > [data-lightbox] .wb-grid').count(),
      1,
      'the grid itself, marked',
    )

    const shown = () =>
      page.evaluate(() => {
        const box = document.querySelector('.wb-lightbox')
        if (!box) return null
        const m = box.querySelector('.wb-lightbox-stage > *')!
        return [m.tagName, box.querySelector('.wb-lightbox-caption')!.textContent]
      })
    await page.locator('[data-lightbox] img').first().click()
    assert.deepEqual(await shown(), ['IMG', 'The first'])
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await shown(), ['IMG', 'the second'], 'a plain markdown picture too')
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await shown(), ['VIDEO', 'A clip'], 'the video, in the stepping')
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await shown(), ['IMG', 'The first'], 'round again')
    await page.keyboard.press('Escape')
    assert.equal(await shown(), null)

    // outside a lightbox, a picture is a picture
    await page.locator('#wb-main > img').last().click()
    assert.equal(await shown(), null)
    assert.deepEqual(
      errors.filter(e => !/clip\.mp4|404/.test(e)),
      [],
    )
  },
)
