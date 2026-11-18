import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formNames, renderMarkdown } from './markdown.ts'

test('a code fence inside a container keeps its ::: lines, and the container stays open around it', async () => {
  const fences: string[] = []
  const code = { name: 'code', html: (ctx: { text: string }) => { fences.push(ctx.text); return `<pre>${ctx.text}</pre>` } } as any
  const md = ':::details[Example]\n```md\n:::callout\nhi\n:::\n```\n:::\n\nAfter.\n'
  const { html } = await renderMarkdown(md, { page: 'p', file: '', resolve: name => (name === 'details' ? { name, html: async (ctx: any) => `<details>${await ctx.toHtml(ctx.children)}</details>` } as any : null), code })
  assert.deepEqual(fences, [':::callout\nhi\n:::'], 'the fence\'s text as written')
  assert.match(html, /^<details><pre>:::callout\nhi\n:::<\/pre><\/details>\n<p>After.<\/p>$/, 'After. is outside the container')
})

test('a form shown in a fence inside a container asks nothing; one after it does', () => {
  assert.deepEqual(formNames(':::details\n````md\n:::form{name=example}\n:::\n````\n:::\n\n:::form{name=real}\n:::\n'), ['real'])
})


test('blocks that share a stylesheet link it once', async () => {
  const style = '/p/public/form.css'
  const block = (name: string) => ({ name, code: false, fences: false, props: null, html: () => '<i></i>', client: null, style, source: 'form' }) as any
  const { styles } = await renderMarkdown(':::one\n:::\n\n:::two\n:::\n', { page: 'p', file: '', resolve: name => block(name) })
  assert.deepEqual(styles, [style])
})
