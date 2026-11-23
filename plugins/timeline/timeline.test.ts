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

const tree = (steps: ReturnType<typeof parse>[number]['steps']): unknown[] =>
  steps.map(step => {
    const title = step.title?.map(n => n.value).join('') ?? null
    return step.steps.length ? { [String(title)]: tree(step.steps) } : title
  })

test('timeline: each level below the steps is sub steps inside a step, to any depth', () => {
  const sections = parse([
    heading(2, 'One'),
    heading(3, 'A'),
    para('before its sub steps: its body'),
    heading(4, 'A1'),
    heading(5, 'A1x'),
    heading(5, 'A1y'),
    para('after A1y: in A1y'),
    heading(4, 'A2'),
    heading(3, 'B'),
    heading(5, 'B skips a level'),
  ])
  assert.deepEqual(tree(sections[0].steps), [{ A: [{ A1: ['A1x', 'A1y'] }, 'A2'] }, 'B'])
  const [a] = sections[0].steps
  assert.deepEqual(a.body, [para('before its sub steps: its body')])
  assert.deepEqual(a.steps[0].steps[1].body, [para('after A1y: in A1y')])
  // a level the step doesn't use first is ordinary content of its body
  assert.deepEqual(sections[0].steps[1].body, [heading(5, 'B skips a level')])
})
