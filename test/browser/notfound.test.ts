// A page that isn't there yet: a styled page saying so, which becomes the page once it is written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project } from './project.ts'

test('not found: styled, and it becomes the page once the page is there', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { home: '# Home\n' } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  await page.goto(proj.url('later'))
  assert.equal(await page.textContent('h1'), 'Not found')
  assert.ok(await page.locator('.wb-nav').isVisible(), "with the page's header")
  proj.page('later', '# Here now\n\nIt was written after the tab opened.\n')
  await page.waitForSelector('text=It was written after the tab opened.')
  assert.equal(await page.textContent('h1'), 'Here now')
  // a 404 in the console is the browser's, for the page itself; anything else is a fault
  assert.deepEqual(
    errors.filter(e => !/404/.test(e)),
    [],
  )
})
