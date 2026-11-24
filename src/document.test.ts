// A page as the browser gets it, put together without a server: the plugins' parts and the document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageDocument, pluginParts, type SetUp } from './document.ts'
import type { PageSource } from './define.ts'

const hook = (name: string, extra: Partial<SetUp> = {}): SetUp =>
  ({ name, table: [], plugin: { name }, ...extra }) as SetUp

const hooks = [
  hook('drawer', { shell: req => ({ body: `<aside>${req ? 'served' : 'built'}</aside>` }), client: '/p/drawer.js' }),
  hook('broken', { error: new Error('no setup') }),
  hook('throws', {
    shell: () => {
      throw new Error('oops')
    },
  }),
  hook('skipped', { shell: () => ({ head: '<meta name=skipped>' }), client: '/p/skipped.js' }),
]

test("pluginParts: each plugin's markup and module; one that fails is told, one left out is quiet", async () => {
  const failed: string[] = []
  const parts = await pluginParts(hooks, null, {
    asset: ref => `addr:${ref}`,
    messages: ['chat:message'],
    leaveOut: new Set(['skipped']),
    failed: m => failed.push(m),
  })
  assert.equal(parts.body.map(String).join(''), '<aside>built</aside>')
  assert.equal(parts.head.map(String).join(''), '', 'the skipped plugin adds nothing')
  assert.deepEqual(parts.clients, [{ name: 'drawer', client: 'addr:/p/drawer.js' }])
  assert.deepEqual(parts.messages, ['chat:message'])
  assert.deepEqual(failed, ['plugin "broken" failed to start: no setup', 'plugin "throws" failed on this page: oops'])
})

test('pageDocument: the render, the parts and a handoff saying how the page is put out', () => {
  const page: PageSource = {
    kind: 'page',
    id: 'plan',
    file: '/p/plan.md',
    mtime: 1,
    source: '',
    body: '',
    frontmatter: { toc: true },
  }
  const doc = (live: boolean) =>
    pageDocument(
      page,
      { page: true, out: { html: '<h1>Plan</h1>', title: 'Plan' }, notices: ['a notice'] },
      { head: [], body: [], clients: [], messages: [] },
      {
        live,
        base: live ? '/rg' : '',
        asset: ref => `addr:${ref}`,
        runtime: live ? '/rg/_/runtime.js' : '_/runtime.js',
        title: 'project',
        ...(live && { stamps: { code: 'c', style: 's' } }),
      },
    )
  const handoff = (html: string) =>
    JSON.parse(/<script type="application\/json" id="wb-page">([\s\S]*?)<\/script>/.exec(html)![1]!)
  const served = doc(true)
  assert.match(served, /<title>Plan<\/title>/)
  assert.match(served, /<pre class="wb-error" role="alert">a notice<\/pre>/)
  assert.match(served, /<script type="module" src="\/rg\/_\/runtime.js">/)
  assert.deepEqual((({ live, base, frontmatter, stamps }) => ({ live, base, frontmatter, stamps }))(handoff(served)), {
    live: true,
    base: '/rg',
    frontmatter: { toc: true },
    stamps: { code: 'c', style: 's' },
  })
  const built = handoff(doc(false))
  assert.equal(built.live, false)
  assert.equal(built.stamps, undefined, 'a built page has nothing to compare with')
})
