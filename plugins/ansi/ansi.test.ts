import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { toHtml, unescape } from './index.ts'
import { project as projectAt } from '../../src/config.ts'
import { createServer } from '../../src/server.ts'

const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')

test('ansi: escapes written out as text are the escape byte', () => {
  for (const written of ['\\e[31m', '\\x1b[31m', '\\033[31m', '\\u001b[31m', '^[[31m'])
    assert.equal(unescape(written), '\x1b[31m', written)
  // a backslash-e that starts no sequence is left as written
  assert.equal(unescape('C:\\escape'), 'C:\\escape')
})

test('ansi: colours inline, as a terminal shows them; the text escaped', async () => {
  const out = await toHtml('\x1b[32m✔\x1b[0m ok \x1b[1mbold\x1b[0m\n\\e[31m✖\\e[0m <tag> & co\n')
  assert.match(out, /<span style='color: #4e9a06;'>✔<\/span>/)
  assert.match(out, /font-weight: bold;'>bold</)
  assert.match(out, /<span style='color: #cc0000;'>✖<\/span>/)
  assert.match(out, /&lt;tag>/)
  assert.ok(!out.includes('<tag>'), 'no markup from the output')
  assert.deepEqual(
    out.split('\n').map(text),
    ['✔ ok bold', '✖ <tag> & co'],
    'one row per line, without the padding to the terminal width',
  )
})

test('ansi: 256 and true colour; a progress line \\r writes over shows as it ended', async () => {
  const out = await toHtml(
    '\x1b[38;5;208morange\x1b[0m \x1b[38;2;10;200;255mtrue\x1b[0m\nloading 10%\rloading 100%\n\n\n',
  )
  assert.match(out, /color: #ff8700;'>orange/)
  assert.match(out, /color: #0ac8ff;'>true/)
  assert.deepEqual(out.split('\n').map(text), ['orange true', 'loading 100%'], 'blank rows at the end left out')
})

test('ansi: a fence on a page; with a title, in a window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ansi-'))
  fs.mkdirSync(path.join(dir, '.whiteboard', 'pages'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.whiteboard', 'pages', 'out.md'),
    '# Out\n\n```ansi\n\\e[32mpass\\e[0m\n```\n\n```ansi {title="npm test"}\n\\e[31mfail\\e[0m\n```\n',
  )
  const server = createServer(projectAt(dir)!)
  const listener = http.createServer((req, res) => void server.handle(req, res))
  await new Promise<void>(r => listener.listen(0, '127.0.0.1', r))
  try {
    const page = await (await fetch(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/out`)).text()
    assert.match(page, /<pre class="wb-ansi"><code><span class="wb-ansi-row"><span style='color: #4e9a06;'>pass/)
    assert.match(page, /wb-window-title">npm test<[\s\S]*?<pre class="wb-ansi">[\s\S]*?color: #cc0000;'>fail/)
    assert.match(page, /ansi\/public\/style\.css/)
  } finally {
    server.close()
    listener.closeAllConnections()
    listener.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
