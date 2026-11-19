// Steps: one item at a time in a window, ‹ › and tabs and ← → between them; the pane keeps its
// height; the item showing stays when the page updates, and flipping is not a change to the page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

const PAGE = (extra = '') => `# Steps

:::steps[A or B]
### A
Short.

### B
Much longer.

With a second paragraph.

And a third.
:::

:::steps[Five steps]
### One
1
### Two
2
### Three
3
### Four
4
### Five
5
:::
${extra}`

test(
  'steps: tabs or a count; buttons, tabs and arrows; the same height; kept across an update, not new',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { s: PAGE() } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.goto(proj.url('s'))
    const [ab, five] = [page.locator('.wb-steps-window').nth(0), page.locator('.wb-steps-window').nth(1)]
    await ab.waitFor()
    const showing = (win: typeof ab) =>
      win.evaluate(w =>
        [...w.querySelectorAll<HTMLElement>('.wb-steps-item')]
          .filter(i => getComputedStyle(i).visibility === 'visible')
          .map(i => i.textContent!.trim().split('\n')[0].replace(/\s+/g, ' ')),
      )

    // two titled items: tabs; five: a count
    assert.deepEqual(
      await ab
        .locator('.wb-steps-tab')
        .allTextContents()
        .then(x => x.map(s => s.trim())),
      ['A', 'B'],
    )
    assert.equal(await five.locator('.wb-steps-tab').count(), 0)
    assert.equal((await five.locator('.wb-steps-count').innerText()).trim(), '1 / 5')
    assert.deepEqual(await showing(ab), ['Short.'])

    // the pane is as tall as its tallest item, whichever shows
    const tall = (await ab.locator('.wb-steps').boundingBox())!.height
    await ab.locator('.wb-steps-tab', { hasText: 'B' }).click()
    assert.deepEqual(await showing(ab), ['Much longer.'])
    assert.equal((await ab.locator('.wb-steps').boundingBox())!.height, tall)

    // the buttons, the edges, and the arrows once it has the focus
    await five.locator('[data-steps=next]').click()
    await five.locator('[data-steps=next]').click()
    assert.equal((await five.locator('.wb-steps-count').innerText()).trim(), '3 / 5')
    await five.locator('.wb-steps').click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await showing(five), ['Five 5'], 'stops at the last, with its title')
    assert.equal(await five.getAttribute('data-wb-last'), '')
    await page.keyboard.press('ArrowLeft')
    assert.deepEqual(await showing(five), ['Four 4'])

    // the agent edits the page: each keeps its item, and neither is new
    proj.page('s', PAGE('\nA new paragraph.\n'))
    await page.waitForSelector('text=A new paragraph.')
    assert.deepEqual(await showing(ab), ['Much longer.'])
    assert.deepEqual(await showing(five), ['Four 4'])
    assert.equal(await page.locator('.wb-steps-window.wb-new, .wb-new .wb-steps-window').count(), 0)

    // a step added before it: the same step still shows (by its key), not the same place
    proj.page('s', PAGE('\nA new paragraph.\n').replace('### One\n1', '### Zero\n0\n### One\n1'))
    await page.waitForSelector('text=Zero', { state: 'attached' })
    assert.equal((await five.locator('.wb-steps-count').innerText()).trim(), '5 / 6')
    assert.deepEqual(await showing(five), ['Four 4'])
    assert.deepEqual(errors, [])
  },
)
