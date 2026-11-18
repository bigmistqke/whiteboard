// The theme: every colour a light-dark() pair, following the system unless pinned; a project
// overrides a colour for both with one line in its stylesheet.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { project } from './project.ts'

const CONFIG = `export default { style: new URL('./site.css', import.meta.url) }\n`

test('theme: a project sets a colour for light and dark at once; the system decides, unless the page pins it', { timeout: 60000 }, async t => {
  const proj = await project({ config: CONFIG, pages: { p: '# Themed\n' }, files: { '.whiteboard/site.css': ':root { --accent: light-dark(#c2410c, #fb923c); }\n' } })
  const b = await chromium.launch()
  t.after(async () => { await b.close(); await proj.close() })
  const accent = async (scheme: 'light' | 'dark', pinned?: 'light' | 'dark') => {
    const page = await b.newPage({ colorScheme: scheme })
    await page.goto(proj.url('p'))
    if (pinned) await page.evaluate(t => { document.documentElement.dataset.theme = t }, pinned)
    const c = await page.evaluate(() => { const d = document.createElement('div'); d.style.color = 'var(--accent)'; document.body.append(d); return getComputedStyle(d).color })
    await page.close()
    return c
  }
  assert.equal(await accent('light'), 'rgb(194, 65, 12)')
  assert.equal(await accent('dark'), 'rgb(251, 146, 60)')
  assert.equal(await accent('light', 'dark'), 'rgb(251, 146, 60)', 'pinned dark on a light system')
  assert.equal(await accent('dark', 'light'), 'rgb(194, 65, 12)', 'pinned light on a dark system')
})
