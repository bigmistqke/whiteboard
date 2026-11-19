// Finding the entries' projects from include and exclude globs.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  discover,
  entryFolders,
  followEntries,
  matchesEntries,
  readMachineConfig,
  type MachineConfig,
} from './entries.ts'

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-entries-')))
after(() => fs.rmSync(home, { recursive: true, force: true }))

/** A folder under the fake home, with a `.whiteboard/` when it is a project. */
function folder(rel: string, project = true) {
  const dir = path.join(home, rel)
  fs.mkdirSync(project ? path.join(dir, '.whiteboard') : dir, { recursive: true })
  return dir
}

const config: MachineConfig = {
  entries: {
    rg: {
      include: ['~/rg/develop', '~/rg/develop/.claude/worktrees/*', '~/rg/worksite/jobs/*', '~/rg/worksite/archive/*'],
      exclude: ['~/rg/worksite/archive/**'],
    },
  },
}

folder('rg/develop')
folder('rg/develop/.claude/worktrees/cmux')
folder('rg/develop/.claude/worktrees/plain', false)
folder('rg/worksite/jobs/2026-11-19-solid-port')
folder('rg/worksite/archive/old')
folder('elsewhere/project')

test('includes find the folders with a .whiteboard/, excludes leave some out, each at its path', () => {
  assert.deepEqual(discover(config, { home }), [
    { entry: 'rg', group: 'develop', name: '', dir: path.join(home, 'rg/develop'), base: '/rg/develop' },
    {
      entry: 'rg',
      group: 'worktrees',
      name: 'cmux',
      dir: path.join(home, 'rg/develop/.claude/worktrees/cmux'),
      base: '/rg/worktrees/cmux',
    },
    {
      entry: 'rg',
      group: 'jobs',
      name: '2026-11-19-solid-port',
      dir: path.join(home, 'rg/worksite/jobs/2026-11-19-solid-port'),
      base: '/rg/jobs/2026-11-19-solid-port',
    },
  ])
})

test('a folder outside every include is no entry, and is told apart without globbing', () => {
  assert.equal(matchesEntries(config, path.join(home, 'elsewhere/project'), { home }), null)
  assert.equal(matchesEntries(config, path.join(home, 'rg/worksite/archive/old'), { home }), null)
  assert.equal(matchesEntries(config, path.join(home, 'rg/develop/.claude/worktrees/cmux'), { home }), 'rg')
  assert.ok(!discover(config, { home }).some(p => p.dir.includes('elsewhere')))
})

test('two folders wanting one path get -2', () => {
  folder('a/x/one')
  folder('b/x/one')
  const found = discover({ entries: { e: { include: ['~/a/x/*', '~/b/x/*'] } } }, { home })
  assert.deepEqual(
    found.map(p => [p.base, p.group, p.name]),
    [
      ['/e/x/one', 'x', 'one'],
      ['/e/x/one-2', 'x', 'one-2'],
    ],
  )
})

test('a folder appearing, or going, is seen on the next look', async () => {
  const seen: string[][] = []
  const f = followEntries(
    () => config,
    projects => seen.push(projects.map(p => p.base)),
    { home, interval: 60_000 },
  )
  assert.equal(seen.length, 1)
  const fresh = folder('rg/worksite/jobs/new-job')
  f.rescan()
  assert.ok(seen.at(-1)!.includes('/rg/jobs/new-job'))
  // a folder that loses its .whiteboard/ is no project any more, nor one removed
  fs.rmSync(fresh, { recursive: true })
  f.rescan()
  assert.ok(!seen.at(-1)!.includes('/rg/jobs/new-job'))
  // nothing changed: no call
  const n = seen.length
  f.rescan()
  assert.equal(seen.length, n)
  f.stop()
})

test('the machine config is checked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-machine-'))
  after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(readMachineConfig(dir), null)
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ port: 4800, entries: { rg: { include: ['~/rg/*'] } } }),
  )
  assert.deepEqual(readMachineConfig(dir), { port: 4800, entries: { rg: { include: ['~/rg/*'], exclude: [] } } })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ entries: { api: { include: [] } } }))
  assert.throws(() => readMachineConfig(dir), /entry name "api"/)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ entries: { rg: { include: 'x' } } }))
  assert.throws(() => readMachineConfig(dir), /list of globs/)
})

test("the entries' folders: each include up to its wildcard, none inside another", () => {
  assert.deepEqual(entryFolders(config, { home }), [
    path.join(home, 'rg/develop'),
    path.join(home, 'rg/worksite/archive'),
    path.join(home, 'rg/worksite/jobs'),
  ])
  assert.deepEqual(
    entryFolders({ entries: { a: { include: ['~/x/*/y', '~/x/z'] }, b: { include: ['~/w'] } } }, { home }),
    [path.join(home, 'w'), path.join(home, 'x')],
  )
})

test('a machine config that is there but cannot be read is an error, not no config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-machine-'))
  after(() => {
    fs.chmodSync(path.join(dir, 'config.json'), 0o644)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ entries: {} }))
  fs.chmodSync(path.join(dir, 'config.json'), 0)
  // as root everything is readable: nothing to check then
  if (process.getuid?.() === 0) return
  assert.throws(() => readMachineConfig(dir), /cannot read .*config\.json \(EACCES\): .*read grant for/)
})
