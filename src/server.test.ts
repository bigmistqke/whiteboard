// A project's server, in-process: a throwaway project, createServer, and requests through a plain
// HTTP server on a free port.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { project as projectAt } from './config.ts'
import { createServer, type WhiteboardServer } from './server.ts'

const PAGE = `# Plan

:::form{name=pick}
:radio[A]{name=x} :radio[B]{name=x}
:::
`

/** A project with the page `q`, its server, and its base URL. Torn down after the tests. */
async function serve(files: Record<string, string> = {}): Promise<{ base: string; dir: string; server: WhiteboardServer }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-server-'))
  fs.mkdirSync(path.join(dir, '.whiteboard', 'pages'), { recursive: true })
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.whiteboard', file), text)
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'q.md'), PAGE)
  fs.mkdirSync(path.join(dir, '.whiteboard', 'pages', 'notes'))
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'notes', 'a.md'), '# A\n')
  const server = createServer(projectAt(dir)!)
  const http_ = http.createServer((req, res) => { void server.handle(req, res) })
  await new Promise<void>(r => http_.listen(0, '127.0.0.1', r))
  after(() => { server.close(); http_.closeAllConnections(); http_.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { base: `http://127.0.0.1:${(http_.address() as AddressInfo).port}`, dir, server }
}

const until = async <T>(what: string, check: () => T | Promise<T>, timeout = 3000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeout
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise(r => setTimeout(r, 25))
  }
}

/** Open a server-sent event stream and collect the names of its events. */
function stream(url: string) {
  const controller = new AbortController()
  const seen: string[] = []
  const done = fetch(url, { signal: controller.signal }).then(async res => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return 'ended'
      for (const m of decoder.decode(value).matchAll(/^event: (\w+)$/gm)) seen.push(m[1]!)
    }
  }).catch(() => 'aborted')
  return { seen, done, stop: () => controller.abort() }
}

const { base, dir, server } = await serve()

test('health names the project', async () => {
  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.dir, dir)
})

test('a page renders as markdown, and a missing one is a 404', async () => {
  const page = await fetch(`${base}/q`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<form name="pick"/)
  assert.equal((await fetch(`${base}/nope`)).status, 404)
})

test('a folder of pages is served with its slash', async () => {
  const res = await fetch(`${base}/notes`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), '/notes/')
})

test('events go into the log and come back filtered, picked ones marked', async () => {
  const posted = await (await fetch(`${base}/api/events`, { method: 'POST', body: JSON.stringify({ page: 'q', type: 'note', data: { a: 1 } }) })).json()
  assert.equal(posted.type, 'note')
  const listed = await (await fetch(`${base}/api/events?page=q&type=note`)).json()
  assert.deepEqual(listed.map((e: { id: string }) => e.id), [posted.id])
  assert.equal(listed[0].pickedUp, undefined)
})

test('status: an unanswered question is open whoever listens; unheard says whether a wait takes it', async () => {
  const status = async () => (await server.status('q'))[0]!
  assert.equal((await status()).questions.find(q => q.name === 'pick')!.state, 'open')
  assert.deepEqual((await status()).unheard, ['pick'])
  const watch = stream(`${base}/api/watch?page=q`)
  const listen = stream(`${base}/api/listen?page=q&type=pick&command=wait`)
  await until('heard', async () => !(await status()).unheard.length)
  assert.equal((await status()).questions.find(q => q.name === 'pick')!.state, 'open', 'still open: it waits for the reader')
  assert.deepEqual((await status()).listeners, [{ page: 'q', type: 'pick', command: 'wait' }])
  // an open page is told that someone listens
  await until('the page heard of the listener', () => watch.seen.includes('listeners'))
  listen.stop()
  await until('unheard again', async () => (await status()).unheard.length === 1)
  watch.stop()
})

test('a changed page file tells the open page', async () => {
  const watch = stream(`${base}/api/watch?page=q`)
  await new Promise(r => setTimeout(r, 100))
  fs.appendFileSync(path.join(dir, '.whiteboard', 'pages', 'q.md'), '\nMore.\n')
  await until('change', () => watch.seen.includes('change'))
  watch.stop()
})

test('close ends the live connections', async () => {
  const { base, server } = await serve()
  const watch = stream(`${base}/api/watch?page=q`)
  await new Promise(r => setTimeout(r, 100))
  server.close()
  assert.equal(await watch.done, 'ended')
})

test('a served file opens up its folder only for browser assets, never the token or the log', async () => {
  // a local plugin whose browser module sits in .whiteboard/, next to the project's own files
  const { base } = await serve({
    'config.ts': "export default { plugins: [{ name: 'probe', setup: () => ({ client: new URL('./probe.client.js', import.meta.url) }) }] }\n",
    'probe.client.js': "import './helper.js'\nexport default () => {}\n",
    'helper.js': 'export const x = 1\n',
    'token': 'secret\n',
    'events.ndjson': '',
  })
  // the page's first render asks the server to serve the plugin's module
  const page = await (await fetch(`${base}/q`)).text()
  const client = /"client":"([^"]*probe\.client\.js)"/.exec(page)?.[1]
  assert.ok(client, 'the page names the plugin\'s module')
  // beside it, as the server names files (the temporary folder may sit behind a symlink)
  const at = (file: string) => `${base}${client.replace(/probe\.client\.js$/, encodeURIComponent(file))}`
  assert.equal((await fetch(`${base}${client}`)).status, 200, 'the module')
  assert.equal((await fetch(at('helper.js'))).status, 200, 'a module beside it, which it imports')
  for (const file of ['token', 'events.ndjson', 'config.ts']) assert.equal((await fetch(at(file))).status, 404, file)
})

test('the built-in plugins bring their blocks without any config', async () => {
  const { base, dir } = await serve()
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'blocks.md'), ':::callout[Hi]\nThere.\n:::\n\n:::chat{name=talk}\n:::\n')
  const page = await (await fetch(`${base}/blocks`)).text()
  assert.match(page, /class="wb-callout"/)
  assert.match(page, /data-chat="talk"/)
})

test('a page that is not there: a styled page saying so, the path in it as written, never markup', async () => {
  const { base } = await serve()
  const res = await fetch(`${base}/nothing-here`)
  assert.equal(res.status, 404)
  const page = await res.text()
  assert.match(page, /<link rel="stylesheet" href="[^"]*base\.css"/, 'the page\'s styles')
  assert.match(page, /<h1>Not found<\/h1>/)
  assert.match(page, /nothing-here does not exist yet/)
  const crafted = await (await fetch(`${base}/x%3Cb%3Ey%3C%2Fb%3E%3A%3Abutton%5BGo%5D`)).text()
  const main = crafted.slice(crafted.indexOf('<main'), crafted.indexOf('</main>'))
  assert.doesNotMatch(main, /<b>|<button/, 'neither markup nor a block from the path')
  assert.match(main, /x&#x3C;b>y&#x3C;\/b>::button\[Go\]|x&lt;b&gt;y/)
})

test('code fences show their text: ```text is code, not a text field, and a diff without hunks shows every line', async () => {
  const { base, dir } = await serve()
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'code.md'), '# Code\n\n```text\nError: it failed\n```\n\n```diff\n function f() {\n-  return 1\n+  return 2\n }\n```\n\nAfter.\n')
  const page = await (await fetch(`${base}/code`)).text()
  const main = page.slice(page.indexOf('<main'), page.indexOf('</main>')).replace(/<span[^>]*>|<\/span>/g, '')
  assert.doesNotMatch(main, /<input/, 'no text field')
  assert.match(main, /Error: it failed/)
  assert.match(main, /return 1[\s\S]*return 2/, 'the diff\'s lines')
  assert.match(main, /<p>After\.<\/p>/)
})

test('a message is markdown, rendered like a page, without raw HTML or directives', async () => {
  const { base } = await serve()
  const res = await fetch(`${base}/api/markdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts: ['**bold**, `code` and <b onclick="x()">raw</b> :button[Go]{name=go}', '```ts\nconst a = 1\n```'] }) })
  const { html, styles } = await res.json() as { html: string[]; styles: string[] }
  assert.match(html[0], /<strong>bold<\/strong>, <code>code<\/code>/)
  assert.doesNotMatch(html[0], /<b onclick/, 'raw HTML is text')
  assert.match(html[0], /&#x3C;b onclick="x\(\)">raw&#x3C;\/b>|&lt;b onclick/)
  assert.match(html[0], /:button\[Go\]\{name="go"\}/, 'a directive as written')
  assert.doesNotMatch(html[0], /<button/)
  assert.match(html[1], /<pre class="shiki/, 'a fence goes to the code block')
  assert.ok(styles.length >= 1, 'with the code block\'s stylesheet')
})

test('#n and !n link to the issues and merge requests of the project\'s GitLab remote', async () => {
  const { base, dir } = await serve()
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.example.com:team/app.git'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'refs.md'), 'Closes #7 via !8; `#9` stays.\n')
  const page = await (await fetch(`${base}/refs`)).text()
  assert.match(page, /<a href="https:\/\/gitlab.example.com\/team\/app\/-\/issues\/7"[^>]*>#7<\/a>/)
  assert.match(page, /<a href="https:\/\/gitlab.example.com\/team\/app\/-\/merge_requests\/8"[^>]*>!8<\/a>/)
  assert.match(page, /<code>#9<\/code>/)
})

test('an iframe shows an HTML file next to the pages, as it is; a script src is refused', async () => {
  const { base, dir } = await serve()
  const pages = path.join(dir, '.whiteboard', 'pages')
  fs.writeFileSync(path.join(pages, 'demo.html'), '<!doctype html><p id="inside">inside</p>')
  fs.writeFileSync(path.join(pages, 'f.md'), '::iframe[The demo]{src="demo.html" height=300}\n\n::iframe{src="javascript:alert(1)"}\n')
  const page = await (await fetch(`${base}/f`)).text()
  assert.match(page, /<iframe src="demo.html" title="The demo"/)
  assert.match(page, /style="height: 300px"/)
  assert.match(page, /iframe: src must be an http\(s\) URL or a path, not javascript:/)
  assert.doesNotMatch(page, /src="javascript:/)
  const framed = await fetch(`${base}/demo.html`)
  assert.equal(framed.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.match(await framed.text(), /id="inside"/)
})

test('a config plugin with a built-in\'s name replaces it; a plugin\'s style is on every page', async () => {
  const { base, dir } = await serve({
    'config.ts': `export default { plugins: [{ name: 'callout', style: new URL('./every.css', import.meta.url), blocks: { callout: { html: () => '<p class="mine">mine</p>' } } }] }\n`,
    'every.css': 'p { color: red }\n',
  })
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'c.md'), ':::callout\nThere.\n:::\n')
  const page = await (await fetch(`${base}/c`)).text()
  assert.match(page, /class="mine"/)
  assert.doesNotMatch(page, /class="wb-callout"/)
  assert.match(page, /every\.css/)
})

test('two plugins bringing the same block is a config error, shown on the page', async () => {
  const { base, dir } = await serve({
    'config.ts': `export default { plugins: [{ name: 'other', blocks: { grid: { html: () => '' } } }] }\n`,
  })
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'g.md'), '# G\n')
  assert.match(await (await fetch(`${base}/g`)).text(), /block &quot;grid&quot; comes from two plugins: grid and other/)
})

test('status counts the reader\'s events for an agent: answers and declared ones, not other plugin events', async () => {
  const { base, server } = await serve()
  const post = (type: string, data = {}) => fetch(`${base}/api/events`, { method: 'POST', body: JSON.stringify({ page: 'q', type, data }) })
  await post('votes:up')
  await post('chat:message', { chat: 'talk', text: 'hi' })   // the chat plugin declares it handOut
  await post('pick', { x: 'A' })
  const types = (await server.status('q'))[0]!.unpicked.map(e => e.type)
  assert.deepEqual(types.sort(), ['chat:message', 'pick'])
})

test('a plugin\'s event types must be named after it', async () => {
  const { base, dir } = await serve({ 'config.ts': `export default { plugins: [{ name: 'votes', events: { 'up': {} } }] }\n` })
  fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'v.md'), '# V\n')
  assert.match(await (await fetch(`${base}/v`)).text(), /event type &quot;up&quot; must be named after it: votes:&lt;what&gt;/)
})
