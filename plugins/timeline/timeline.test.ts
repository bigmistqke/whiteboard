import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, when } from './index.ts'

const heading = (depth: number, value: string) => ({ type: 'heading', depth, children: [{ type: 'text', value }] })
const para = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', value }] })
const titles = (sections: ReturnType<typeof parse>) =>
  sections.map(s => ({
    section: s.title?.map(n => n.value).join('') ?? null,
    steps: s.steps.map(step => step.title?.map(n => n.value).join('') ?? null),
  }))

test('timeline: one heading level, every heading a step; content before it an untitled one', () => {
  assert.deepEqual(titles(parse([para('intro'), heading(3, 'A'), para('a'), { type: 'thematicBreak' }, para('b')])), [
    { section: null, steps: [null, 'A', null] },
  ])
})

test('timeline: two heading levels, the shallower groups the steps into sections', () => {
  assert.deepEqual(
    titles(parse([heading(2, 'One'), heading(3, 'A'), heading(3, 'B'), heading(2, 'Two'), heading(3, 'C')])),
    [
      { section: 'One', steps: ['A', 'B'] },
      { section: 'Two', steps: ['C'] },
    ],
  )
})

test('timeline: a :when in a heading comes out of the title, a time written with colons as written', () => {
  const title = [
    {
      type: 'textDirective',
      name: 'when',
      children: [
        { type: 'text', value: '2026-11-21 10' },
        { type: 'textDirective', name: '43' },
      ],
    },
    { type: 'text', value: ' Made a repro' },
  ]
  const split = when(title)
  assert.equal(split.when, '2026-11-21 10:43')
  assert.deepEqual(split.title, [{ type: 'text', value: 'Made a repro' }])
})
