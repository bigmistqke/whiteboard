// Reminding the agent to wait again: `wait` says what is still unanswered when it hands out an
// answer, and the Claude Code Stop hook continues a turn once when nobody listens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { browser, project, until } from './project.ts'

const FORM = (name: string) => `:::form{name=${name}}\n:text[Why]{name=why}\n:::\n`

test(
  'wait: with the answer, what is still unanswered on the page and the command to wait again',
  { timeout: 60000 },
  async t => {
    const proj = await project({ pages: { p: `# Two\n\n${FORM('first')}\n${FORM('second')}` } })
    const { browser: b, page, errors } = await browser()
    t.after(async () => {
      await b.close()
      await proj.close()
    })
    const wait = proj.spawn('wait', '--page', 'p')
    let stderr = ''
    wait.stderr!.on('data', d => {
      stderr += d
    })
    await page.goto(proj.url('p'))
    await page.fill('form[name=first] input[name=why]', 'because')
    await page.click('form[name=first] button')
    const out = await until('the answer', () => wait.output())
    assert.equal(JSON.parse(out).type, 'first')
    // it may have exited already by the time the answer is read
    if (wait.exitCode === null) await new Promise(r => wait.on('exit', r))
    assert.match(stderr, /still unanswered on p: second → run `whiteboard wait --page \S*p\.md` again/)
    assert.deepEqual(errors, [])
  },
)

test(
  'the Stop hook: a turn ending with nobody listening goes on once, to start a wait; a continued one ends',
  { timeout: 60000 },
  async t => {
    const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
    const proj = await project({ config: CONFIG })
    t.after(() => proj.close())
    const session = 'session-1234'
    const file = proj.run(['new', 'mine'], { env: { CLAUDE_CODE_SESSION_ID: session } }).stdout.trim()
    assert.ok(file.endsWith('mine.md'), file)
    fs.writeFileSync(file, `# Mine\n\n${FORM('ask')}`)
    const stop = (active: boolean) =>
      proj.run(['claude-code', 'hook', 'stop'], {
        input: JSON.stringify({ session_id: session, stop_hook_active: active }),
      })

    const first = JSON.parse(stop(false).stdout)
    assert.equal(first.decision, 'block')
    assert.match(
      first.reason,
      /On your whiteboard page mine: nobody listens for ask\. Before ending your turn: run `whiteboard wait --page \S*mine\.md` in the background\./,
    )
    const again = JSON.parse(stop(true).stdout)
    assert.equal(again.decision, undefined, 'a turn the hook continued ends')
    assert.match(again.systemMessage, /mine: nobody listens for ask/)

    // with a wait on the page, nothing to say
    const wait = proj.spawn('wait', '--page', 'mine')
    await until('the wait listens', async () => !stop(false).stdout.trim() || null)

    // a chat where the reader wrote last: the turn goes on, to reply there
    fs.appendFileSync(
      path.join(proj.dir, '.whiteboard', 'events.ndjson'),
      JSON.stringify({ id: 'c1', ts: new Date().toISOString(), page: 'mine', type: 'chat:message', action: null, data: { chat: 'talk', text: '?' } }) + '\n',
    )
    const asked = JSON.parse(await until('the hook sees the chat', () => stop(false).stdout.trim() || null))
    assert.match(asked.reason, /reply in the chat talk/)
    wait.kill()
  },
)

test('claude-code uninstall: takes out only its own hooks; a file that held only them goes', { timeout: 60000 }, async t => {
  const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
  const proj = await project({ config: CONFIG })
  t.after(() => proj.close())
  const file = path.join(proj.dir, '.claude', 'settings.json')
  const settings = () => JSON.parse(fs.readFileSync(file, 'utf8'))
  proj.run(['claude-code', 'install'])
  assert.deepEqual(Object.keys(settings().hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.match(proj.run(['claude-code', 'uninstall']).stdout, /hooks removed from .*: Stop, UserPromptSubmit, SessionStart/)
  assert.equal(fs.existsSync(file), false, 'nothing else was in it')

  // with a hook and a setting of the project's own: those stay
  const own = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(own))
  proj.run(['claude-code', 'install'])
  proj.run(['claude-code', 'uninstall'])
  assert.deepEqual(settings(), own)
  assert.match(proj.run(['claude-code', 'uninstall']).stdout, /no whiteboard hooks in/)
})
