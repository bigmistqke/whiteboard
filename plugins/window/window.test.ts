import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openOf } from './index.ts'

test('window: what it opens on its own is the file of one image or video, its only content', () => {
  const img = { type: 'image', url: 'shot.png' }
  assert.equal(openOf([{ type: 'paragraph', children: [img] }]), 'shot.png')
  assert.equal(openOf([{ type: 'html', value: '<video src="demo.mp4" controls></video>' }]), 'demo.mp4')
  assert.equal(
    openOf([{ type: 'paragraph', children: [img, { type: 'text', value: ' and words' }] }]),
    null,
    'an image with words: nothing on its own',
  )
  assert.equal(
    openOf([
      { type: 'paragraph', children: [img] },
      { type: 'paragraph', children: [img] },
    ]),
    null,
    'two images',
  )
  assert.equal(openOf([{ type: 'code', value: 'graph LR' }]), null, 'a diagram')
})
