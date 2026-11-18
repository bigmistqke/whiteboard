// Windows: :::window around any markdown, and any block written with `window` (the window plugin
// wraps it): a header that opens what it shows on its own and fills the browser window. Without
// `window`, an image or a video is just itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('latin1')

test(
  'windows: around any block that says window, its label or window="…" the title, its own file to open; fill and back',
  { timeout: 60000 },
  async t => {
    const page_ = [
      '# Windows',
      ':::window[A screenshot]\n![the screen](shot.png)\n:::',
      ':::window[A table]\n| a | b |\n| - | - |\n| 1 | 2 |\n:::',
      '::image[The image]{src="shot.png" window}',
      '::video[The video]{src="clip.mp4" loop muted window}',
      '::image{src="shot.png"}',
      '```mermaid {window}\ngraph LR\n  a --> b\n```',
      ':::grid{cols=2 window="Two cards"}\n### One\n1\n### Two\n2\n:::',
      '::image{src="javascript:alert(1)" window}',
      '',
    ].join('\n\n')
    const proj = await project({ pages: { w: page_ } })
    const fs = await import('node:fs')
    fs.writeFileSync(`${proj.dir}/.whiteboard/pages/shot.png`, PNG, 'latin1')
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.goto(proj.url('w'))
    const windows = page.locator('#wb-main .wb-window')
    await windows.first().waitFor()
    const info = await windows.evaluateAll(ws =>
      ws.map(w => ({
        title: w.querySelector('.wb-window-title')?.textContent ?? null,
        open: w.querySelector('a.wb-window-button')?.getAttribute('href') ?? null,
        bar: !!w.querySelector('.wb-window-bar'),
        media: w.querySelector('img, video')?.tagName ?? null,
      })),
    )
    assert.deepEqual(info, [
      { title: 'A screenshot', open: '/shot.png', bar: true, media: 'IMG' }, // resolved, as markdown's images are
      { title: 'A table', open: null, bar: true, media: null },
      { title: 'The image', open: 'shot.png', bar: true, media: 'IMG' },
      { title: 'The video', open: 'clip.mp4', bar: true, media: 'VIDEO' },
      { title: null, open: null, bar: true, media: null }, // a diagram: no label, nothing to open
      { title: 'Two cards', open: null, bar: true, media: null },
    ])
    assert.equal((await page.locator('.wb-window .wb-mermaid, .wb-window svg').count()) > 0, true, 'the diagram inside')
    assert.equal(await page.locator('.wb-window .wb-grid').count(), 1, 'the grid inside')
    assert.equal(await page.locator('#wb-main > img[src="shot.png"]').count(), 1, 'without window: the picture alone')
    assert.match(
      (await page.textContent('pre.wb-error'))!,
      /image: src must be an http\(s\) URL or a path, not javascript:/,
    )
    assert.ok(await page.$eval('video', v => v.loop && v.muted && v.controls))

    // fill the window with the table, and back with Esc
    const viewport = page.viewportSize()!
    await windows.nth(1).locator('[data-wb-maximize]').click()
    const r = (await windows.nth(1).boundingBox())!
    assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, viewport.width, viewport.height])
    await page.keyboard.press('Escape')
    assert.ok((await windows.nth(1).boundingBox())!.height < 300)
    assert.deepEqual(
      errors.filter(e => !/clip\.mp4|404/.test(e)),
      [],
    )
  },
)
