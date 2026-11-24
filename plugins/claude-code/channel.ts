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

const INSTRUCTIONS = [
  'Messages from whiteboard arrive as <channel source="whiteboard" page="…" id="…">: the reader answered on one of your whiteboard pages (a form, a chat message, a comment).',
  'Act on it as on an answer from `whiteboard wait`. Then handle it: reply in its chat (`whiteboard append`), or `whiteboard ack <id>`.',
  'You do not need to run `whiteboard wait` on pages this channel covers.',
].join(' ')

/** One line per answer: what the reader did, in words. */
export function describe(e: WbEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>
  if (e.type === 'chat:message') return `chat ${d.chat}: "${d.text}"`
  if (e.type === 'comments:new') return `comment on "${d.quote ?? d.at ?? ''}": "${d.text}"`
  const fields = Object.entries(d).filter(([, v]) => v !== '' && v != null)
  const chose = e.action ? `chose ${e.action}` : 'sent'
  return `form ${e.type}: ${chose}${fields.length ? ` (${fields.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')})` : ''}`
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
        content: `${describe(e)}${again ? ' (sent before, not handled yet)' : ''}`,
        meta: { page: e.page, id: e.id, type: e.type },
      },
    })
    log('sent', { id: e.id, page: e.page })
  }

  // the session's pages, and any it claims later: each followed on its own, so another session's
  // answers are never taken
  const followed = new Set<string>()
  const follow = async () => {
    const pages = session ? (await ctx.status()).filter(p => p.owner === session).map(p => p.page) : []
    for (const page of pages) {
      if (followed.has(page)) continue
      followed.add(page)
      log('follow', { page })
      void ctx.handOut({ page, exact: true }, push).catch(err => log('handOut failed', { page, err: String(err) }))
    }
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
          capabilities: { experimental: { 'claude/channel': {} } },
          serverInfo: { name: 'whiteboard', version: '0.0.0-prototype' },
          instructions: INSTRUCTIONS,
        },
      })
    } else if (msg.method === 'notifications/initialized') {
      ready = true
      log('initialized')
      for (const e of queue.splice(0)) push(e, false)
    } else if (msg.method === 'ping') send({ id: msg.id, result: {} })
    else if (msg.id !== undefined) {
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
