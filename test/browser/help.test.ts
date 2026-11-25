// `whiteboard <command> --help`: every command, built in or a plugin's, says what it takes and does,
// and does nothing else. A wait asked about never hands an answer out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { project } from './project.ts'
import { BUILTIN_COMMANDS } from '../../src/loader.ts'

test('--help on any command prints its help and runs nothing', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { p: '# P\n\n:::form{name=q}\n:button[Go]\n:::\n' } })
  t.after(() => proj.close())
  // an answer from the reader, waiting to be received
  fs.appendFileSync(
    path.join(proj.dir, '.whiteboard', 'events.ndjson'),
    JSON.stringify({ id: 'a1', ts: new Date().toISOString(), page: 'p', type: 'q', action: 'Go', data: {} }) + '\n',
  )

  for (const name of BUILTIN_COMMANDS) {
    if (name === 'help') continue
    assert.match(proj.cli(name, '--help'), new RegExp(`^usage: whiteboard ${name}\\b`), name)
  }
  assert.match(proj.cli('wait', '--page', 'p', '-h'), /^usage: whiteboard wait/)
  assert.ok(!proj.events().some(e => e.type === 'whiteboard:handled'), 'nothing received: the answer still waits')

  // a plugin's command, and all of a plugin's commands
  assert.match(proj.cli('chat', 'prune', '--help'), /^usage: whiteboard chat prune <page\|file> <chat>/)
  assert.match(proj.cli('chat', '--help'), /whiteboard chat prune/)
  // as `help <command>`
  assert.match(proj.cli('help', 'prune'), /^usage: whiteboard prune/)
  assert.match(proj.cli('help', 'chat', 'prune'), /^usage: whiteboard chat prune/)
})

test('--version prints the version that runs, and nothing else, also outside a project', () => {
  const cli = new URL('../../bin/whiteboard.ts', import.meta.url).pathname
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  for (const flag of ['--version', '-v']) {
    const out = spawnSync(process.execPath, [cli, flag], {
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'wb-version-')),
      encoding: 'utf8',
    })
    assert.equal(out.status, 0)
    assert.equal(out.stdout, `${version}\n`)
  }
})
