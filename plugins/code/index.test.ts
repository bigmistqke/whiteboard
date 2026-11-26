// The highlighter outlives a config reload: the server imports the plugin afresh each time the
// config changes, and a highlighter made per import was never freed, until Shiki's memory ran out
// and every code block on every page failed.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('code: one highlighter for the server, however often the plugin is loaded afresh', async t => {
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')))
  for (let i = 0; i < 15; i++) {
    const { default: code } = await import(`./index.ts?reload=${i}`)
    const block = code().blocks.code
    const html = await block.html({ text: 'const x = el._x!._lane', lang: 'ts', attrs: {} })
    assert.match(html, /shiki/)
  }
  assert.deepEqual(
    warnings.filter(w => w.includes('[Shiki]')),
    [],
  )
})
