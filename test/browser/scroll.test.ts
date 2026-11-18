// `whiteboard scroll`: an agent shows the reader a place on a page they have open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const filler = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}.`).join('\n\n')
const PAGE = `# Scroll\n\n${filler(60, 'Top')}\n\n## The far heading\n\n${filler(60, 'Middle')}\n\n:::details[Closed details]\n${filler(20, 'Inside')}\n\nThe hidden sentence.\n:::\n\n${filler(40, 'Lower')}\n\n:::form{name=far-question}\n:text[Why]{name=why}\n:::\n\n${filler(20, 'End')}\n`

test('whiteboard scroll: to a heading, into a closed details, to a form; nothing matching or no tab open says so', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { s: PAGE, other: '# Other\n' } })
  const { browser: b, page, errors } = await browser()
  t.after(async () => { await b.close(); await proj.close() })
  await page.goto(proj.url('s'))
  await page.waitForSelector('h2')
  const inView = (sel: string) => page.locator(sel).first().evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight })

  assert.match(proj.cli('scroll', 's', 'the far heading'), /scrolled 1 tab of s/)
  await until('the heading in view', () => inView('h2') || null)

  proj.cli('scroll', 's', 'The hidden sentence')
  await until('the details opened, the sentence in view', async () => (await page.$eval('details', d => (d as HTMLDetailsElement).open)) && (await inView('text=The hidden sentence.')) || null)

  proj.cli('scroll', 's', 'far-question')
  await until('the form in view', () => inView('form[name=far-question]') || null)

  const fails = (...args: string[]) => {
    try { proj.cli(...args); return null } catch (err) { return String((err as { stderr?: Buffer }).stderr ?? err) }
  }
  assert.match(fails('scroll', 's', 'no such words anywhere') ?? '', /nothing on s matches/)
  assert.match(fails('scroll', 'other', 'Other') ?? '', /no browser has other open/)
  assert.deepEqual(errors, [])
})
