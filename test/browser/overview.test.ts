// The overview's documents: when each was last updated, and sorting them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { browser, project } from './project.ts'

test('overview: documents show when they were updated, and sort by folder, last updated or title; the choice stays', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { p: '# A page\n' }, files: { 'b.md': '# Beta\n', 'a.md': '# Zulu\n', 'docs/c.md': '# Alpha\n', 'docs/notes/README.md': 'No heading here.\n' } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  // c newest, then b, then a
  const at = (file: string, minutesAgo: number) => { const when = new Date(Date.now() - minutesAgo * 60000); fs.utimesSync(path.join(proj.dir, file), when, when) }
  at('docs/notes/README.md', 40); at('a.md', 30); at('b.md', 20); at('docs/c.md', 10)

  await page.goto(proj.url(''))
  const titles = () => page.$$eval('.wb-documents li > a', as => as.map(a => a.textContent))
  assert.deepEqual(await titles(), ['Zulu', 'Beta', 'Alpha', 'README.md'], 'by folder: the top folder first, then by path')
  assert.match((await page.textContent('.wb-documents li'))!, /edited \d+m ago/)
  // without a heading: its file's name, and the folder it is in under it
  assert.equal(await page.textContent('.wb-documents li:last-child code'), 'docs/notes/')

  await page.selectOption('select[data-wb-sort=documents]', 'updated')
  assert.deepEqual(await titles(), ['Alpha', 'Beta', 'Zulu', 'README.md'], 'last updated first')
  await page.selectOption('select[data-wb-sort=documents]', 'title')
  assert.deepEqual(await titles(), ['Alpha', 'Beta', 'README.md', 'Zulu'], 'by title')
  await page.selectOption('select[data-wb-sort=documents]', 'updated')

  // kept across a reload, and across a live update of the overview
  await page.reload()
  assert.equal(await page.inputValue('select[data-wb-sort=documents]'), 'updated')
  assert.deepEqual(await titles(), ['Alpha', 'Beta', 'Zulu', 'README.md'])
  proj.page('p2', '# Another page\n')
  await page.waitForSelector('text=Another page')
  assert.deepEqual(await titles(), ['Alpha', 'Beta', 'Zulu', 'README.md'], 'still sorted after an update')
  assert.equal(await page.inputValue('select[data-wb-sort=documents]'), 'updated')
  assert.deepEqual(errors, [])
})
