// The Claude Code channel (`whiteboard claude-code channel`): an MCP server a session starts, which
// pushes the reader's answers on the session's own pages into it, listens on those pages as a watch
// does, and marks an answer received only when the agent says so with its `received` tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { project, until, type Project } from './project.ts'

const CONFIG = `import claudeCode from '@bigmistqke/whiteboard/claude-code'\nexport default { plugins: [claudeCode()] }\n`
const FORM = '# P\n\n:::form{name=q}\n:radio[Pears]{name=fruit} :radio[Apples]{name=fruit}\n:::\n'

/** A page made by `session`, so it is that session's. */
function pageOf(proj: Project, session: string, name: string) {
  const file = proj.run(['new', name], { env: { CLAUDE_CODE_SESSION_ID: session } }).stdout.trim()
  fs.writeFileSync(file, FORM)
  return file
}

function answer(dir: string, page: string, id: string) {
  fs.appendFileSync(
    path.join(dir, '.whiteboard', 'events.ndjson'),
    JSON.stringify({ id, ts: new Date().toISOString(), page, type: 'q', action: 'Send', data: { fruit: 'Pears' } }) +
      '\n',
  )
}

/** Start the channel for `session`, past the handshake; what it sends, line by line. */
async function channel(proj: Project, session: string) {
  const child = proj.spawnWith({ CLAUDE_CODE_SESSION_ID: session }, 'claude-code', 'channel')
  const sent = () =>
    child
      .output()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
  const call = (msg: object) => child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
  const init = await until('initialized', () => sent().find(m => m.id === 1) ?? null)
  assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {} })
  call({ method: 'notifications/initialized' })
  return { sent, call }
}

const listeners = async (proj: Project, page: string) =>
  (await (await fetch(proj.url(`api/listeners?page=${page}`))).json()) as { command: string }[]

test(
  "the channel: listens on the session's pages, pushes their answers, marks one received when told",
  { timeout: 60000 },
  async t => {
    const proj = await project({ config: CONFIG })
    t.after(() => proj.close())
    pageOf(proj, 's1', 'mine')
    pageOf(proj, 's2', 'theirs')
    const ch = await channel(proj, 's1')

    await until('it listens on its page', async () => ((await listeners(proj, 'mine')).length === 1 ? true : null))
    assert.equal((await listeners(proj, 'theirs')).length, 0, "not on another session's page")

    answer(proj.dir, 'theirs', 'b1')
    answer(proj.dir, 'mine', 'a1')
    const note = await until('the answer pushed', () =>
      ch.sent().find(m => m.method === 'notifications/claude/channel' && m.params.meta.id === 'a1') ?? null,
    )
    assert.equal(note.params.content, 'form q: "Pears"')
    assert.deepEqual(note.params.meta, { page: 'mine', id: 'a1', type: 'q' })
    assert.ok(!ch.sent().some(m => m.params?.meta?.id === 'b1'), "another session's answer stays")
    const received = () => proj.events().some(e => e.type === 'whiteboard:received' && e.data.event === 'a1')
    assert.equal(received(), false, 'sending marks nothing')

    ch.call({ id: 2, method: 'tools/list' })
    const tools = await until('its tools', () => ch.sent().find(m => m.id === 2) ?? null)
    assert.deepEqual(
      tools.result.tools.map((x: { name: string }) => x.name),
      ['received'],
    )
    ch.call({ id: 3, method: 'tools/call', params: { name: 'received', arguments: { ids: ['a1'] } } })
    const reply = await until('the tool answers', () => ch.sent().find(m => m.id === 3) ?? null)
    assert.equal(reply.result.content[0].text, 'a1: received')
    assert.ok(received(), 'the agent said it has it')
  },
)

test('the channel leaves a page another wait holds to it, and says so in its log', { timeout: 60000 }, async t => {
  const proj = await project({ config: CONFIG })
  t.after(() => proj.close())
  const file = pageOf(proj, 's1', 'mine')
  const wait = proj.spawn('wait', '--page', file)
  await until('the wait listens', async () => ((await listeners(proj, 'mine')).length === 1 ? true : null))
  await channel(proj, 's1')
  const log = path.join(proj.dir, '.whiteboard', 'claude-code', 'channel.log')
  await until('the refusal logged', () =>
    fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('another wait holds the page') ? true : null,
  )
  answer(proj.dir, 'mine', 'a1')
  const out = await until('the wait got it', () => wait.output() || null)
  assert.equal(JSON.parse(out).id, 'a1')
})
