// What a page misses while its live channel is down (a server restarting, a background tab whose
// browser holds its timers) it catches up on when the channel is back: a scroll sent meanwhile, new
// browser code (it reloads), new stylesheets (refreshed in place). The channel is cut here by
// routing the page's WebSocket, with the server up all along.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocketRoute } from 'playwright'
import { browser, project, until } from './project.ts'

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = `# Reconnect\n\n${filler(80, 'Top')}\n\n## The far heading\n\n${filler(80, 'Below')}\n`
// a plugin of the project's own, its browser files in .whiteboard/public/
const CONFIG = `export default { plugins: [{ name: 'probe', style: 'probe.css', setup: () => ({ client: 'probe.js' }) }] }\n`
const CLIENT = `export default () => { document.documentElement.dataset.probe = 'one' }\n`
const STYLE = `h1 { letter-spacing: 1px }\n`

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const proj = await project({
    config: CONFIG,
    pages: { r: PAGE },
    files: { '.whiteboard/public/probe.js': CLIENT, '.whiteboard/public/probe.css': STYLE },
  })
  const { browser: b, page } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  // the live channel, cut and restored at will
  let open = true
  let current: WebSocketRoute | null = null
  await page.routeWebSocket(/\/api\/live/, ws => {
    if (!open) return void ws.close()
    current = ws
    ws.connectToServer()
  })
  await page.goto(proj.url('r'))
  const live = () => page.evaluate(() => 'wbLive' in document.documentElement.dataset)
  await until('live', async () => (await live()) || null)
  return {
    proj,
    page,
    live,
    async cut() {
      open = false
      await current?.close()
      await until('cut off', async () => !(await live()) || null)
    },
    async restore() {
      open = true
      await until('live again', async () => (await live()) || null, 15000)
    },
  }
}

test('a scroll sent while the page was cut off happens once it is back', { timeout: 60000 }, async t => {
  const { proj, page, cut, restore } = await setup(t)
  const atTop = () => page.evaluate(() => scrollY < 50)
  assert.ok(await atTop())
  await cut()
  // nobody hears it now: the command says so, and the page has it when it is back
  const r = proj.run(['scroll', 'r', 'the far heading'])
  assert.match(r.stderr, /no tab of r is connected now/)
  await new Promise(r => setTimeout(r, 300))
  assert.ok(await atTop(), 'not while cut off')
  await restore()
  await until('scrolled there', async () => !(await atTop()) || null)
  // a page loaded later does not jump to a scroll from before it
  // (loaded afresh: a reload would put it back where it was itself)
  await page.goto('about:blank')
  await page.goto(proj.url('r'))
  await page.waitForSelector('h2')
  await new Promise(r => setTimeout(r, 500))
  assert.ok(await atTop(), 'a fresh page stays at the top')
})

test('browser code that changed while the page was cut off reloads it once it is back', { timeout: 60000 }, async t => {
  const { proj, page, cut, restore } = await setup(t)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.probe), 'one')
  await page.evaluate(() => ((window as unknown as { marker: boolean }).marker = true))
  await cut()
  fs.writeFileSync(path.join(proj.dir, '.whiteboard/public/probe.js'), CLIENT.replace("'one'", "'two'"))
  await new Promise(r => setTimeout(r, 300))
  await restore().catch(() => {})
  await until(
    'reloaded, with the new code',
    async () => (await page.evaluate(() => document.documentElement.dataset.probe).catch(() => null)) === 'two' || null,
    15000,
  )
  assert.equal(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker), undefined)
})

test(
  'a stylesheet that changed while the page was cut off is refreshed, without a reload',
  { timeout: 60000 },
  async t => {
    const { proj, page, cut, restore } = await setup(t)
    await page.evaluate(() => ((window as unknown as { marker: boolean }).marker = true))
    const spacing = () => page.evaluate(() => getComputedStyle(document.querySelector('h1')!).letterSpacing)
    assert.equal(await spacing(), '1px')
    await cut()
    fs.writeFileSync(path.join(proj.dir, '.whiteboard/public/probe.css'), STYLE.replace('1px', '3px'))
    await new Promise(r => setTimeout(r, 300))
    await restore()
    await until('the new style', async () => (await spacing()) === '3px' || null, 10000)
    assert.equal(await page.evaluate(() => (window as unknown as { marker?: boolean }).marker), true, 'not reloaded')
  },
)
