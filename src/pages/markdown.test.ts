import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formNames, renderMarkdown, parseAttrs } from './markdown.ts'

test('a code fence inside a container keeps its ::: lines, and the container stays open around it', async () => {
  const fences: string[] = []
  const code = {
    name: 'code',
    html: (ctx: { text: string }) => {
      fences.push(ctx.text)
      return `<pre>${ctx.text}</pre>`
    },
  } as any
  const md = ':::details[Example]\n```md\n:::callout\nhi\n:::\n```\n:::\n\nAfter.\n'
  const { html } = await renderMarkdown(md, {
    page: 'p',
    file: '',
    resolve: name =>
      name === 'details'
        ? ({ name, html: async (ctx: any) => `<details>${await ctx.toHtml(ctx.children)}</details>` } as any)
        : null,
    code,
  })
  assert.deepEqual(fences, [':::callout\nhi\n:::'], "the fence's text as written")
  assert.match(
    html,
    /^<details><pre>:::callout\nhi\n:::<\/pre><\/details>\n<p>After.<\/p>$/,
    'After. is outside the container',
  )
})

test('a form shown in a fence inside a container asks nothing; one after it does', () => {
  assert.deepEqual(
    formNames(':::details\n````md\n:::form{name=example}\n:::\n````\n:::\n\n:::form{name=real}\n:::\n'),
    ['real'],
  )
})

test('blocks that share a stylesheet link it once', async () => {
  const style = '/p/public/form.css'
  const block = (name: string) =>
    ({
      name,
      code: false,
      fences: false,
      props: null,
      html: () => '<i></i>',
      client: null,
      style,
      source: 'form',
    }) as any
  const { styles } = await renderMarkdown(':::one\n:::\n\n:::two\n:::\n', {
    page: 'p',
    file: '',
    resolve: name => block(name),
  })
  assert.deepEqual(styles, [style])
})

test('parseAttrs: a fence attributes, in braces too; an unquoted value ends at the closing brace', () => {
  assert.deepEqual(parseAttrs('cols=3 open title="a b"'), { cols: '3', open: '', title: 'a b' })
  assert.deepEqual(parseAttrs('{compose=window}'), { compose: 'window' })
  assert.deepEqual(parseAttrs('{compose=lightbox,window title="A b"}'), { compose: 'lightbox,window', title: 'A b' })
})

test('items: a heading at the shallowest level, or a ---, starts one; content with neither is one', async () => {
  let got: any[] = []
  const block = (name: string) =>
    ({
      name,
      code: false,
      fences: false,
      props: null,
      html: async (ctx: any) => {
        got = (await ctx.items()).map((i: any) => [i.text, i.key, i.html.replace(/\s+/g, ' ').trim()])
        return '<i></i>'
      },
      open: null,
      client: null,
      style: null,
      source: 'test',
    }) as any
  const items = async (body: string) => {
    await renderMarkdown(`:::list\n${body}\n:::\n`, { page: 'p', file: '', resolve: block })
    return got
  }
  assert.deepEqual(
    await items('Before.\n\n### One\nA.\n\n#### Deeper\nStill one.\n\n### Two\nB.\n\n---\n\nAfter a rule.'),
    [
      [null, '1', '<p>Before.</p>'],
      ['One', 'one', '<p>A.</p> <h4>Deeper</h4> <p>Still one.</p>'],
      ['Two', 'two', '<p>B.</p>'],
      [null, '4', '<p>After a rule.</p>'],
    ],
    'what comes before the first heading is an untitled item; deeper headings stay inside',
  )
  assert.deepEqual(await items('One.\n\n---\n\nTwo.\n\nStill two.'), [
    [null, '1', '<p>One.</p>'],
    [null, '2', '<p>Two.</p> <p>Still two.</p>'],
  ])
  assert.deepEqual(
    await items('Just this.\n\nAnd this.'),
    [[null, '1', '<p>Just this.</p> <p>And this.</p>']],
    'neither: one item',
  )
  assert.deepEqual(
    (await items('### Same\na\n\n---\n\n### Same\nb')).map(i => i[1]),
    ['same', 'same-2'],
    'a --- right before a heading starts no empty item; keys stay apart',
  )
})
