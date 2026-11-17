// Claude Code, as a whiteboard plugin: the pages an agent session makes are claimed for that
// session, and Claude Code hooks report to it what is open on them. In a config:
//
//   import claudeCode from '@bigmistqke/whiteboard/claude-code'
//   export default defineConfig({ plugins: [claudeCode()] })
//
// `whiteboard claude-code install` adds the hooks to the project's .claude/settings.json. Each runs
// `whiteboard claude-code hook <stop|prompt|session>`, and none of them ever blocks:
// - stop (a turn ends): the reader sees what on the session's pages nobody listens for;
// - prompt (the reader sends a message): the agent gets, as context, the answers on its pages that
//   no wait picked up, which count as picked up from then on;
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

/** What is open on a page, in short phrases; the command that picks it up comes last, once. */
const openOn = (p: PageStatus, options?: { waiting?: boolean }) => statusLines(p, relFile(p.file), options)

type Mode = 'stop' | 'prompt' | 'session'

/** Claude Code's settings file, as far as hooks go. */
interface Settings {
  hooks?: Record<string, { hooks?: { type?: string; command?: string }[] }[]>
}

const MODES: Record<Mode, string> = { stop: 'Stop', prompt: 'UserPromptSubmit', session: 'SessionStart' }

/** A hook command this plugin installs. */
const OURS = /\bwhiteboard claude-code hook\b/

export default function claudeCode(): Plugin {
  return {
    name: 'claude-code',
    session: () => process.env.CLAUDE_CODE_SESSION_ID || null,
    commands: {
      hook: {
        description: 'what Claude Code runs on an event (stop, prompt or session): report what is open on the session\'s pages; never blocks',
        args: '<stop|prompt|session>',
        async run(ctx) {
          const mode = ctx.positionals[0] as Mode
          if (!mode || !(mode in MODES)) throw new Error(`usage: whiteboard claude-code hook <${Object.keys(MODES).join('|')}>`)
          // a hook that fails must not get in the way of the session it runs in: say why, and exit cleanly
          try { await hook(ctx, mode) } catch (err) { console.error(`whiteboard claude-code hook ${mode}: ${(err as Error).message}`) }
        },
      },
      install: {
        description: 'add the hooks to this project\'s .claude/settings.json',
        run: ctx => install(ctx.project.dir),
      },
    },
  }
}

/** The JSON Claude Code passes a hook on its standard input, or nothing. */
function hookInput(): { session_id?: string } {
  if (process.stdin.isTTY) return {}
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

const relFile = (file: string) => path.relative(process.cwd(), file) || file
async function hook(ctx: CommandContext, mode: Mode) {
  const session = hookInput().session_id ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  const pages = await ctx.status()
  const busy = pages.filter(p => p.unpicked.length || p.open.length)
  const mine = busy.filter(p => session && p.owner === session)

  if (mode === 'stop') {
    // shown to the reader when a turn ends, never blocking it
    const loose = mine.filter(p => p.unheard.length || p.unpicked.length)
    if (!loose.length) return
    const said = (p: PageStatus) => { const l = openOn(p, { waiting: false }); return `${l.slice(0, -1).join('; ')} ${l.at(-1)}` }
    console.log(JSON.stringify({ systemMessage: `whiteboard: ${loose.map(p => `${p.page}: ${said(p)}`).join(' · ')}` }))
    return
  }

  // prompt and session: what is printed becomes context for the agent. Answers on its own pages
  // that no wait picked up are handed over here, as a wait would, and count as picked up from then
  // on. Only the page itself: a page below it may be another session's.
  const out: string[] = []
  for (const p of mine) {
    const handed: WbEvent[] = []
    await ctx.handOut({ page: p.page, exact: true }, e => handed.push(e), { follow: false })
    if (handed.length) {
      out.push(`Answers on your page ${p.page} (${relFile(p.file)}) that no wait picked up; they count as picked up now:`)
      for (const e of handed) out.push(JSON.stringify(e))
    }
    if (p.unheard.length) out.push(`Nobody listens for ${p.unheard.join(', ')} on your page ${p.page}: run \`whiteboard wait --page ${relFile(p.file)}\` in the background.`)
  }
  if (mode === 'session') {
    // a new session may carry on work another one started: say what is open elsewhere, without handing it over
    const others = busy.filter(p => !mine.includes(p))
    if (others.length) {
      out.push('Other pages in this whiteboard project with something open (not this session\'s; their answers stay for whoever waits on them):')
      for (const p of others) out.push(`- ${p.page} (${whose(p, session)}): ${openOn(p).join(' ')}`)
    }
  }
  if (out.length) console.log(out.join('\n'))
}

/** Add the hooks to the project's .claude/settings.json, replacing ours that run another command. */
function install(dir: string) {
  const file = path.join(dir, '.claude', 'settings.json')
  let settings: Settings = {}
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`${file} is not valid JSON; fix it first`) }
  }
  // the hooks run outside any project folder's node_modules/.bin, so name the command that works here
  const onPath = spawnSync('sh', ['-c', 'command -v whiteboard'], { encoding: 'utf8' }).status === 0
  const bin = onPath ? 'whiteboard' : 'npx whiteboard'
  const changed: string[] = []
  const hooks = settings.hooks ??= {}
  for (const [mode, event] of Object.entries(MODES)) {
    const command = `${bin} claude-code hook ${mode}`
    const groups = hooks[event] ?? []
    if (groups.some(g => g.hooks?.some(h => h.command === command))) continue
    // drop the hooks of ours that run another command, and the groups that leaves empty
    const kept = groups
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !OURS.test(h.command ?? '')) }))
      .filter(g => g.hooks.length)
    hooks[event] = [...kept, { hooks: [{ type: 'command', command }] }]
    changed.push(event)
  }
  if (!changed.length) { console.log(`hooks already installed: ${file}`); return }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(`${file}.tmp`, file)
  console.log(`hooks added to ${file}: ${changed.join(', ')}`)
}
