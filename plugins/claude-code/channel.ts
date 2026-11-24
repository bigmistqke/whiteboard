// PROTOTYPE: whiteboard as a Claude Code channel. Claude Code starts this as an MCP server (stdio)
// with each session; it pushes the reader's answers on the session's own pages into the session
// with `notifications/claude/channel`. Started with
//
//   claude --dangerously-load-development-channels server:whiteboard
//
// and `.mcp.json`: { "mcpServers": { "whiteboard": { "command": "whiteboard", "args": ["claude-code", "channel"] } } }
//
// What it learns for the design goes to `.whiteboard/claude-code/channel.log`: the environment it
// gets (is the session's id there?), and what Claude Code says it supports (can it tell whether it
// was loaded as a channel?).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { CommandContext, WbEvent } from '../../src/define.ts'
import { read, receive, receivedIds } from '../../src/events.ts'

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
  const logFile = path.join(ctx.dataDir, 'channel.log')
  fs.mkdirSync(ctx.dataDir, { recursive: true })
  const log = (what: string, data?: unknown) =>
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${what}${data === undefined ? '' : ' ' + JSON.stringify(data)}\n`)
  const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

  const session = process.env.CLAUDE_CODE_SESSION_ID || null
  log('start', {
    session,
    pid: process.pid,
    ppid: process.ppid,
    env: Object.keys(process.env).filter(k => /CLAUDE|MCP|WHITEBOARD/.test(k)),
  })

  let ready = false
  const queue: WbEvent[] = []
  const push = (e: WbEvent, again: boolean) => {
    if (!ready) return void queue.push(e)
    send({
      method: 'notifications/claude/channel',
      params: {
        content: `${describe(e)}${again ? ' (received before, not handled yet)' : ''}`,
        meta: { page: e.page, id: e.id, type: e.type },
      },
    })
    log('sent', { id: e.id, page: e.page })
  }

  // the session's pages, and any it claims later: each followed on its own, so another session's
  // answers are never received here
  // A page another wait holds is left to it, and tried again later. Nothing is marked received here:
  // the agent does that with the `received` tool, once the message reached it.
  const followed = new Set<string>()
  const refused = new Set<string>()
  const follow = async () => {
    const pages = session ? (await ctx.status()).filter(p => p.owner === session).map(p => p.page) : []
    for (const page of pages) {
      if (followed.has(page)) continue
      followed.add(page)
      const stop = new AbortController()
      const held = await ctx.listen(page, {
        onReplaced: () => {
          log('replaced', { page })
          stop.abort()
          followed.delete(page)
        },
      })
      if (held.refused) {
        if (!refused.has(page)) log('refused', { page, reason: held.refused })
        refused.add(page)
        followed.delete(page)
        continue
      }
      refused.delete(page)
      log('follow', { page })
      void ctx
        .handOut({ page, exact: true }, push, { mark: false, signal: stop.signal })
        .catch(err => log('handOut failed', { page, err: String(err) }))
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
      log('received', { id })
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
    if (msg.method === 'initialize') {
      log('initialize', msg.params)
      send({
        id: msg.id,
        result: {
          protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
          serverInfo: { name: 'whiteboard', version: '0.0.0-prototype' },
          instructions: INSTRUCTIONS,
        },
      })
    } else if (msg.method === 'notifications/initialized') {
      ready = true
      log('initialized')
      for (const e of queue.splice(0)) push(e, false)
    } else if (msg.method === 'ping') send({ id: msg.id, result: {} })
    else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [RECEIVED] } })
    else if (msg.method === 'tools/call') {
      const params = msg.params as { name?: string; arguments?: { ids?: unknown } } | undefined
      const ids = Array.isArray(params?.arguments?.ids) ? params.arguments.ids.map(String) : []
      if (params?.name !== 'received' || !ids.length)
        send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'received needs ids' }] } })
      else send({ id: msg.id, result: { content: [{ type: 'text', text: receiveIds(ids).join('\n') }] } })
    } else if (msg.id !== undefined) {
      log('unhandled request', { method: msg.method })
      send({ id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } })
    } else log('notification', { method: msg.method })
  })
  rl.on('close', () => {
    log('stdin closed')
    process.exit(0)
  })

  await follow()
  setInterval(() => void follow().catch(err => log('follow failed', String(err))), 5000)
  await new Promise(() => {})
}
