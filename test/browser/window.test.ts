// Windows: :::window around any markdown, ::image and ::video, each with a header that opens it on
// its own and fills the browser window; bare leaves the header out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('latin1')

test('windows: a label, open on its own for one file, fill the window and back; bare has no header', { timeout: 60000 }, async t => {
  const page_ = `# Windows\n\n:::window[A screenshot]\n![the screen](shot.png)\n:::\n\n:::window[A table]\n| a | b |\n| - | - |\n| 1 | 2 |\n:::\n\n::image[The image]{src="shot.png"}\n\n::video[The video]{src="clip.mp4" loop muted}\n\n::image{src="shot.png" bare}\n\n::image{src="javascript:alert(1)"}\n`
  const proj = await project({ pages: { w: page_ } })
  const fs = await import('node:fs')
  fs.writeFileSync(`${proj.dir}/.whiteboard/pages/shot.png`, PNG, 'latin1')
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('w'))
  const windows = page.locator('#wb-main .wb-window')
  await windows.first().waitFor()
  const info = await windows.evaluateAll(ws => ws.map(w => ({
    title: w.querySelector('.wb-window-title')?.textContent ?? null,
    open: w.querySelector('a.wb-window-button')?.getAttribute('href') ?? null,
    bar: !!w.querySelector('.wb-window-bar'),
    media: w.querySelector('img, video')?.tagName ?? null,
  })))
  assert.deepEqual(info, [
    { title: 'A screenshot', open: '/shot.png', bar: true, media: 'IMG' },   // resolved, as markdown's images are
    { title: 'A table', open: null, bar: true, media: null },
    { title: 'The image', open: 'shot.png', bar: true, media: 'IMG' },
    { title: 'The video', open: 'clip.mp4', bar: true, media: 'VIDEO' },
    { title: null, open: null, bar: false, media: 'IMG' },
  ])
  assert.match((await page.textContent('pre.wb-error'))!, /image: src must be an http\(s\) URL or a path, not javascript:/)
  assert.ok(await page.$eval('video', v => v.loop && v.muted && v.controls))

  // fill the window with the table, and back with Esc
  const viewport = page.viewportSize()!
  await windows.nth(1).locator('[data-wb-maximize]').click()
  const r = (await windows.nth(1).boundingBox())!
  assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, viewport.width, viewport.height])
  await page.keyboard.press('Escape')
  assert.ok((await windows.nth(1).boundingBox())!.height < 300)
  assert.deepEqual(errors.filter(e => !/clip\.mp4|404/.test(e)), [])
})
