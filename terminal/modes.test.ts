// The mouse encoding a screen snapshot restores.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import xtermHeadless from '@xterm/headless'
import serializeAddon from '@xterm/addon-serialize'
import { followMouseEncoding } from './modes.ts'

const { Terminal } = xtermHeadless
const { SerializeAddon } = serializeAddon

/** A terminal, its serializer, the encoding it follows, and a way to write to it. */
function terminal() {
  const t = new Terminal({ cols: 40, rows: 5, allowProposedApi: true })
  const serializer = new SerializeAddon()
  t.loadAddon(serializer)
  const encoding = followMouseEncoding(t)
  const write = (d: string) => new Promise<void>(r => t.write(d, r))
  return { t, serializer, encoding, write }
}

test('the serializer alone leaves out the mouse encoding', async () => {
  const { serializer, write } = terminal()
  await write('\x1b[?1049h\x1b[?1003h\x1b[?1006h')
  const out = serializer.serialize()
  assert.ok(out.includes('?1003h'), 'mouse reporting is kept')
  assert.ok(!out.includes('?1006h'), 'the encoding is not: why followMouseEncoding exists')
})

test('a program asking for SGR mouse encoding gets it back in the snapshot', async () => {
  const { encoding, write } = terminal()
  assert.equal(encoding(), '')
  await write('\x1b[?1000h\x1b[?1006h')
  assert.equal(encoding(), '\x1b[?1006h')
})

test('several modes in one sequence, and turning the encoding off', async () => {
  const { encoding, write } = terminal()
  await write('\x1b[?1002;1015h')
  assert.equal(encoding(), '\x1b[?1015h')
  await write('\x1b[?1015l')
  assert.equal(encoding(), '')
})

test('the terminal still handles the sequences itself', async () => {
  const { t, write } = terminal()
  await write('\x1b[?1003h\x1b[?1006h')
  assert.equal(t.modes.mouseTrackingMode, 'any')
})

test('the restored snapshot gives a fresh terminal the same encoding', async () => {
  const source = terminal()
  await source.write('\x1b[?1049h\x1b[?1003h\x1b[?1006hhello')
  const copy = terminal()
  await copy.write(source.serializer.serialize() + source.encoding())
  assert.equal(copy.encoding(), '\x1b[?1006h')
  assert.equal(copy.t.modes.mouseTrackingMode, 'any')
})
