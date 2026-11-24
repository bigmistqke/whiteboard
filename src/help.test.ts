import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_COMMANDS } from './loader.ts'
import { COMMAND_HELP, commandHelp, commandList } from './help.ts'

test('every built-in command has its help, and the overview lists each', () => {
  for (const name of BUILTIN_COMMANDS) {
    assert.ok(COMMAND_HELP[name], `${name} has no help`)
    assert.match(commandHelp(name), new RegExp(`^usage: whiteboard ${name}\\b`))
    assert.match(commandList(), new RegExp(`whiteboard ${name}\\b`))
  }
  assert.deepEqual(Object.keys(COMMAND_HELP).sort(), [...BUILTIN_COMMANDS].sort(), 'no help for a command that is gone')
})
