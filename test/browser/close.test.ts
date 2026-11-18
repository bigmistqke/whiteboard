// `whiteboard close`: a page that did its job goes, with its events; nothing else does, and a watch
// running across it hands nothing out twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { browser, project, until } from './project.ts'

const FORM = (name: string) => `:::form{name=${name}}\n:text[Why]{name=why}\n:::\n`

test('close: the page and its events go, other pages keep theirs, the tab says so, a watch goes on', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { temp: `# Temporary\n\n${FORM('quick')}`, stays: `# Stays\n\n${FORM('lasting')}` } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  const watch = proj.spawn('watch')
  for (const [p, q] of [['stays', 'lasting'], ['temp', 'quick']] as const) {
    await page.goto(proj.url(p))
    await page.fill(`form[name=${q}] input[name=why]`, `an answer on ${p}`)
    await page.click(`form[name=${q}] button`)
    await page.waitForSelector(`form[name=${q}][data-wb-state=sent]`)
  }
  proj.cli('append', '--page', 'temp', '--type', 'chat:message', '--data', JSON.stringify({ chat: 'quick', text: 'noted' }))
  await until('the watch had both answers', () => (watch.output().match(/\n/g) ?? []).length === 2 || null)
  // the open tab reads the agent's message: that, too, is an event of the page, before it closes
  await until('the message was read', () => proj.events().some(e => e.page === 'temp' && e.type === 'whiteboard:read') || null)
  assert.ok(proj.events().some(e => e.page === 'temp'))

  const out = proj.cli('close', 'temp')
  assert.match(out, /closed temp: removed its file, and \d+ events from the log/)
  assert.ok(!fs.existsSync(`${proj.dir}/.whiteboard/pages/temp.md`), 'the file is gone')
  assert.deepEqual(proj.events().filter(e => e.page === 'temp'), [], 'its events are gone')
  assert.ok(proj.events().some(e => e.page === 'stays' && e.type === 'lasting'), 'the other page keeps its answer')
  await page.waitForSelector('h1:text("Not found")')

  // the watch goes on after the rewrite: a new answer comes once, nothing old comes again
  await page.goto(proj.url('stays'))
  await page.click('form[name=lasting][data-wb-folded]', { position: { x: 20, y: 12 } }).catch(() => {})
  await page.fill('form[name=lasting] input[name=why]', 'a second answer')
  await page.click('form[name=lasting] button')
  await until('the watch had the new one', () => watch.output().includes('a second answer') || null)
  await new Promise(r => setTimeout(r, 400))
  const lines = watch.output().trim().split('\n').map(l => JSON.parse(l).data.why)
  assert.deepEqual(lines, ['an answer on stays', 'an answer on temp', 'a second answer'])
  assert.match((() => { try { proj.cli('close', 'temp'); return '' } catch (err) { return String((err as { stderr?: string }).stderr) } })(), /there is no page temp/)
  watch.kill()
  assert.deepEqual(errors.filter(e => !/404/.test(e)), [])
})
