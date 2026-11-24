// Optimistic: an answer is the form's at once, marked as still on its way (sending), whatever the
// server takes; confirmed once it has it. One that never gets there leaves the form again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { browser, project, until } from './project.ts'

const PAGE = `# Test

:::form{name=pick}
- :radio[Apples]{name=fruit}
- :radio[Pears]{name=fruit}
:::

:::chat{name=talk}
:::
`

test('a slow send shows at once as sending, then sent; one that fails is taken back', { timeout: 60000 }, async t => {
  const proj = await project({ pages: { q: PAGE } })
  const { browser: b, page } = await browser()
  t.after(async () => {
    await b.close()
    await proj.close()
  })
  // no log until the first event
  const log = () => {
    try {
      return fs.readFileSync(path.join(proj.dir, '.whiteboard', 'events.ndjson'), 'utf8')
    } catch {
      return ''
    }
  }
  const form = () =>
    page.$eval('form[name=pick]', f => ({
      state: f.getAttribute('data-wb-state'),
      pending: f.hasAttribute('data-wb-pending'),
      open: f.hasAttribute('data-wb-open'),
      // what it came to, beside the send button
      label: f.querySelector('.wb-form-status')?.textContent ?? null,
      beside: f.querySelector('.wb-form-status')?.previousElementSibling === f.querySelector('button'),
      // the button it was sent with: what it says, and its colour
      button: f.querySelector('button')!.textContent,
      send: f.querySelector('button')!.getAttribute('data-wb-send'),
      fill: getComputedStyle(f.querySelector('button')!).backgroundColor,
      // the ring around it (::before; transparent: none)
      outline: (c => (c === 'rgba(0, 0, 0, 0)' ? null : c))(getComputedStyle(f, '::before').borderTopColor),
    }))
  const color = (name: string) =>
    page.evaluate(name => {
      const probe = document.body.appendChild(document.createElement('i'))
      probe.style.color = `var(${name})`
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }, name)

  // a server that takes its time
  let release!: () => void
  const held = new Promise<void>(r => (release = r))
  await page.route('**/api/events', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    await held
    return route.continue()
  })
  await page.goto(proj.url('q'))
  await page.waitForSelector('form[name=pick][data-wb-open]')
  await page.check('input[value=Pears]')
  await page.click('form[name=pick] button')
  // at once, before the server answered: answered here, and saying it is still on its way
  const now = await form()
  assert.equal(now.state, 'sending')
  assert.equal(now.pending, true, 'the answer is the form’s already')
  // the button it was sent with says so, in grey; no line of its own above the form
  assert.equal(now.button, 'Sending…')
  assert.equal(now.send, 'sending')
  await until('grey', async () => (await form()).fill === (await color('--wb-sending')) || null)
  assert.equal(now.label, null, 'nothing beside it while the button says it')
  // its outline grey, as its button
  await until('a grey outline', async () => (await form()).outline === (await color('--wb-sending')) || null)
  assert.doesNotMatch(log(), /Pears/, 'the server has nothing yet')
  release()
  await until('confirmed', async () => (await form()).state === 'sent' || null)
  assert.equal((await form()).button, '✓ Sent')
  await until('green', async () => (await form()).fill === (await color('--ok')) || null)
  assert.equal((await form()).label, 'waiting for an agent to receive it', 'not "sent" again')
  assert.equal((await form()).beside, true, 'beside the send button, where the eye is')
  // confirmed, waiting for an agent to receive it: still grey
  assert.equal((await form()).outline, await color('--wb-sending'), 'pending: a grey outline')
  // then the button is itself again
  await until('its own label', async () => ((await form()).button === 'Send' && !(await form()).send) || null)
  assert.equal(log().match(/Pears/g)?.length, 1, 'appended once')

  // a server that never takes it: shown at once, then taken back
  await page.unroute('**/api/events')
  await page.route('**/api/events', route => (route.request().method() === 'POST' ? route.abort() : route.continue()))
  await page.check('input[value=Apples]')
  await page.click('form[name=pick] button')
  assert.equal((await form()).state, 'sending')
  await until('failed', async () => (await form()).state === 'failed' || null, 20000)
  assert.equal((await form()).button, 'Try again')
  assert.equal((await form()).send, 'failed')
  assert.equal((await form()).pending, true, 'back to the answer the server has')
  // and it says so, over the line of the answer the server has
  assert.equal((await form()).label, "couldn't send it")
  await until('a red outline', async () => (await form()).outline === (await color('--bad')) || null)
  assert.doesNotMatch(log(), /Apples/)
  assert.equal(await page.isChecked('input[value=Apples]'), true, 'what was chosen stays, to send again')

  // a chat message: in the chat at once, grey, the box empty; a second Send has nothing to send
  await page.unroute('**/api/events')
  let let_go!: () => void
  const chatHeld = new Promise<void>(r => (let_go = r))
  await page.route('**/api/events', async route => {
    if (route.request().method() === 'POST') await chatHeld
    return route.continue()
  })
  const chat = page.locator('.wb-chat').last()
  await chat.locator('textarea').fill('is it ripe?')
  await chat.locator('button').click()
  await chat.locator('button').click()
  const bubble = chat.locator('.wb-chat-message[data-from=you]')
  await bubble.waitFor()
  assert.equal(await chat.locator('textarea').inputValue(), '', 'the box is empty at once')
  assert.equal(await bubble.getAttribute('data-sending'), '')
  assert.equal(await bubble.locator('.wb-chat-who').textContent(), 'you', 'no "sending…" label')
  // grey while it is on its way; waited for, as the other colours are: the chat draws the bubble
  // again as the message comes in, and one read of an element it just replaced reads as nothing
  const grey = await color('--wb-sending')
  await until(
    'a grey bubble',
    async () =>
      (await bubble.locator('.wb-chat-bubble').evaluate(b => getComputedStyle(b).backgroundColor)) === grey || null,
  )
  let_go()
  await bubble.and(page.locator(':not([data-sending])')).waitFor()
  assert.equal(log().match(/is it ripe/g)?.length, 1, 'posted once')
  assert.equal(await bubble.count(), 1)
})
