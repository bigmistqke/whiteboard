// Claude Code, as a whiteboard plugin: the pages an agent session makes are claimed for that
// session, and Claude Code hooks report to it what is open on them. In a config:
//
//   import claudeCode from '@bigmistqke/whiteboard/claude-code'
//   export default defineConfig({ plugins: [claudeCode()] })
//
// `whiteboard claude-code install` adds the hooks to the project's .claude/settings.json, and
// `uninstall` takes them out again. Each runs `whiteboard claude-code hook <stop|prompt|session>`,
// and none of them ever blocks but once:
// - stop (a turn ends): when the session's pages have questions nobody listens for, the agent's turn
//   goes on once, told to start its wait (it forgot); a turn a hook already continued ends, and the
//   reader sees what is open;
// - prompt (the reader sends a message): the agent gets, as context, the answers on its pages that
//   no agent received yet, which count as received from then on;
// - session (a session starts): the same, plus what is open on other sessions' pages, without
//   handing it over.
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

/** What is open on a page, in short phrases; the command that picks it up comes last, once. */
const openOn = (p: PageStatus, options?: { waiting?: boolean }) => statusLines(p, relFile(p.file), options)

type Mode = 'stop' | 'prompt' | 'session'

/** Claude Code's settings file, as far as hooks go. */
interface Settings {
  hooks?: Record<string, { hooks?: { type?: string; command?: string }[] }[]>
}

const MODES: Record<Mode, string> = { stop: 'Stop', prompt: 'UserPromptSubmit', session: 'SessionStart' }

/** A hook command this plugin installs, also one that runs whiteboard another way (`node …/whiteboard.ts`). */
const OURS = /\bwhiteboard(\.ts"?)? claude-code hook\b/

export default function claudeCode(): Plugin {
  return {
    name: 'claude-code',
    session: () => process.env.CLAUDE_CODE_SESSION_ID || null,
    commands: {
      hook: {
        description:
          "what Claude Code runs on an event (stop, prompt or session): report what is open on the session's pages; a stop with questions nobody listens for continues the turn once, to start a wait",
        args: '<stop|prompt|session>',
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
          "PROTOTYPE: an MCP channel server Claude Code starts with the session; pushes the reader's answers on the session's pages into it",
        run: channel,
      },
      install: {
        description: "add the hooks to this project's .claude/settings.json",
        run: ctx => install(ctx.project.dir),
      },
      uninstall: {
        description: "take the hooks out of this project's .claude/settings.json again; other hooks and settings stay",
        run: ctx => uninstall(ctx.project.dir),
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
  const pages = await ctx.status()
  const busy = pages.filter(
    p => p.unreceived.length || p.open.length || p.unhandled.length || p.awaitingReply.length,
  )
  const mine = busy.filter(p => session && p.owner === session)

  if (mode === 'stop') {
    // A turn ends with something on the session's pages left: questions nobody listens for or
    // answers no agent received (the agent forgot to wait again), answers it was given and didn't
    // handle, chats where the reader wrote last. Its turn goes on once, with that as the reason;
    // Claude Code marks a turn a hook continued (stop_hook_active), and that one ends, with what
    // is open shown to the reader instead.
    const loose = mine.filter(p => p.unheard.length || p.unreceived.length || p.unhandled.length || p.awaitingReply.length)
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
    // the chats waiting for it
    const reason = loose
      .map(p => {
        const todo: string[] = []
        if (p.unheard.length || p.unreceived.length)
          todo.push(`run \`whiteboard wait --page ${relFile(p.file)}\` in the background`)
        if (p.unhandled.length)
          todo.push(
            `act on the answers you were given and reply in their chat, or \`whiteboard handled ${p.unhandled.map(e => e.id).join(' ')}\``,
          )
        if (p.awaitingReply.length) todo.push(`reply in the chat${p.awaitingReply.length > 1 ? 's' : ''} ${p.awaitingReply.join(', ')}`)
        return `On your whiteboard page ${p.page}: ${said(p)}. Before ending your turn: ${todo.join('; ')}.`
      })
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
      out.push(`Waiting for your reply on ${p.page}: the chat${p.awaitingReply.length > 1 ? 's' : ''} ${p.awaitingReply.join(', ')}.`)
    if (p.unheard.length)
      out.push(
        `Nobody listens for ${p.unheard.join(', ')} on your page ${p.page}: run \`whiteboard wait --page ${relFile(p.file)}\` in the background.`,
      )
  }
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

/** Add the hooks to the project's .claude/settings.json, replacing ours that run another command. */
/** The project's .claude/settings.json, and its settings ({} when there is none). */
function readSettings(dir: string): { file: string; settings: Settings } {
  const file = path.join(dir, '.claude', 'settings.json')
  if (!fs.existsSync(file)) return { file, settings: {} }
  try {
    return { file, settings: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    throw new Error(`${file} is not valid JSON; fix it first`)
  }
}

function writeSettings(file: string, settings: Settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(`${file}.tmp`, file)
}

/** The hook groups of one event without ours, and without the groups that leaves empty. */
const withoutOurs = (groups: NonNullable<Settings['hooks']>[string]) =>
  groups
    .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !OURS.test(h.command ?? '')) }))
    .filter(g => g.hooks.length)

function install(dir: string) {
  const { file, settings } = readSettings(dir)
  // the hooks run outside any project folder's node_modules/.bin, so name the command that works here
  const onPath = spawnSync('sh', ['-c', 'command -v whiteboard'], { encoding: 'utf8' }).status === 0
  const bin = onPath ? 'whiteboard' : 'npx whiteboard'
  const changed: string[] = []
  const hooks = (settings.hooks ??= {})
  for (const [mode, event] of Object.entries(MODES)) {
    const command = `${bin} claude-code hook ${mode}`
    const groups = hooks[event] ?? []
    if (groups.some(g => g.hooks?.some(h => h.command === command))) continue
    // ours that run another command go
    hooks[event] = [...withoutOurs(groups), { hooks: [{ type: 'command', command }] }]
    changed.push(event)
  }
  if (!changed.length) {
    console.log(`hooks already installed: ${file}`)
    return
  }
  writeSettings(file, settings)
  console.log(`hooks added to ${file}: ${changed.join(', ')}`)
}

/**
 * Take this plugin's hooks out of the project's .claude/settings.json, and nothing else: other
 * hooks and settings stay. A file that held only ours goes.
 */
function uninstall(dir: string) {
  const { file, settings } = readSettings(dir)
  const removed: string[] = []
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!groups.some(g => g.hooks?.some(h => OURS.test(h.command ?? '')))) continue
    const kept = withoutOurs(groups)
    removed.push(event)
    if (kept.length) settings.hooks![event] = kept
    else delete settings.hooks![event]
  }
  if (!removed.length) {
    console.log(`no whiteboard hooks in ${file}`)
    return
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  if (!Object.keys(settings).length) fs.rmSync(file)
  else writeSettings(file, settings)
  console.log(`hooks removed from ${file}: ${removed.join(', ')}`)
}
