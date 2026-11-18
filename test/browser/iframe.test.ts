// The iframe block in the browser: its header, filling the window and back, across a page update.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const PAGE = (extra = '') => `# Frames

::iframe[The demo]{src="demo.html" height=240}

::iframe{src="demo.html" bare}

::iframe{src="demo.html?unlabelled"}
${extra}`

test(
  'iframe: a header with its label and address; it fills the window, stays so across an update, and Esc puts it back',
  { timeout: 60000 },
  async t => {
    const proj = await project({
      pages: { f: PAGE() },
      files: { '.whiteboard/pages/demo.html': '<!doctype html><p id="inside">inside</p>' },
    })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })

    await page.goto(proj.url('f'))
    const fig = page.locator('div.wb-window').first()
    await fig.waitFor()
    assert.equal(await fig.locator('.wb-window-title').textContent(), 'The demo')
    assert.equal(await fig.locator('.wb-window-address').count(), 0, 'with a label, no address')
    assert.equal(await fig.locator('.wb-window-name').getAttribute('title'), 'demo.html', 'the address on hover')
    assert.equal(await page.locator('div.wb-window').nth(1).locator('.wb-window-bar').count(), 0, 'bare: no header')
    assert.equal(
      await page.locator('div.wb-window').nth(2).locator('.wb-window-name').textContent(),
      'demo.html?unlabelled',
      'without a label, the address',
    )
    await until(
      'the file loads in the frame',
      async () =>
        (await page.frameLocator('div.wb-window >> nth=0 >> iframe').locator('#inside').count()) === 1 || null,
    )

    const viewport = page.viewportSize()!
    const box = async () => (await fig.boundingBox())!
    await fig.locator('[data-wb-maximize]').click()
    let r = await box()
    assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, viewport.width, viewport.height], 'fills the window')

    // the agent edits the page: the block is written again, and stays maximized
    proj.page('f', PAGE('\nA new paragraph.\n'))
    await page.waitForSelector('text=A new paragraph.')
    r = await box()
    assert.equal(r.height, viewport.height, 'still filling the window after an update')

    await page.keyboard.press('Escape')
    r = await box()
    assert.ok(r.height < 300, 'back in the page')
    await fig.locator('[data-wb-maximize]').click()
    await fig.locator('[data-wb-maximize]').click()
    assert.ok((await box()).height < 300, 'the button puts it back too')
    assert.deepEqual(errors, [])
  },
)
