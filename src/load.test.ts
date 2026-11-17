// What the config loader imports afresh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importOwn } from './load.ts'

test('a part of the package loaded for a config comes afresh each time, so it reloads with it', async () => {
  const one = await importOwn('markboard')
  const two = await importOwn('markboard')
  assert.equal(typeof one.default, 'function')
  assert.notEqual(one, two, 'two loads are two module instances')
})

test('an unknown part is refused', () => {
  assert.throws(() => importOwn('nope'), /no part "nope"/)
})
