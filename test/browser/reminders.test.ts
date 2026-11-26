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
      JSON.stringify({
        id: 'c1',
        ts: new Date().toISOString(),
        page: 'mine',
        type: 'chat:message',
        action: null,
        data: { chat: 'talk', text: '?' },
      }) + '\n',
    )
    const asked = JSON.parse(await until('the hook sees the chat', () => stop(false).stdout.trim() || null))
    assert.match(asked.reason, /reply in the chat talk/)
    wait.kill()
  },
)

test('the Stop hook: several pages nobody listens on get one wait for all of them', { timeout: 60000 }, async t => {
  const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
  const proj = await project({ config: CONFIG })
  t.after(() => proj.close())
  const session = 'session-5678'
  for (const name of ['one', 'two']) {
    const file = proj.run(['new', name], { env: { CLAUDE_CODE_SESSION_ID: session } }).stdout.trim()
    fs.writeFileSync(file, `# ${name}\n\n${FORM('ask')}`)
  }
  const stop = proj.run(['claude-code', 'hook', 'stop'], {
    input: JSON.stringify({ session_id: session, stop_hook_active: false }),
  })
  const { reason } = JSON.parse(stop.stdout)
  const one = reason.match(/run one wait for these pages in the background: `whiteboard wait ((?:--page \S+ ?)+)`/)
  assert.ok(one, reason)
  assert.deepEqual(
    one[1]
      .trim()
      .split(' --page ')
      .map((p: string) => p.replace('--page ', '').split('/').pop())
      .sort(),
    ['one.md', 'two.md'],
  )
  assert.doesNotMatch(reason, /run `whiteboard wait --page \S*\.md` in the background/, 'not a wait each')
})

test(
  'claude-code install and uninstall: the channel and the reminders, or one of them; nothing else',
  { timeout: 60000 },
  async t => {
    const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
    const proj = await project({ config: CONFIG })
    t.after(() => proj.close())
    const settingsFile = path.join(proj.dir, '.claude', 'settings.json')
    const mcpFile = path.join(proj.dir, '.mcp.json')
    const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
    /** Our hooks' modes, per event. */
    const ourHooks = () =>
      Object.fromEntries(
        Object.entries(read(settingsFile).hooks ?? {}).map(([event, groups]) => [
          event,
          (groups as { hooks: { command: string }[] }[])
            .flatMap(g => g.hooks.map(h => h.command))
            .filter(c => c.includes('claude-code hook'))
            .map(c => c.split(' ').at(-1)),
        ]),
      )

    proj.run(['claude-code', 'install'])
    assert.deepEqual(ourHooks(), { SessionStart: ['channel', 'session'], Stop: ['stop'], UserPromptSubmit: ['prompt'] })
    assert.deepEqual(read(mcpFile).mcpServers.whiteboard.args.slice(-2), ['claude-code', 'channel'])
    assert.match(
      proj.run(['claude-code', 'uninstall', 'reminders']).stdout,
      /reminders hooks removed from .*: SessionStart, Stop, UserPromptSubmit/,
    )
    assert.deepEqual(ourHooks(), { SessionStart: ['channel'] }, "the channel's hook stays")
    assert.match(proj.run(['claude-code', 'uninstall', 'channel']).stdout, /channel removed from/)
    assert.equal(fs.existsSync(mcpFile), false)
    assert.equal(fs.existsSync(settingsFile), false, 'nothing else was in it')

    // the channel alone: its server and its one silent hook
    proj.run(['claude-code', 'install', 'channel'])
    assert.deepEqual(ourHooks(), { SessionStart: ['channel'] })
    assert.match(proj.run(['claude-code', 'install', 'channel']).stdout, /channel hooks already installed/)
    proj.run(['claude-code', 'uninstall'])

    // with a hook, a setting and a server of the project's own: those stay
    const own = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }
    const servers = { mcpServers: { other: { command: 'other-server' } } }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify(own))
    fs.writeFileSync(mcpFile, JSON.stringify(servers))
    proj.run(['claude-code', 'install', 'reminders'])
    assert.ok(!read(mcpFile).mcpServers.whiteboard, 'install reminders leaves the servers alone')
    proj.run(['claude-code', 'install'])
    proj.run(['claude-code', 'uninstall'])
    assert.deepEqual(read(settingsFile), own)
    assert.deepEqual(read(mcpFile), servers)
    assert.match(
      proj.run(['claude-code', 'uninstall']).stdout,
      /no whiteboard channel in .*\nno whiteboard channel hooks in .*\nno whiteboard reminders hooks in/,
    )
    assert.equal(proj.run(['claude-code', 'install', 'hooks']).status, 1)
  },
)

test('hook channel: records the session for the channel and says nothing', { timeout: 60000 }, async t => {
  const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
  const proj = await project({ config: CONFIG })
  t.after(() => proj.close())
  const file = proj.run(['new', 'mine'], { env: { CLAUDE_CODE_SESSION_ID: 's1' } }).stdout.trim()
  fs.writeFileSync(file, '# P\n\n:::form{name=q}\n:radio[Pears]{name=fruit}\n:::\n')
  const input = JSON.stringify({ session_id: 's1' })
  assert.notEqual(proj.run(['claude-code', 'hook', 'session'], { input }).stdout, '', 'session reports the open form')
  const r = proj.run(['claude-code', 'hook', 'channel'], { input })
  assert.equal(r.status, 0)
  assert.equal(r.stdout + r.stderr, '')
  const dir = path.join(proj.dir, '.whiteboard', 'claude-code', 'sessions')
  assert.deepEqual(
    fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')),
    ['s1'],
  )
})

test(
  'claim: an existing page made this session’s; again, or by another session, says so',
  { timeout: 60000 },
  async t => {
    const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
    const proj = await project({ config: CONFIG, pages: { board: `# Board\n\n${FORM('ask')}` } })
    t.after(() => proj.close())
    const claim = (session: string | null, page = 'board') =>
      proj.run(['claim', page], { env: session ? { CLAUDE_CODE_SESSION_ID: session } : { CLAUDE_CODE_SESSION_ID: '' } })

    assert.match(claim('first').stdout, /^claimed board for this session\n$/)
    assert.match(proj.run(['status'], { env: { CLAUDE_CODE_SESSION_ID: 'first' } }).stdout, /board \(yours\)/)
    assert.match(claim('first').stdout, /board is this session's already/)
    assert.match(claim('second').stdout, /claimed board for this session \(it was session first's\)/)
    assert.match(proj.run(['status'], { env: { CLAUDE_CODE_SESSION_ID: 'second' } }).stdout, /board \(yours\)/)

    const none = claim('second', 'nothing')
    assert.equal(none.status, 1)
    assert.match(none.stderr, /there is no page nothing/)
    const outside = claim(null)
    assert.equal(outside.status, 1)
    assert.match(outside.stderr, /no session to claim it for/)
  },
)
