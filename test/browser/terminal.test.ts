// The terminal drawer in the browser: a program run in a tab, the shell taking over, tabs, a
// reload, a tab from the command line, closing one, and a tab whose shell exits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { browser, project, until } from './project.ts'

const CONFIG = `import { defineConfig } from '@bigmistqke/whiteboard'
import terminal from '@bigmistqke/whiteboard/terminal'
export default defineConfig({ plugins: [terminal()] })
`

const hasPty = (() => {
  try {
    createRequire(import.meta.url).resolve('node-pty')
    return true
  } catch {
    return false
  }
})()

test(
  'terminal: a program, the shell, tabs, reload, close, exit',
  { timeout: 90000, skip: !hasPty && 'node-pty is not installed' },
  async t => {
    const proj = await project({
      config: CONFIG,
      pages: { q: '# Test\n\nHello.\n' },
      files: { 'prog.sh': '#!/bin/sh\necho PROG-RAN\nexit 3\n' },
    })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })

    const text = () =>
      page.evaluate(() => (document.querySelector('#wb-terminal .xterm-rows') as HTMLElement | null)?.innerText ?? '')
    const tabs = () =>
      page.$$eval('#wb-terminal .wb-term-tab', t =>
        t.map(
          x =>
            (x.classList.contains('wb-current') ? '*' : '') +
            x.querySelector('.wb-term-tab-name')?.textContent +
            (x.hasAttribute('data-exited') ? '(x)' : ''),
        ),
      )
    const shows = (s: string) => until(`the terminal shows ${s}`, async () => (await text()).includes(s), 8000)

    // the link gives this browser the project's token and opens the drawer
    await page.goto(proj.cli('terminal', 'q').trim())
    await page.waitForSelector('#wb-terminal', { state: 'visible' })
    // no tab yet: nothing to start but "+", at the bar's right end, after the tabs
    await page.waitForSelector('#wb-terminal .wb-term-add')
    assert.equal(await page.textContent('.wb-term-actions'), '')
    assert.deepEqual(await page.$$eval('.wb-term-bar > *', els => els.map(e => e.className).slice(-2)), [
      'wb-term-tabs',
      'wb-term-add',
    ])
    const bar = await page.$eval('.wb-term-bar', e => e.getBoundingClientRect().right)
    const plus = await page.$eval('.wb-term-add', e => e.getBoundingClientRect().right)
    assert.ok(bar - plus < 20, `"+" sits at the right end (${bar - plus}px from it)`)

    // a program run in a new tab from the command line
    proj.cli('terminal', '--', './prog.sh')
    await until('its tab', async () => (await tabs()).some(x => x.includes('prog.sh')))
    await page.click('.wb-term-tab[data-id="1"] .wb-term-tab-name')
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
    await until(
      'after a reload: both tabs, the current one shown',
      async () => (await tabs()).length === 2 && (await text()).includes('42'),
    )

    // a shell tab started from the command line shows up by itself
    proj.cli('terminal', '--new')
    await until('the tab from the command line', async () => (await tabs()).length === 3)

    await page.click('.wb-term-tab[data-id="2"] .wb-term-tab-close')
    await until(
      'the tab is closed',
      async () => (await tabs()).length === 2 && !(await page.$('.wb-term-tab[data-id="2"]')),
    )

    // leaving the shell ends the tab, which then offers to start again: it runs the program again
    await page.click('.wb-term-tab[data-id="1"] .wb-term-tab-name')
    await page.waitForTimeout(500)
    await page.keyboard.type('exit\n')
    await until(
      'the tab ended: Start again',
      async () =>
        (await tabs()).some(x => x.includes('prog.sh(x)')) &&
        (await page.textContent('.wb-term-actions'))!.includes('Start again'),
      8000,
    )
    await page.click('.wb-term-actions button')
    await until(
      'started again as it was',
      async () => JSON.stringify(await tabs()).includes('*prog.sh"') && (await text()).includes('PROG-RAN'),
      8000,
    )

    assert.deepEqual(errors, [], 'no console errors')
  },
)

test(
  'terminal: two windows of different widths, the one in use decides the size',
  { timeout: 90000, skip: !hasPty && 'node-pty is not installed' },
  async t => {
    const proj = await project({ config: CONFIG, pages: { q: '# Test\n' } })
    const { browser: b, page: narrow, errors, newPage } = await browser()
    const wide = await newPage()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    await narrow.setViewportSize({ width: 700, height: 800 })
    await wide.setViewportSize({ width: 1400, height: 800 })

    // a shell in tab 1, then both windows open the drawer on it
    proj.cli('terminal', '--new')
    const link = proj.cli('terminal', 'q').trim()
    await narrow.goto(link)
    await wide.goto(link)
    for (const p of [narrow, wide]) await p.waitForSelector('#wb-terminal .xterm-screen')
    // how wide the terminal is drawn, and how wide the space for it is
    const widths = (p: typeof narrow) =>
      p.evaluate(() => ({
        term: Math.round(document.querySelector('#wb-terminal .xterm-screen')!.getBoundingClientRect().width),
        room: Math.round(document.querySelector('#wb-terminal .wb-term-screen')!.getBoundingClientRect().width),
      }))

    // the narrow window is used: the session takes its size, and the wide one shows it with a margin
    await narrow.click('#wb-terminal .xterm-screen')
    await narrow.keyboard.type('echo NARROW\n')
    await until(
      'the wide window follows the narrow one',
      async () => {
        const [n, w] = [await widths(narrow), await widths(wide)]
        return n.term === w.term && w.term < w.room - 100
      },
      8000,
    )

    // now the wide one is used: it takes the session, and the narrow one shows it cut off
    await wide.click('#wb-terminal .xterm-screen')
    await wide.keyboard.type('echo WIDE\n')
    await until(
      'the narrow window follows the wide one',
      async () => {
        const [n, w] = [await widths(narrow), await widths(wide)]
        return n.term === w.term && n.term > n.room
      },
      8000,
    )
    // both show the same session
    await until(
      'what was typed in one shows in the other',
      () =>
        narrow.evaluate(() =>
          (document.querySelector('#wb-terminal .xterm-rows') as HTMLElement).innerText.includes('WIDE'),
        ),
      8000,
    )

    assert.deepEqual(errors, [], 'no console errors')
  },
)

test(
  'terminal: a program in a tab opens a page where its drawer is',
  { timeout: 60000, skip: !hasPty && 'node-pty is not installed' },
  async t => {
    const proj = await project({ config: CONFIG, pages: { q: '# Q\n', other: '# Other page\n' } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    proj.cli('terminal', '--new')
    await page.goto(proj.cli('terminal', 'q').trim())
    await page.waitForSelector('#wb-terminal .xterm-screen')
    await page.click('#wb-terminal .xterm-screen')

    // what `whiteboard terminal open` does from inside tab 1 (its programs have WHITEBOARD_TERMINAL=1)
    const out = proj.cliWith({ WHITEBOARD_TERMINAL: '1' }, 'terminal', 'open', 'other')
    assert.match(out, /opened \/other/)
    await page.waitForURL(/\/other$/)
    await until('the page, with the drawer still there', () =>
      page.evaluate(
        () =>
          document.body.textContent!.includes('Other page') && !!document.querySelector('#wb-terminal .xterm-screen'),
      ),
    )

    // without knowing its tab (outside one, or with its environment filtered): the drawer used last
    assert.match(proj.cli('terminal', 'open', 'q'), /where the drawer you used last is/)
    await page.waitForURL(/\/q$/)
    assert.deepEqual(errors, [], 'no console errors')
  },
)
