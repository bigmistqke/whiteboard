import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, renderWhen, when } from './index.ts'

const heading = (depth: number, value: string) => ({ type: 'heading', depth, children: [{ type: 'text', value }] })
const para = (value: string) => ({ type: 'paragraph', children: [{ type: 'text', value }] })
const titles = (steps: ReturnType<typeof parse>) => steps.map(step => step.title?.map(n => n.value).join('') ?? null)

test('timeline: the shallowest headings are the steps; content before them an untitled one, `---` another', () => {
  assert.deepEqual(titles(parse([para('intro'), heading(3, 'A'), para('a'), { type: 'thematicBreak' }, para('b')])), [
    null,
    'A',
    null,
  ])
})

test("timeline: deeper headings are a step's own, part of its body, at any level", () => {
  const steps = parse([heading(4, '5a'), heading(5, 'What it does'), para('a'), heading(6, 'Detail'), heading(4, '5b')])
  assert.deepEqual(titles(steps), ['5a', '5b'])
  assert.deepEqual(steps[0].body, [heading(5, 'What it does'), para('a'), heading(6, 'Detail')])
})

test('timeline: no headings, one untitled step', () => {
  assert.deepEqual(titles(parse([para('just text')])), [null])
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

test('timeline: a :when in any other heading renders as a time, written with colons as written', () => {
  const node = {
    type: 'textDirective',
    name: 'when',
    children: [{ type: 'text', value: '2026-11-24 19' }, { type: 'textDirective', name: '59' }],
  }
  assert.equal(String(renderWhen({ node, children: [] } as any)), '<time class="wb-when">2026-11-24 19:59</time>')
})
