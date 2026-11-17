// The terminal drawer in the browser: starting the command, the shell taking over, tabs, a reload,
// a tab from the command line, closing one, and a tab whose shell exits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { browser, project, until } from './project.ts'

const CONFIG = `import { defineConfig } from '@bigmistqke/whiteboard/config'
import terminal from '@bigmistqke/whiteboard/terminal'
export default defineConfig({ plugins: [terminal({ command: './prog.sh' })] })
`

const hasPty = (() => { try { createRequire(import.meta.url).resolve('node-pty'); return true } catch { return false } })()

test('terminal: command, shell, tabs, reload, close, exit', { timeout: 90000, skip: !hasPty && 'node-pty is not installed' }, async t => {
  const proj = await project({
    config: CONFIG,
    pages: { q: '# Test\n\nHello.\n' },
    files: { 'prog.sh': '#!/bin/sh\necho PROG-RAN\nexit 3\n' },
  })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })

  const text = () => page.evaluate(() => (document.querySelector('#wb-terminal .xterm-rows') as HTMLElement | null)?.innerText ?? '')
  const tabs = () => page.$$eval('#wb-terminal .wb-term-tab', t => t.map(x =>
    (x.classList.contains('wb-current') ? '*' : '') + x.querySelector('.wb-term-tab-name')?.textContent + (x.hasAttribute('data-exited') ? '(x)' : '')))
  const shows = (s: string) => until(`the terminal shows ${s}`, async () => (await text()).includes(s), 8000)

  // the link gives this browser the project's token and opens the drawer
  await page.goto(proj.cli('terminal', 'q').trim())
  await page.waitForSelector('#wb-terminal', { state: 'visible' })
  await until('no session yet', async () => (await page.textContent('.wb-term-actions'))!.includes('Start prog.sh'))

  await page.click('.wb-term-actions button')
  await shows('PROG-RAN')
  // the program exited, and the shell took over in the same tab
  await until('one tab, still running', async () => JSON.stringify(await tabs()) === '["*prog.sh"]')
  await page.keyboard.type('echo $((6*7))\n')
  await shows('42')

  await page.click('.wb-term-add')
  await until('a second tab', async () => (await tabs()).length === 2)
  await page.waitForTimeout(500)
  await page.keyboard.type('echo SECOND-TAB\n')
  await shows('SECOND-TAB')
  assert.ok(!(await text()).includes('PROG-RAN'), 'the second tab is its own terminal')

  await page.click('.wb-term-tab[data-id="1"] .wb-term-tab-name')
  await until('back on tab 1', async () => (await text()).includes('42') && !(await text()).includes('SECOND-TAB'))

  await page.reload()
  await until('after a reload: both tabs, the current one shown', async () =>
    (await tabs()).length === 2 && (await text()).includes('42'))

  // a tab started from the command line shows up by itself
  proj.cli('terminal', '--new', '--shell')
  await until('the tab from the command line', async () => (await tabs()).length === 3)

  await page.click('.wb-term-tab[data-id="2"] .wb-term-tab-close')
  await until('the tab is closed', async () => (await tabs()).length === 2 && !(await page.$('.wb-term-tab[data-id="2"]')))

  // leaving the shell ends the tab, which then offers to start again
  await page.click('.wb-term-tab[data-id="1"] .wb-term-tab-name')
  await page.waitForTimeout(500)
  await page.keyboard.type('exit\n')
  await until('the tab ended: Start again', async () =>
    (await tabs()).some(x => x.includes('prog.sh(x)')) && (await page.textContent('.wb-term-actions'))!.includes('Start again'), 8000)

  assert.deepEqual(errors, [], 'no console errors')
})
