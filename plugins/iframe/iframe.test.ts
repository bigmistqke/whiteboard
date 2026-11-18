import { test } from 'node:test'
import assert from 'node:assert/strict'
import { height, safeSrc } from './index.ts'

test('iframe: a src is a web URL or a path, never a script', () => {
  for (const ok of ['http://localhost:5173', 'https://example.com/x', '//cdn.example.com', 'demo.html', '/demo.html', 'sub/a.html?x=1#y'])
    assert.ok(safeSrc(ok), ok)
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x'])
    assert.ok(!safeSrc(bad), bad)
})

test('iframe: a height in pixels or a CSS length, else the default', () => {
  assert.equal(height('600'), '600px')
  assert.equal(height('70vh'), '70vh')
  assert.equal(height('20rem'), '20rem')
  assert.equal(height(undefined), '480px')
  assert.equal(height('100%; background: red'), '480px')
})
