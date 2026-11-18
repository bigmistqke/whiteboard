import { test } from 'node:test'
import assert from 'node:assert/strict'
import { split } from './index.ts'

const h = (depth: number, text: string) => ({ type: 'heading', depth, children: [{ type: 'text', value: text }] })
const p = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] })
const titles = (parts: ReturnType<typeof split>) =>
  parts.map(x => [x.title?.map((c: any) => c.value).join('') ?? null, x.body.length])

test('steps: an item per heading at the shallowest level; deeper headings stay in their item', () => {
  assert.deepEqual(titles(split([h(3, 'A'), p('a'), h(4, 'detail'), p('b'), h(3, 'B'), p('c')])), [
    ['A', 3],
    ['B', 1],
  ])
})

test('steps: what comes before the first heading is an item of its own', () => {
  assert.deepEqual(titles(split([p('intro'), h(3, 'A'), p('a')])), [
    [null, 1],
    ['A', 1],
  ])
})

test('steps: without headings, --- separates the items; without either, it is one', () => {
  const rule = { type: 'thematicBreak' }
  assert.deepEqual(titles(split([p('one'), rule, p('two'), p('more'), rule, p('three')])), [
    [null, 1],
    [null, 2],
    [null, 1],
  ])
  assert.deepEqual(titles(split([p('alone')])), [[null, 1]])
  assert.deepEqual(titles(split([])), [[null, 0]])
})
