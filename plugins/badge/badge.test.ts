import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, tone } from './index.ts'

test('badge: its text picks its colour, lowercased, other characters a dash', () => {
  assert.equal(tone('Done'), 'done')
  assert.equal(tone(' in review! '), 'in-review')
})

test('badge: a span with the label, and nothing without one', () => {
  const ctx = (label: string | null) => ({ kind: 'textDirective', label, labelText: label }) as any
  assert.equal(String(render(ctx('Done'))), '<span class="wb-badge" data-badge="done">Done</span>')
  assert.equal(String(render(ctx(null))), '')
  assert.equal(String(render(ctx('  '))), '')
})
