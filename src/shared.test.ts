// The command line with the shared server, as processes: a throwaway machine folder (WHITEBOARD_HOME)
// and projects, `whiteboard` run in them.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VERSION } from './package.ts'

const CLI = fileURLToPath(new URL('../bin/whiteboard.ts', import.meta.url))
const PAGE = `# Plan\n\n:::form{name=pick}\n:radio[A]{name=x} :radio[B]{name=x}\n:::\n`

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })

const until = async <T>(what: string, check: () => T | Promise<T>, timeout = 15000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeout
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const health = async (port: number) => {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as Record<string, any>
  } catch {
    return null
  }
}

/** A machine folder with one entry over `root/rg/*`, two projects in it, and one outside. */
async function machine() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shared-')))
  const home = path.join(root, 'machine')
  const port = await freePort()
  fs.mkdirSync(home)
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ port, entries: { rg: { include: [`${root}/jobs/*`] } } }),
  )
  const env: NodeJS.ProcessEnv = { ...process.env, WHITEBOARD_HOME: home, WHITEBOARD_PORT: String(await freePort()) }
  delete env.CLAUDE_CODE_SESSION_ID
  const children: ChildProcess[] = []
  const dirs: string[] = []
  const make = (rel: string) => {
    const dir = path.join(root, rel)
    fs.mkdirSync(path.join(dir, '.whiteboard', 'pages'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.whiteboard', 'pages', 'plan.md'), PAGE)
    dirs.push(dir)
    return dir
  }
  const cli = (dir: string, ...args: string[]) =>
    execFileSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const run = (dir: string, ...args: string[]) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env })
    let out = ''
    child.stdout!.on('data', d => (out += d))
    children.push(child)
    return Object.assign(child, { output: () => out })
  }
  after(async () => {
    for (const c of children) c.kill()
    // the servers the commands started: the shared one, and a project's own
    for (const file of [
      path.join(home, 'state', 'server.json'),
      ...dirs.map(d => path.join(d, '.whiteboard', 'server.json')),
    ]) {
      try {
        process.kill(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 'SIGTERM')
      } catch {}
    }
    await new Promise(r => setTimeout(r, 200))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const runSync = (dir: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8' })
    return { stdout: r.stdout, stderr: r.stderr, status: r.status }
  }
  return { root, home, port, env, make, cli, run, runSync, children }
}

/** Start the shared server as a person does: `whiteboard serve` outside any project. */
async function serve(m: Awaited<ReturnType<typeof machine>>) {
  const child = m.run(m.root, 'serve')
  await until('the shared server', async () => (await health(m.port))?.hub)
  return child
}

test('a wait with no server waits for one, starts none, and gets the answer once one is served', async () => {
  const m = await machine()
  const a = m.make('jobs/a')
  const wait = m.run(a, 'wait', '--page', 'plan')
  await new Promise(r => setTimeout(r, 2500))
  assert.equal(wait.exitCode, null, 'still waiting')
  assert.equal(await health(m.port), null, 'no server started')
  assert.ok(!fs.existsSync(path.join(m.home, 'state', 'server.json')))
  // url only finds one
  assert.throws(() => m.cli(a, 'url', 'plan'), /the shared server is not running/)
  // nor does show: the shared server is started outside the agents' sandboxes
  assert.throws(() => m.cli(a, 'show', 'plan'), /the shared server is not running/)
  assert.equal(await health(m.port), null, 'no server started')
  await serve(m)
  assert.equal(m.cli(a, 'show', 'plan'), `http://localhost:${m.port}/rg/jobs/a/plan`)
  // the wait finds the server and says it listens; then the reader answers
  await until('the wait to listen', async () => {
    const listeners = (await (
      await fetch(`http://127.0.0.1:${m.port}/rg/jobs/a/api/listeners?page=plan`)
    ).json()) as unknown[]
    return listeners.length > 0
  })
  await fetch(`http://127.0.0.1:${m.port}/rg/jobs/a/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 'plan', type: 'pick', action: 'Send', data: { x: 'A' } }),
  })
  await until('the wait to exit', () => wait.exitCode != null)
  assert.equal(JSON.parse(wait.output()).data.x, 'A')
})

test('two projects of an entry share one server; one outside the includes runs its own', async () => {
  const m = await machine()
  const a = m.make('jobs/a')
  const b = m.make('jobs/b')
  const outside = m.make('elsewhere/c')
  await serve(m)
  assert.equal(m.cli(a, 'show', 'plan'), `http://localhost:${m.port}/rg/jobs/a/plan`)
  assert.equal(m.cli(b, 'show', 'plan'), `http://localhost:${m.port}/rg/jobs/b/plan`)
  assert.ok(!fs.existsSync(path.join(a, '.whiteboard', 'server.json')), 'no server of its own')
  const own = m.cli(outside, 'show', 'plan')
  assert.match(own, /^http:\/\/localhost:\d+\/plan$/)
  assert.notEqual(new URL(own).port, String(m.port))
  assert.ok(fs.existsSync(path.join(outside, '.whiteboard', 'server.json')))
})

/** A stand-in for a shared server of another version: its health, and /api/shutdown as an older one has it. */
function fakeShared(m: Awaited<ReturnType<typeof machine>>, version: string, dir: string) {
  const script = `
    const http = require('node:http'), fs = require('node:fs')
    const [port, version, dir, file] = process.argv.slice(1)
    http.createServer((req, res) => {
      if (req.url.startsWith('/api/health')) {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ ok: true, hub: true, pid: process.pid, version, projects: [{ entry: 'rg', dir, base: '/rg/jobs/a' }] }))
      }
      if (req.url === '/api/shutdown') { res.end('{}'); return process.exit(0) }
      res.end('fake')
    }).listen(Number(port), '127.0.0.1', () => fs.writeFileSync(file, JSON.stringify({ port: Number(port), pid: process.pid, version })))
  `
  fs.mkdirSync(path.join(m.home, 'state'), { recursive: true })
  const child = spawn(process.execPath, [
    '-e',
    script,
    String(m.port),
    version,
    dir,
    path.join(m.home, 'state', 'server.json'),
  ])
  m.children.push(child)
  return child
}

test("a newer whiteboard's serve takes an older shared server over; its show only uses it", async () => {
  const m = await machine()
  const a = m.make('jobs/a')
  const old = fakeShared(m, '0.0.1', a)
  await until('the old server', async () => (await health(m.port))?.version === '0.0.1')
  // an agent's command uses it, and says it is older
  const shown = m.runSync(a, 'show', 'plan')
  assert.equal(shown.stdout.trim(), `http://localhost:${m.port}/rg/jobs/a/plan`)
  assert.match(shown.stderr, /runs 0\.0\.1.*restart it to upgrade/)
  await new Promise(r => setTimeout(r, 500))
  assert.equal(old.exitCode, null, 'still running')
  // serve, from outside the projects, takes it over
  m.run(m.root, 'serve')
  await until('the old one to exit', () => old.exitCode != null)
  await until('the new one', async () => (await health(m.port))?.version === VERSION)
  assert.equal((await health(m.port))?.version, VERSION)
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.home, 'state', 'server.json'), 'utf8')).version, VERSION)
})

test('an older whiteboard never replaces a newer shared server: it uses it', async () => {
  const m = await machine()
  const a = m.make('jobs/a')
  const newer = fakeShared(m, '999.0.0', a)
  await until('the newer server', async () => (await health(m.port))?.version === '999.0.0')
  assert.equal(m.cli(a, 'show', 'plan'), `http://localhost:${m.port}/rg/jobs/a/plan`)
  await new Promise(r => setTimeout(r, 500))
  assert.equal(newer.exitCode, null, 'still running')
  assert.equal((await health(m.port))?.version, '999.0.0')
})

test("a wait without --page in a project of an entry is the whole entry's fallback", async () => {
  const m = await machine()
  const a = m.make('jobs/a')
  const b = m.make('jobs/b')
  await serve(m)
  const answer = (job: string, x: string) =>
    fetch(`http://127.0.0.1:${m.port}/rg/jobs/${job}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 'plan', type: 'pick', action: 'Send', data: { x } }),
    })
  const listeners = async (job: string) =>
    (await (await fetch(`http://127.0.0.1:${m.port}/rg/jobs/${job}/api/listeners?page=plan`)).json()) as {
      fallback?: boolean
    }[]
  // a's own agent waits on its page; the coordinator runs the fallback from a
  const own = m.run(a, 'wait', '--page', 'plan')
  const coordinator = m.run(a, 'watch')
  await until('both to listen', async () => (await listeners('a')).length === 2)
  // the fallback is held on every project of the entry, so b's page says someone listens
  assert.deepEqual(
    (await listeners('b')).map(l => !!l.fallback),
    [true],
  )
  // a second fallback in the entry is refused
  const second = m.run(b, 'wait')
  await until('the second to exit', () => second.exitCode != null)
  assert.equal(second.exitCode, 1)
  // a's answer is its own agent's; b's, which nobody else listens for, reaches the coordinator
  await answer('a', 'A')
  await until("a's wait", () => own.exitCode != null)
  assert.equal(JSON.parse(own.output()).data.x, 'A')
  await answer('b', 'B')
  const got = await until('the fallback to hand it out', () => coordinator.output().trim())
  const lines = got.split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, 1, 'only what no other listener takes')
  assert.equal(lines[0].data.x, 'B')
  assert.equal(lines[0].project, b)
  assert.equal(lines[0].url, `http://localhost:${m.port}/rg/jobs/b/plan`)
  // and it is taken, in b's own log (the watch may print it before it writes the mark)
  await until("the mark in b's log", () =>
    fs.readFileSync(path.join(b, '.whiteboard', 'events.ndjson'), 'utf8').includes(`"type":"whiteboard:received"`),
  )
})

test('the shared server writes only its state folder; its config is read, never written', async () => {
  const m = await machine()
  m.make('jobs/a')
  const before = fs.readFileSync(path.join(m.home, 'config.json'), 'utf8')
  await serve(m)
  assert.ok(fs.existsSync(path.join(m.home, 'state', 'server.json')))
  assert.ok(fs.existsSync(path.join(m.home, 'state', 'overview', '.whiteboard')))
  assert.deepEqual(
    fs.readdirSync(m.home).toSorted(),
    ['config.json', 'state'],
    'nothing beside the config but the state folder',
  )
  assert.equal(fs.readFileSync(path.join(m.home, 'config.json'), 'utf8'), before)
})

test('paths: what a sandbox wrapper grants the shared server', async () => {
  const m = await machine()
  m.make('jobs/a')
  // made by paths itself: a sandbox grants only folders that exist
  assert.ok(!fs.existsSync(path.join(m.home, 'state')))
  const [write, read] = [m.cli(m.root, 'paths', '--write'), m.cli(m.root, 'paths', '--read')]
  assert.ok(fs.existsSync(path.join(m.home, 'state')))
  // the entry's folder up to its wildcard, and the state folder; the config and whiteboard, to read
  assert.deepEqual(write.split(':'), [path.join(m.root, 'jobs'), path.join(m.home, 'state')])
  assert.deepEqual(read.split(':'), [m.home, path.resolve(path.dirname(CLI), '..')])
})

test("a machine config that can't be read stops a command, rather than it starting a server of the project's own", async t => {
  if (process.getuid?.() === 0) return t.skip('as root everything is readable')
  const m = await machine()
  const a = m.make('jobs/a')
  const config = path.join(m.home, 'config.json')
  fs.chmodSync(config, 0)
  let shown
  try {
    shown = m.runSync(a, 'show', 'plan')
  } finally {
    fs.chmodSync(config, 0o644)
  }
  assert.equal(shown.status, 1)
  assert.match(
    shown.stderr,
    /cannot read .*config\.json \(EACCES\): if this runs in a sandbox, it needs a read grant for/,
  )
  assert.ok(!fs.existsSync(path.join(a, '.whiteboard', 'server.json')), 'no server of its own')
})
