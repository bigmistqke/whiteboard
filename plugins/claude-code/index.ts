// Claude Code, as a whiteboard plugin: the pages an agent session makes are claimed for that
// session, a channel pushes the reader's answers on them into it (channel.ts), and reminders
// (Claude Code hooks) report to it what is open on them. In a config:
//
//   import claudeCode from '@bigmistqke/whiteboard/claude-code'
//   export default defineConfig({ plugins: [claudeCode()] })
//
// Two ways to get the reader's answers to the agent, installed by `whiteboard claude-code install`
// (both, or `install channel` or `install reminders` only one; `uninstall` takes them out again):
// - channel: the MCP server in the project's .mcp.json, which pushes each answer into the session
//   (channel.ts), and one silent SessionStart hook (`hook channel`) that tells it which session it
//   is on, since a resume leaves it with another id (session.ts);
// - reminders: hooks in its .claude/settings.json that remind the agent of what is open, at the
//   ends of its turns and with the reader's messages.
//
// Each hook runs `whiteboard claude-code hook <mode>`, and every mode first records the session
// for the channel. Then, and none of them ever blocks but once:
// - stop (a turn ends): when the session's pages have questions nobody listens for, the agent's turn
//   goes on once, told to start its wait (it forgot); a turn a hook already continued ends, and the
//   reader sees what is open;
// - prompt (the reader sends a message): the agent gets, as context, the answers on its pages that
//   no agent received yet, which count as received from then on;
// - session (a session starts): the same, plus what is open on other sessions' pages, without
//   handing it over;
// - channel (a session starts): nothing more.
//
// Claude Code gives each conversation an id, in the environment of the commands it runs
// (`CLAUDE_CODE_SESSION_ID`) and on the standard input of a hook (`session_id`). That id is the
// session the core records when `whiteboard new` claims a page.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { CommandContext, PageStatus, Plugin, WbEvent } from '../../src/define.ts'
import { statusLines, whose } from '../../src/status.ts'
import { channel } from './channel.ts'
import { recordSession } from './session.ts'

/** What is open on a page, in short phrases; the command that picks it up comes last, once. */
const openOn = (p: PageStatus, options?: { waiting?: boolean }) => statusLines(p, relFile(p.file), options)

type Mode = 'stop' | 'prompt' | 'session' | 'channel'

/** The one wait for these pages: a --page each. */
const waitOn = (pages: PageStatus[]) => `whiteboard wait ${pages.map(p => `--page ${relFile(p.file)}`).join(' ')}`

/** Claude Code's settings file, as far as hooks go. */
interface Settings {
  hooks?: Record<string, { hooks?: { type?: string; command?: string }[] }[]>
}

const MODES: Record<Mode, string> = {
  stop: 'Stop',
  prompt: 'UserPromptSubmit',
  session: 'SessionStart',
  channel: 'SessionStart',
}

/** What install and uninstall act on, and the hooks each brings. */
type Part = 'channel' | 'reminders'
const HOOKS: Record<Part, Mode[]> = { channel: ['channel'], reminders: ['stop', 'prompt', 'session'] }

/**
 * A hook command this plugin installs, also one that runs whiteboard another way (`node …/whiteboard.ts`),
 * and its mode.
 */
const OURS = /\bwhiteboard(?:\.ts"?)? claude-code hook (\w+)/
const modeOf = (command = '') => command.match(OURS)?.[1]

export default function claudeCode(): Plugin {
  return {
    name: 'claude-code',
    session: () => process.env.CLAUDE_CODE_SESSION_ID || null,
    commands: {
      hook: {
        description:
          "what Claude Code runs on an event: record the session for the channel; then stop, prompt or session report what is open on the session's pages (a stop with questions nobody listens for continues the turn once, to start a wait), and channel says nothing",
        args: '<stop|prompt|session|channel>',
        async run(ctx) {
          const mode = ctx.positionals[0] as Mode
          if (!mode || !(mode in MODES))
            throw new Error(`usage: whiteboard claude-code hook <${Object.keys(MODES).join('|')}>`)
          // a hook that fails must not get in the way of the session it runs in: say why, and exit cleanly
          try {
            await hook(ctx, mode)
          } catch (err) {
            console.error(`whiteboard claude-code hook ${mode}: ${(err as Error).message}`)
          }
        },
      },
      channel: {
        description:
          "the MCP channel Claude Code starts with each session (with the development-channels flag): pushes the reader's answers on the session's pages into it",
        run: channel,
      },
      install: {
        description:
          "add the channel (its server to this project's .mcp.json, its hook to .claude/settings.json) and the reminders (hooks in .claude/settings.json); `channel` or `reminders` for only one",
        args: '[channel|reminders]',
        run: ctx => {
          for (const part of parts(ctx.positionals, 'install')) {
            if (part === 'channel') installChannel(ctx.project.dir)
            installHooks(ctx.project.dir, part)
          }
        },
      },
      uninstall: {
        description:
          "take the channel and the reminders out of this project's settings again, or only `channel` or `reminders`; other hooks, servers and settings stay",
        args: '[channel|reminders]',
        run: ctx => {
          for (const part of parts(ctx.positionals, 'uninstall')) {
            if (part === 'channel') uninstallChannel(ctx.project.dir)
            uninstallHooks(ctx.project.dir, part)
          }
        },
      },
    },
  }
}

/** The JSON Claude Code passes a hook on its standard input, or nothing. */
function hookInput(): { session_id?: string; stop_hook_active?: boolean } {
  if (process.stdin.isTTY) return {}
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

const relFile = (file: string) => path.relative(process.cwd(), file) || file
async function hook(ctx: CommandContext, mode: Mode) {
  const input = hookInput()
  const session = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  // the channel's environment can hold an id the conversation left (a resume): tell it the current one
  if (input.session_id) recordSession(ctx.dataDir, input.session_id)
  if (mode === 'channel') return
  const pages = await ctx.status()
  const busy = pages.filter(p => p.unreceived.length || p.open.length || p.unhandled.length || p.awaitingReply.length)
  const mine = busy.filter(p => session && p.owner === session)

  if (mode === 'stop') {
    // A turn ends with something on the session's pages left: questions nobody listens for or
    // answers no agent received (the agent forgot to wait again), answers it was given and didn't
    // handle, chats where the reader wrote last. Its turn goes on once, with that as the reason;
    // Claude Code marks a turn a hook continued (stop_hook_active), and that one ends, with what
    // is open shown to the reader instead.
    const loose = mine.filter(
      p => p.unheard.length || p.unreceived.length || p.unhandled.length || p.awaitingReply.length,
    )
    if (!loose.length) return
    // what is left, without the command line: the reason says what to do
    const said = (p: PageStatus) =>
      openOn(p, { waiting: false })
        .filter(l => !l.startsWith('→'))
        .join('; ')
    const shown = `whiteboard: ${loose.map(p => `${p.page}: ${said(p)}`).join(' · ')}`
    if (input.stop_hook_active) {
      console.log(JSON.stringify({ systemMessage: shown }))
      return
    }
    // what to do about each: wait for what nobody listens for, handle what it was given, reply in
    // the chats waiting for it. Pages to wait on: one wait for all of them, said once at the end
    const toWait = loose.filter(p => p.unheard.length || p.unreceived.length)
    const reason = loose
      .map(p => {
        const todo: string[] = []
        if (toWait.length === 1 && toWait[0] === p)
          todo.push(`run \`whiteboard wait --page ${relFile(p.file)}\` in the background`)
        if (p.unhandled.length)
          todo.push(
            `act on the answers you were given and reply in their chat, or \`whiteboard handled ${p.unhandled.map(e => e.id).join(' ')}\``,
          )
        if (p.awaitingReply.length)
          todo.push(`reply in the chat${p.awaitingReply.length > 1 ? 's' : ''} ${p.awaitingReply.join(', ')}`)
        return `On your whiteboard page ${p.page}: ${said(p)}.${todo.length ? ` Before ending your turn: ${todo.join('; ')}.` : ''}`
      })
      .concat(
        toWait.length > 1
          ? [`Before ending your turn, run one wait for these pages in the background: \`${waitOn(toWait)}\`.`]
          : [],
      )
      .join('\n')
    console.log(JSON.stringify({ decision: 'block', reason, systemMessage: shown }))
    return
  }

  // prompt and session: what is printed becomes context for the agent. Answers on its own pages
  // that no agent received are handed over here, as a wait would, and count as received from then on; the
  // agent still handles each (replies, or marks it handled). Those received before and not handled are named,
  // not repeated in full. Only the page itself: a page below it may be another session's.
  const out: string[] = []
  for (const p of mine) {
    const handed: WbEvent[] = []
    await ctx.handOut({ page: p.page, exact: true }, e => handed.push(e), { follow: false, unreceived: true })
    if (handed.length) {
      out.push(
        `Answers on your page ${p.page} (${relFile(p.file)}) that no agent received yet; they are yours now: reply in their chat, or \`whiteboard handled <id>\` once you acted on one:`,
      )
      for (const e of handed) out.push(JSON.stringify(e))
    }
    if (p.unhandled.length)
      out.push(
        `Answers on your page ${p.page} you were handed and haven't handled: ${p.unhandled.map(e => `${e.type} ${e.id}`).join(', ')}. Reply in their chat, or \`whiteboard handled <id>\` once you acted on one.`,
      )
    if (p.awaitingReply.length)
      out.push(
        `Waiting for your reply on ${p.page}: the chat${p.awaitingReply.length > 1 ? 's' : ''} ${p.awaitingReply.join(', ')}.`,
      )
    if (p.unheard.length) out.push(`Nobody listens for ${p.unheard.join(', ')} on your page ${p.page}.`)
  }
  // one wait for every page nobody listens on
  const unheard = mine.filter(p => p.unheard.length)
  if (unheard.length) out.push(`Run \`${waitOn(unheard)}\` in the background: one wait for all of them.`)
  if (mode === 'session') {
    // a new session may carry on work another one started: say what is open elsewhere, without handing it over
    const others = busy.filter(p => !mine.includes(p))
    if (others.length) {
      out.push(
        "Other pages in this whiteboard project with something open (not this session's; their answers stay for whoever waits on them):",
      )
      for (const p of others) out.push(`- ${p.page} (${whose(p, session)}): ${openOn(p).join(' ')}`)
    }
  }
  if (out.length) console.log(out.join('\n'))
}

/** A JSON file of Claude Code's settings ({} when there is none). */
function readJson<T extends object>(file: string): T {
  if (!fs.existsSync(file)) return {} as T
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} is not valid JSON; fix it first`)
  }
}

/** Write it in one rename; one left empty goes. */
function writeJson(file: string, value: object) {
  if (!Object.keys(value).length) return void fs.rmSync(file, { force: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(`${file}.tmp`, file)
}

/**
 * How Claude Code runs whiteboard here: the project's own copy when it depends on it (the version
 * it pins, for everyone who clones it), else the one on the PATH, else from npm. Claude Code runs
 * these outside any node_modules/.bin; npx finds the project's copy, and names the package, since
 * `npx whiteboard` alone would fetch another one.
 */
function whiteboardCommand(dir: string): string[] {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'node_modules', '@bigmistqke', 'whiteboard'))) return NPX
    if (path.dirname(d) === d) break
  }
  const onPath = spawnSync('sh', ['-c', 'command -v whiteboard'], { encoding: 'utf8' }).status === 0
  return onPath ? ['whiteboard'] : NPX
}
const NPX = ['npx', '@bigmistqke/whiteboard']

/** What install and uninstall act on: both, or the one named. */
function parts(positionals: string[], command: string): Part[] {
  const named = positionals[0]
  if (!named) return ['channel', 'reminders']
  if (named in HOOKS) return [named as Part]
  throw new Error(`usage: whiteboard claude-code ${command} [${Object.keys(HOOKS).join('|')}]`)
}

/** The hook groups of one event without ours of these modes, and without the groups that leaves empty. */
const without = (groups: NonNullable<Settings['hooks']>[string], modes: Mode[]) =>
  groups
    .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !modes.includes(modeOf(h.command) as Mode)) }))
    .filter(g => g.hooks.length)

const settingsFile = (dir: string) => path.join(dir, '.claude', 'settings.json')

/** Add a part's hooks to the project's .claude/settings.json, replacing ours that run another command. */
function installHooks(dir: string, part: Part) {
  const file = settingsFile(dir)
  const settings = readJson<Settings>(file)
  const bin = whiteboardCommand(dir).join(' ')
  const changed: string[] = []
  const hooks = (settings.hooks ??= {})
  for (const mode of HOOKS[part]) {
    const event = MODES[mode]
    const command = `${bin} claude-code hook ${mode}`
    const groups = hooks[event] ?? []
    if (groups.some(g => g.hooks?.some(h => h.command === command))) continue
    // ours of this mode that run another command go
    hooks[event] = [...without(groups, [mode]), { hooks: [{ type: 'command', command }] }]
    changed.push(event)
  }
  if (!changed.length) return console.log(`${part} hooks already installed: ${file}`)
  writeJson(file, settings)
  console.log(`${part} hooks added to ${file}: ${changed.join(', ')}`)
}

/**
 * Take a part's hooks out of the project's .claude/settings.json, and nothing else: other hooks and
 * settings stay. A file that held only ours goes.
 */
function uninstallHooks(dir: string, part: Part) {
  const file = settingsFile(dir)
  const settings = readJson<Settings>(file)
  const modes = HOOKS[part]
  const removed: string[] = []
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!groups.some(g => g.hooks?.some(h => modes.includes(modeOf(h.command) as Mode)))) continue
    const kept = without(groups, modes)
    removed.push(event)
    if (kept.length) settings.hooks![event] = kept
    else delete settings.hooks![event]
  }
  if (!removed.length) return console.log(`no whiteboard ${part} hooks in ${file}`)
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  writeJson(file, settings)
  console.log(`${part} hooks removed from ${file}: ${removed.join(', ')}`)
}

/** The project's MCP servers, as far as the channel goes. */
interface McpConfig {
  mcpServers?: Record<string, { command?: string; args?: string[] }>
}
const mcpFile = (dir: string) => path.join(dir, '.mcp.json')

/** Register the channel (channel.ts) in the project's .mcp.json, as the server `whiteboard`. */
function installChannel(dir: string) {
  const file = mcpFile(dir)
  const config = readJson<McpConfig>(file)
  const [command, ...args] = [...whiteboardCommand(dir), 'claude-code', 'channel']
  const servers = (config.mcpServers ??= {})
  const now = servers.whiteboard
  if (now?.command === command && JSON.stringify(now.args) === JSON.stringify(args))
    return console.log(`channel already installed: ${file}`)
  servers.whiteboard = { command, args }
  writeJson(file, config)
  console.log(
    `channel added to ${file}; a session loads it when started with: claude --dangerously-load-development-channels server:whiteboard`,
  )
}

/** Take the channel out of the project's .mcp.json; other servers stay. A file that held only it goes. */
function uninstallChannel(dir: string) {
  const file = mcpFile(dir)
  const config = readJson<McpConfig>(file)
  const ours = config.mcpServers?.whiteboard
  if (!ours?.args?.includes('channel')) return console.log(`no whiteboard channel in ${file}`)
  delete config.mcpServers!.whiteboard
  if (!Object.keys(config.mcpServers!).length) delete config.mcpServers
  writeJson(file, config)
  console.log(`channel removed from ${file}`)
}
