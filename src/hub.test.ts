// The shared server, in-process: a throwaway machine folder and projects, createHub, and requests
// through a plain HTTP server on a free port.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHub } from './hub.ts'

const PAGE = `# Plan\n\n:::form{name=pick}\n:radio[A]{name=x} :radio[B]{name=x}\n:::\n`

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-hub-')))
after(() => fs.rmSync(root, { recursive: true, force: true }))

function project(rel: string, pages: Record<string, string> = { plan: PAGE }) {
  const dir = path.join(root, rel)
  fs.mkdirSync(path.join(dir, '.whiteboard', 'pages'), { recursive: true })
  for (const [name, text] of Object.entries(pages))
    fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', `${name}.md`), text)
  return dir
}

project('rg/develop')
project('rg/develop/.claude/worktrees/cmux', { notes: '# Notes\n' })
const machine = path.join(root, 'machine')
fs.mkdirSync(machine)
fs.writeFileSync(
  path.join(machine, 'config.json'),
  JSON.stringify({ entries: { rg: { include: ['~/rg/develop', '~/rg/develop/.claude/worktrees/*'] } } }),
)

let shutdowns = 0
const hub = createHub({ dir: machine, home: root, interval: 60_000, version: '1.2.0', onShutdown: () => shutdowns++ })
const server = http.createServer((req, res) => void hub.handle(req, res))
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(() => {
  hub.close()
  server.closeAllConnections()
  server.close()
})

test('each project is served under its path, its URLs starting with it', async () => {
  const res = await fetch(`${base}/rg/develop/plan`)
  assert.equal(res.status, 200)
  const page = await res.text()
  assert.match(page, /"base":"\/rg\/develop"/)
  assert.match(page, /src="\/rg\/develop\/_\/runtime\.js"/)
  assert.ok(!/(href|src)="\/_\//.test(page), 'no URL of the server outside the project path')
  const notes = await fetch(`${base}/rg/worktrees/cmux/notes`)
  assert.equal(notes.status, 200)
  assert.match(await notes.text(), /Notes/)
  // the project's own API, under its path
  const status = (await (await fetch(`${base}/rg/develop/api/status`)).json()) as { page: string; open: string[] }[]
  assert.deepEqual(
    status.map(s => [s.page, s.open]),
    [['plan', ['pick']]],
  )
  // its overview is at its folder
  const bare = await fetch(`${base}/rg/develop`, { redirect: 'manual' })
  assert.equal(bare.status, 302)
  assert.equal(bare.headers.get('location'), '/rg/develop/')
})

test('the index lists each entry, its projects and what is unanswered, and the version', async () => {
  const index = await (await fetch(`${base}/`)).text()
  assert.match(index, /<h2>rg<\/h2>/)
  assert.match(index, /href="\/rg\/develop\/plan#wb-waiting"/)
  assert.match(index, /unanswered: pick/)
  assert.match(index, /href="\/rg\/worktrees\/cmux\/notes"/)
  assert.match(index, /whiteboard 1\.2\.0/)
  const health = (await (await fetch(`${base}/api/health`)).json()) as {
    hub: boolean
    version: string
    projects: unknown[]
  }
  assert.equal(health.hub, true)
  assert.equal(health.version, '1.2.0')
  assert.equal(health.projects.length, 2)
})

test('a project appearing or going is served or not, without a restart', async () => {
  assert.equal((await fetch(`${base}/rg/worktrees/fresh/plan`)).status, 404)
  const fresh = project('rg/develop/.claude/worktrees/fresh')
  // what a command does for a project it does not find
  await fetch(`${base}/api/health?rescan`)
  assert.equal((await fetch(`${base}/rg/worktrees/fresh/plan`)).status, 200)
  fs.rmSync(fresh, { recursive: true })
  hub.rescan()
  assert.equal((await fetch(`${base}/rg/worktrees/fresh/plan`)).status, 404)
})

test("a plugin's browser module that writes /api/… itself reaches its project, by the page that asked", async () => {
  const res = await fetch(`${base}/api/status`, { headers: { referer: `${base}/rg/develop/plan` } })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as unknown[]).length, 1)
  assert.equal((await fetch(`${base}/api/status`)).status, 404)
})

test('only a newer whiteboard makes it exit; an older one, one as new, or a page cannot', async () => {
  const ask = (version: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ version }),
    })
  assert.equal((await ask('1.1.9')).status, 409)
  assert.equal((await ask('1.2.0')).status, 409)
  assert.equal((await ask('1.3.0', { origin: base })).status, 403)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(shutdowns, 0)
  assert.equal((await ask('1.3.0')).status, 200)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(shutdowns, 1)
})
