// whiteboard build: pages as a static site, through a project's server in-process.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { project as projectAt } from './config.ts'
import { createServer } from './server.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** A project with docs/ beside .whiteboard/, and its server. */
function docsProject(config = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-build-'))
  const write = (rel: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write('.whiteboard/pages/.keep', '')
  if (config) write('.whiteboard/config.ts', config)
  write(
    'docs/README.md',
    '# The docs\n\n[The guide](guide.md), [its forms](api/forms.md#answers), [the code](../src/x.ts), [notes](notes/todo.md).\n',
  )
  write(
    'docs/guide.md',
    [
      '# Guide',
      '',
      '![a shot](shot.png)',
      '',
      '::image[In a window]{src="shot.png"}',
      '',
      '<img src="media/raw.png" alt="raw HTML">',
      '',
      '::video[A clip]{src="media/clip.mp4" poster="media/poster.png"}',
      '',
      '::iframe[A demo]{src="demo.html"}',
      '',
      ':::form{name=pick}',
      ':radio[A]{name=x} :radio[B]{name=x}',
      ':::',
      '',
      ':::chat{name=talk}',
      'Talk here.',
      ':::',
      '',
      ':::draft[Check this]',
      'Not for the site.',
      ':::',
      '',
      ':::steps[Two]',
      '### A',
      'a',
      '### B',
      'b',
      ':::',
      '',
      '[Back](README.md)',
      '',
    ].join('\n'),
  )
  write('docs/shot.png', PNG)
  write('docs/media/raw.png', PNG)
  write('docs/media/clip.mp4', 'not really a video')
  write('docs/media/poster.png', PNG)
  write('docs/demo.html', '<!doctype html><p>demo</p>\n')
  write('docs/api/forms.md', '# Forms\n\n## Answers\n\n[Home](../README.md)\n')
  write('docs/notes/todo.md', '# Todo\n')
  write('src/x.ts', 'export {}\n')
  const server = createServer(projectAt(dir)!)
  after(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, server, read: (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8') }
}

test('build: the pages the globs name, at their places; links between them relative; images beside them', async () => {
  const { dir, server, read } = docsProject()
  const result = await server.build({ pages: ['docs/**/*.md', '!docs/notes/**'], out: 'site' })
  const files = (d: string): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap(e =>
        e.isDirectory() ? files(path.join(d, e.name)) : [path.relative(path.join(dir, 'site'), path.join(d, e.name))],
      )
  const pages = files(path.join(dir, 'site'))
    .filter(f => f.endsWith('.html'))
    .sort()
  assert.deepEqual(
    pages,
    ['api/forms.html', 'demo.html', 'guide.html', 'index.html'],
    "a README is its folder index; notes/ left out (demo.html: the guide's iframe, copied)",
  )
  assert.equal(result.pages.length, 3)
  assert.ok(fs.existsSync(path.join(dir, 'site/shot.png')), 'the image, beside its page')

  const index = read('site/index.html')
  assert.match(index, /href="guide.html"/)
  assert.match(index, /href="api\/forms.html#answers"/)
  assert.match(index, /href="..\/src\/x.ts"/, 'a link out of the built folder stays as written')
  assert.ok(
    result.warnings.some(w => /src\/x\.ts.*outside/.test(w)),
    result.warnings.join('\n'),
  )
  assert.ok(
    result.warnings.some(w => /notes\/todo\.md.*not in the build/.test(w)),
    result.warnings.join('\n'),
  )
  assert.match(read('site/api/forms.html'), /href="..\/index.html"/)
  assert.match(
    read('site/api/forms.html'),
    /href="..\/_\/whiteboard\/[^"]*base.css"/,
    'assets relative from a deeper page',
  )
})

test('build: what is for writing is left out, what is for reading stays; the page is not live', async () => {
  const { dir, server, read } = docsProject()
  await server.build({ pages: ['docs/*.md'], out: 'site' })
  const guide = read('site/guide.html')
  assert.doesNotMatch(guide, /wb-form|wb-chat|wb-draft|Not for the site/, 'form, chat and draft left out')
  assert.match(guide, /wb-steps/, 'steps stay')
  assert.match(guide, /<img src="shot.png"/)
  // files a block or the page's own HTML names beside it: copied, at the same place
  assert.match(guide, /<img src="media\/raw.png" alt="raw HTML"/)
  assert.match(guide, /src="media\/clip.mp4"/)
  assert.match(guide, /poster="media\/poster.png"/)
  assert.match(guide, /<iframe src="demo.html"/)
  for (const f of ['media/raw.png', 'media/clip.mp4', 'media/poster.png', 'demo.html'])
    assert.ok(fs.existsSync(path.join(dir, 'site', f)), `${f}, beside its page`)
  assert.match(guide, /"live":false/)
  assert.match(guide, /<script type="module" src="_\/whiteboard\/dist\/client\/runtime.js">/)
  assert.doesNotMatch(guide, /wb-live|\/_\/file\//, "nothing of the server's")
  assert.equal(read('site/guide.html').match(/<title>([^<]*)/)?.[1], 'Guide')
})

test("build: skip is the config's, or what is given; a folder the build didn't write is refused", async () => {
  const { dir, server, read } = docsProject(
    `export default { build: { pages: ['docs/*.md'], skip: ['draft'], out: 'public' } }\n`,
  )
  await server.build()
  assert.match(read('public/guide.html'), /wb-form/, 'the config keeps forms')
  assert.doesNotMatch(read('public/guide.html'), /wb-draft/)
  await server.build({ skip: ['steps'] })
  assert.doesNotMatch(read('public/guide.html'), /wb-steps/, 'given over the config')
  fs.mkdirSync(path.join(dir, 'mine'))
  fs.writeFileSync(path.join(dir, 'mine', 'keep.txt'), 'mine')
  await assert.rejects(server.build({ out: 'mine' }), /files a build didn't write/)
  assert.ok(fs.existsSync(path.join(dir, 'mine', 'keep.txt')))
  await assert.rejects(server.build({ pages: ['nothing/*.md'] }), /no markdown files match/)
})

test("build: what plugins put in their slots is there, asked with no request; not a skipped plugin's", async () => {
  const { server, read } = docsProject(
    [
      'export default { plugins: [',
      "  { name: 'probe', setup: () => ({ slots: req => ({ head: `<meta name=\"probe\" content=\"${req ? 'browser' : 'build'}\">` }) }) },",
      "  { name: 'gone', setup: () => ({ slots: () => ({ head: '<meta name=\"gone\">' }) }) },",
      '] }',
      '',
    ].join('\n'),
  )
  await server.build({ pages: ['docs/*.md'], out: 'site', skip: ['gone', 'form', 'chat', 'draft'] })
  const guide = read('site/guide.html')
  assert.match(guide, /<meta name="probe" content="build">/)
  assert.doesNotMatch(guide, /name="gone"/)
})
