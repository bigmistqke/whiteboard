// Slots: places on the page the core owns. A plugin renders markup into its own element in a slot
// on the server (`slots`), and its browser module mounts on that element (`api.slot`), whether the
// server filled it or not; it never makes or looks up the element.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

// a plugin of the project's own, its browser module in .whiteboard/public/
const CONFIG = `export default { plugins: [{ name: 'probe', setup: () => ({
  client: 'probe.js',
  slots: () => ({ bottom: '<p id="drawer">from the server</p>' }),
}) }] }\n`
const CLIENT = `export default (root, page, api) => {
  // a button in the header bar, made here
  api.slot('header', el => {
    el.innerHTML = '<button id="probe-button">probe</button>'
  })
  // the server's markup, handed over
  const off = api.slot('bottom', el => {
    el.dataset.got = el.querySelector('#drawer') ? 'the server markup' : 'nothing'
    return () => (window.unmounted = true)
  })
  window.takeAway = off
}\n`

test(
  "a plugin's slots: the server's markup handed to its mount, a button in the header bar, taken away again",
  { timeout: 60000 },
  async t => {
    const proj = await project({
      config: CONFIG,
      pages: { p: '# Slots\n\nText.\n' },
      files: { '.whiteboard/public/probe.js': CLIENT },
    })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await page.goto(proj.url('p'))
    await until('the button', () =>
      page
        .locator('#probe-button')
        .count()
        .then(n => n > 0 || null),
    )
    // the header bar, in order: what waits elsewhere (if anything), the plugins' place, the theme
    const order = await page.$$eval('.wb-nav > *', els =>
      els.map(e => (e.matches('[data-wb-slot]') ? `slot:${e.textContent}` : e.className || e.tagName.toLowerCase())),
    )
    const at = order.indexOf('slot:probe')
    assert.ok(at > order.indexOf('wb-elsewhere') && at < order.indexOf('wb-theme'), order.join(', '))
    const bottom = page.locator('body > [data-wb-slot=bottom] > [data-plugin=probe]')
    assert.equal(await bottom.getAttribute('data-got'), 'the server markup')
    assert.equal(await page.locator('#drawer').textContent(), 'from the server')
    // taken away: its unmount runs, its element goes
    await page.evaluate(() => (window as unknown as { takeAway(): void }).takeAway())
    assert.equal(await page.evaluate(() => (window as unknown as { unmounted?: boolean }).unmounted), true)
    assert.equal(await bottom.count(), 0)
    assert.deepEqual(errors, [])
  },
)
