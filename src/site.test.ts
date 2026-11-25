// The served site on a project in a temporary folder: ids, files and addresses, without a server.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { project as projectAt } from './config.ts'
import { pageSource, parseFrontmatter, servedSite } from './site.ts'

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-site-')))
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), text)
}
write('.whiteboard/pages/plan.md', '---\ntoc: true\n---\n# Plan\n')
write('.whiteboard/pages/notes/a.md', '# A\n')
write('.whiteboard/pages/guide/index.md', '# Guide\n')
write('.whiteboard/pages/shots.md', '# Shots\n\n![one](shots/one.png)\n')
write('.whiteboard/pages/shots/one.png', '\0binary')
write('README.md', '# Readme\n')
write('docs/shot.png', '\0binary')
write('node_modules/x/index.js', '')
const project = projectAt(dir)!
let files = true
const site = servedSite(project, { base: '/rg/dev', files: () => files })

test('a page by its id: its file, its body without the frontmatter, the frontmatter parsed', () => {
  const page = site.page('plan')
  assert.ok(page && 'kind' in page && page.kind === 'page')
  assert.equal(page.file, path.join(dir, '.whiteboard/pages/plan.md'))
  assert.equal(page.body, '# Plan\n')
  assert.deepEqual(page.frontmatter, { toc: true })
  assert.equal(site.page('nothing'), null)
  assert.equal(site.page('../../etc/passwd'), null, 'nothing outside the pages folder')
})

test('a folder: its index page, or its pages listed', () => {
  const guide = site.page('guide')
  assert.ok(guide && 'kind' in guide && guide.kind === 'page' && guide.file.endsWith('guide/index.md'))
  const notes = site.page('notes')
  assert.ok(notes && 'kind' in notes && notes.kind === 'pages')
  assert.deepEqual(
    notes.pages.map(p => p.id),
    ['notes/a'],
  )
  const top = site.page('')
  assert.ok(top && 'kind' in top && top.kind === 'pages')
  assert.deepEqual(top.pages.map(p => p.id).toSorted(), ['guide/index', 'notes/a', 'plan', 'shots'])
})

test('a page next to a folder of its name (its images, say): the page, and the files in the folder', () => {
  const shots = site.page('shots')
  assert.ok(
    shots && 'kind' in shots && shots.kind === 'page' && shots.file.endsWith('pages/shots.md'),
    'the page, not the folder',
  )
  assert.deepEqual(site.page('shots/one.png'), { raw: path.join(dir, '.whiteboard/pages/shots/one.png') })
})

test("the project's files under -/: markdown as a page, text as a file, binary as bytes, a folder listed", () => {
  const readme = site.page('-/README.md')
  assert.ok(readme && 'kind' in readme && readme.kind === 'page')
  assert.deepEqual(site.page('-/docs/shot.png'), { raw: path.join(dir, 'docs/shot.png') })
  const root = site.page('-')
  assert.ok(root && 'kind' in root && root.kind === 'folder')
  assert.ok(!root.entries.some(e => e.name === 'node_modules'), 'node_modules is never shown')
  assert.equal(site.page('-/.git/config'), null)
})

test('addresses: pages and files below the base; the files only while served; links find .md', () => {
  assert.equal(site.urlOf(path.join(dir, '.whiteboard/pages/notes/a.md')), '/rg/dev/notes/a')
  assert.equal(site.urlOf(path.join(dir, 'docs/shot.png')), '/rg/dev/-/docs/shot.png')
  assert.equal(site.urlOf(path.join(dir, 'node_modules/x/index.js')), null)
  assert.equal(site.urlFor(path.join(dir, '.whiteboard/pages/plan')), '/rg/dev/plan', 'plan.md, for a link to plan')
  assert.equal(site.urlFor(path.join(dir, 'docs')), '/rg/dev/-/docs/', 'a folder, with its slash')
  assert.equal(site.urlFor(path.join(dir, 'missing.png')), null)
  files = false
  assert.equal(site.urlOf(path.join(dir, 'docs/shot.png')), null, 'files not served: no address')
  files = true
})

test('frontmatter that is not fields says why, and is read as none', () => {
  assert.deepEqual(parseFrontmatter('---\n- a\n- b\n---\nx'), {
    data: {},
    error: 'it must be fields (`key: value` lines), not a single value or a list',
  })
  assert.match(parseFrontmatter('---\nkey: [unclosed\n---\nx').error ?? '', /./)
  write('.whiteboard/pages/bare.md', 'No frontmatter.\n')
  assert.equal(pageSource('bare', path.join(dir, '.whiteboard/pages/bare.md')).body, 'No frontmatter.\n')
})
