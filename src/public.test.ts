import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { inPublic, publicDirOf } from './public.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

test('definePlugin: a plugin without public has public/ next to the module that called it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-public-'))
  dirs.push(dir)
  const define = pathToFileURL(fileURLToPath(new URL('./define.ts', import.meta.url))).href
  fs.writeFileSync(path.join(dir, 'plugin.ts'), `import { definePlugin } from ${JSON.stringify(define)}\nexport default definePlugin({ name: 'p' })\n`)
  const plugin = (await import(pathToFileURL(path.join(dir, 'plugin.ts')).href)).default
  // the module as Node knows it: its real path (a temporary folder can sit behind a symlink)
  assert.equal(publicDirOf(plugin, '/project/.whiteboard'), path.join(fs.realpathSync(dir), 'public'))
  assert.equal(publicDirOf({ name: 'inline' }, '/project/.whiteboard'), '/project/.whiteboard/public', 'a plain object: the project\'s')
  assert.equal(publicDirOf({ name: 'said', public: '/elsewhere/assets' }, '/w'), '/elsewhere/assets', 'one it says')
})

test('inPublic: a name in the folder, or a URL or path inside it; anything outside is an error', () => {
  assert.equal(inPublic('/p/public', 'style.css', 'x'), '/p/public/style.css')
  assert.equal(inPublic('/p/public', 'sub/client.js', 'x'), '/p/public/sub/client.js')
  assert.equal(inPublic('/p/public', new URL('file:///p/public/a.css'), 'x'), '/p/public/a.css')
  assert.throws(() => inPublic('/p/public', '../index.ts', 'plugin p: client'), /plugin p: client: \/p\/index\.ts is not in its public folder/)
  assert.throws(() => inPublic('/p/public', '/p/public', 'x'), /not in its public folder/, 'the folder itself is no file')
  assert.throws(() => inPublic('/p/public', new URL('file:///p/publicity/a.css'), 'x'), /not in its public folder/, 'a folder that only starts the same')
})
