// Whiteboard as a Claude Code channel: an MCP server (stdio) that Claude Code starts with each
// session, `whiteboard claude-code channel`. It pushes the reader's answers on the session's own
// pages into the session (`notifications/claude/channel`), so the agent needs no wait. Channels are
// a research preview: a session loads it only when started with
//
//   claude --dangerously-load-development-channels server:whiteboard
//
// and the server registered in `.mcp.json` (`whiteboard claude-code install`) or for the user
// (`claude mcp add --scope user whiteboard -- whiteboard claude-code channel`).
//
// The session is the one the hooks last recorded for this claude process (session.ts), else
// `CLAUDE_CODE_SESSION_ID`, read again every round: a resume switches it after start. Its pages are those it claimed with `whiteboard new`,
// also later ones. For each, the channel holds a listener at the server, as a `watch` does, and
// hands out the reader's answers there without marking them: Claude Code doesn't tell a server
// whether it loaded it as a channel, so a send proves nothing. The agent marks an answer received
// with the channel's `received` tool as it starts on it; until then the page and the hooks show it
// as not received. Problems (a page another wait holds, a hand-out that failed) go to
// `.whiteboard/claude-code/channel.log`; normal work leaves no trace.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { CommandContext, WbEvent } from '../../src/define.ts'
import { read, receive, receivedIds } from '../../src/events.ts'
import { claudeProcess, recordedSession } from './session.ts'

const INSTRUCTIONS = [
  'Messages from whiteboard arrive as <channel source="whiteboard" page="…" id="…">: the reader answered on one of your whiteboard pages (a form, a chat message, a comment).',
  'When you start on one, call the `received` tool with its id: that tells the reader you have it, and their form folds (a message can get lost on the way, so until then the page shows it as not received).',
  'Act on it as on an answer from `whiteboard wait`. Then handle it: reply in its chat (`whiteboard append`), or `whiteboard handled <id>`.',
  'You do not need to run `whiteboard wait` on pages this channel covers.',
].join(' ')

/** The tool the agent confirms with that a message reached it. */
const RECEIVED = {
  name: 'received',
  description:
    'Tell the reader you received whiteboard answers and are on them: marks each as received. Call it as you start on a <channel source="whiteboard"> message.',
  inputSchema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' }, description: 'the ids from the messages' } },
    required: ['ids'],
  },
}

/** One line per answer: what the reader did, in words. */
export function describe(e: WbEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>
  if (e.type === 'chat:message') return `chat ${d.chat}: "${d.text}"`
  if (e.type === 'comments:new') return `comment on "${d.quote ?? d.at ?? ''}": "${d.text}"`
  // what was chosen or written; the button only when it is the answer itself (no fields)
  const fields = Object.entries(d).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
  const said = fields.map(([k, v]) => (fields.length === 1 ? JSON.stringify(v) : `${k}: ${JSON.stringify(v)}`))
  if (said.length) return `form ${e.type}: ${said.join(', ')}`
  return `form ${e.type}: clicked ${e.action ?? 'send'}`
}

export async function channel(ctx: CommandContext) {
  const problem = (what: string, data?: unknown) => {
    fs.mkdirSync(ctx.dataDir, { recursive: true })
    fs.appendFileSync(
      path.join(ctx.dataDir, 'channel.log'),
      `${new Date().toISOString()} ${what}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`,
    )
  }
  const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

  const claude = claudeProcess()
  const started = process.env.CLAUDE_CODE_SESSION_ID || null
  let session: string | null = null
  /** The conversation now, and a line in the log when it changed after start (a resume). */
  const current = () => {
    const now = recordedSession(ctx.dataDir, claude) ?? started
    if (now !== session) {
      if (!now) problem('no CLAUDE_CODE_SESSION_ID: no pages to follow')
      else if (now !== started || session) problem('following another session than at start', { started, now })
      session = now
    }
    return session
  }

  // what came before Claude Code said it is ready waits for it
  let ready = false
  const queue: [WbEvent, boolean][] = []
  const push = (e: WbEvent, again: boolean) => {
    if (!ready) return void queue.push([e, again])
    send({
      method: 'notifications/claude/channel',
      params: {
        content: `${describe(e)}${again ? ' (received before, not handled yet)' : ''}`,
        meta: { page: e.page, id: e.id, type: e.type },
      },
    })
  }

  // Each page followed on its own, so another session's answers are never handed out here. A page
  // another wait holds is left to it, and tried again on the next round.
  const followed = new Set<string>()
  const refused = new Set<string>()
  const follow = async () => {
    const session = current()
    const pages = session ? (await ctx.status()).filter(p => p.owner === session).map(p => p.page) : []
    for (const page of pages) {
      if (followed.has(page)) continue
      followed.add(page)
      const stop = new AbortController()
      const held = await ctx.listen(page, {
        onReplaced: () => {
          problem('a wait --force took the page over', { page })
          stop.abort()
          followed.delete(page)
        },
      })
      if (held.refused) {
        if (!refused.has(page)) problem('another wait holds the page', { page, reason: held.refused })
        refused.add(page)
        followed.delete(page)
        continue
      }
      refused.delete(page)
      void ctx
        .handOut({ page, exact: true }, push, { mark: false, signal: stop.signal })
        .catch(err => problem('handing out failed', { page, err: String(err) }))
    }
  }

  /** The `received` tool: the agent has these answers. */
  const receiveIds = (ids: string[]) => {
    const { events } = read(ctx.eventsFile)
    const received = receivedIds(events)
    return ids.map(id => {
      const e = events.find(x => x.id === id)
      if (!e) return `${id}: no such event`
      if (received.has(id)) return `${id}: received already`
      receive(ctx.eventsFile, e)
      return `${id}: received`
    })
  }

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', line => {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method === 'initialize')
      send({
        id: msg.id,
        result: {
          protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
          serverInfo: { name: 'whiteboard', version: '1' },
          instructions: INSTRUCTIONS,
        },
      })
    else if (msg.method === 'notifications/initialized') {
      ready = true
      for (const [e, again] of queue.splice(0)) push(e, again)
    } else if (msg.method === 'ping') send({ id: msg.id, result: {} })
    else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [RECEIVED] } })
    else if (msg.method === 'tools/call') {
      const params = msg.params as { name?: string; arguments?: { ids?: unknown } } | undefined
      const ids = Array.isArray(params?.arguments?.ids) ? params.arguments.ids.map(String) : []
      if (params?.name !== 'received' || !ids.length)
        send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'received needs ids' }] } })
      else send({ id: msg.id, result: { content: [{ type: 'text', text: receiveIds(ids).join('\n') }] } })
    }
    // anything else asked (Claude Code probes with methods of its own): not offered here
    else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } })
  })
  // the session ended
  rl.on('close', () => process.exit(0))

  const round = () => follow().catch(err => problem('finding the session’s pages failed', String(err)))
  await round()
  setInterval(() => void round(), 5000)
  await new Promise(() => {})
}
