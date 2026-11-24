// The fallback (a `wait` or `watch` without --page): what no other wait or watch would take, and
// only one per project.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browser, project, until } from './project.ts'

const form = (name: string) => `# ${name}\n\n:::form{name=${name}-q}\n:text[Note]{name=note}\n:::\n`

test(
  'the fallback takes answers on pages nobody waits on, leaves the others, and a second one is refused',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { a: form('a'), b: form('b') } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    const listeners = async () =>
      (await fetch(proj.url('api/listeners'))).json() as Promise<{ page: string; fallback?: boolean }[]>

    const fallback = proj.spawn('watch')
    await until('the fallback listens', async () => (await listeners()).some(l => l.fallback) || null)

    // a second one exits, saying why
    const second = proj.spawn('watch')
    let stderr = ''
    second.stderr!.on('data', d => {
      stderr += d
    })
    const code = await new Promise<number | null>(resolve => second.on('exit', resolve))
    assert.equal(code, 1)
    assert.match(stderr, /another agent already takes what no other listener does/)

    const wait = proj.spawn('wait', '--page', 'a')
    await until('the wait on a listens', async () => (await listeners()).some(l => l.page === 'a') || null)

    // nobody waits on b: the fallback takes it, and the page says so
    await page.goto(proj.url('b'))
    await page.waitForSelector('form[name=b-q][data-wb-open]', { timeout: 5000 })
    await until(
      'the dot: the project-wide listener',
      () =>
        page.$eval(
          '.wb-live',
          d => d.hasAttribute('data-agent') && d.getAttribute('title') === 'Live · an agent is listening on every page',
        ) || null,
    )
    await page.fill('input[name=note]', 'for whoever')
    await page.click('form[name=b-q] button')
    await until('the fallback got b', () => fallback.output().includes('"page":"b"') || null)
    assert.match((await page.locator('[data-toast=sent]').textContent())!, /the fallback agent receives it/)

    // a waits on its own wait: the fallback leaves it
    await page.goto(proj.url('a'))
    await page.waitForSelector('form[name=a-q][data-wb-open]')
    await page.fill('input[name=note]', 'for the wait')
    await page.click('form[name=a-q] button')
    await until('the wait on a got it', () => wait.output() || null)
    await new Promise(r => setTimeout(r, 500))
    assert.ok(!fallback.output().includes('"page":"a"'), 'the fallback left a to its wait')

    // with the wait gone, a is the fallback's too; its agent acted on the answer (whiteboard handled)
    await until('the wait ended', async () => !(await listeners()).some(l => l.page === 'a') || null)
    proj.cli('handled', JSON.parse(wait.output()).id)
    // decided, the form folded: a click opens it again to answer anew
    await page.click('form[name=a-q][data-wb-folded]', { position: { x: 20, y: 12 } })
    await page.fill('input[name=note]', 'again')
    await page.click('form[name=a-q] button')
    await until('the fallback got a', () => fallback.output().includes('"page":"a"') || null)
    assert.deepEqual(errors, [])
  },
)
