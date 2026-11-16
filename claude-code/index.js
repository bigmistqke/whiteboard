// Claude Code, as a whiteboard plugin: the pages an agent session makes are claimed for that
// session, and Claude Code hooks report to it what is open on them. In a config:
//
//   import claudeCode from '@bigmistqke/whiteboard/claude-code'
//   export default defineConfig({ renderers: [markboard()], plugins: [claudeCode()] })
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

const MODES = { stop: 'Stop', prompt: 'UserPromptSubmit', session: 'SessionStart' }

/** A hook command this plugin installs, or one an older version of the package installed. */
const OURS = /\bwhiteboard (claude-code hook|status --hook)\b/

export default function claudeCode() {
  return {
    name: 'claude-code',
    session: () => process.env.CLAUDE_CODE_SESSION_ID || null,
    commands: {
      hook: {
        description: 'what Claude Code runs on an event (stop, prompt or session): report what is open on the session\'s pages; never blocks',
        args: '<stop|prompt|session>',
        async run(ctx) {
          const mode = ctx.positionals[0]
          if (!(mode in MODES)) throw new Error(`usage: whiteboard claude-code hook <${Object.keys(MODES).join('|')}>`)
          // a hook that fails must not get in the way of the session it runs in: say why, and exit cleanly
          try { await hook(ctx, mode) } catch (err) { console.error(`whiteboard claude-code hook ${mode}: ${err.message}`) }
        },
      },
      install: {
        description: 'add the hooks to this project\'s .claude/settings.json (replacing ones an older version added)',
        run: ctx => install(ctx.project.dir),
      },
    },
  }
}

/** The JSON Claude Code passes a hook on its standard input, or nothing. */
function hookInput() {
  if (process.stdin.isTTY) return {}
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

const relFile = file => path.relative(process.cwd(), file) || file
const whose = (p, session) => (p.owner && p.owner === session ? 'yours' : p.owner ? `session ${p.owner.slice(0, 8)}` : 'no session')

/** What is open on a page, in short phrases; the command that picks it up comes last, once. */
function openOn(p, { waiting = true } = {}) {
  const lines = []
  if (p.unpicked.length) lines.push(`${p.unpicked.length} answer${p.unpicked.length > 1 ? 's' : ''} no agent picked up (${[...new Set(p.unpicked.map(e => e.type))].join(', ')})`)
  if (p.unheard.length) lines.push(`nobody listens for ${p.unheard.join(', ')}`)
  if (lines.length) lines.push(`→ whiteboard wait --page ${relFile(p.file)}`)
  const heard = p.open.filter(t => !p.unheard.includes(t))
  if (waiting && heard.length) lines.push(`waiting for the reader: ${heard.join(', ')}`)
  return lines
}

async function hook(ctx, mode) {
  const session = hookInput().session_id ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  const pages = await ctx.status()
  const busy = pages.filter(p => p.unpicked.length || p.open.length)
  const mine = busy.filter(p => session && p.owner === session)

  if (mode === 'stop') {
    // shown to the reader when a turn ends, never blocking it
    const loose = mine.filter(p => p.unheard.length || p.unpicked.length)
    if (!loose.length) return
    const said = p => { const l = openOn(p, { waiting: false }); return `${l.slice(0, -1).join('; ')} ${l.at(-1)}` }
    console.log(JSON.stringify({ systemMessage: `whiteboard: ${loose.map(p => `${p.page}: ${said(p)}`).join(' · ')}` }))
    return
  }

  // prompt and session: what is printed becomes context for the agent. Answers on its own pages
  // that no wait picked up are handed over here, and count as picked up from then on.
  const out = []
  for (const p of mine) {
    if (p.unpicked.length) {
      out.push(`Answers on your page ${p.page} (${relFile(p.file)}) that no wait picked up; they count as picked up now:`)
      for (const e of p.unpicked) out.push(JSON.stringify(e))
      for (const e of p.unpicked) ctx.pickUp(e)
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

/** Add the hooks to the project's .claude/settings.json, replacing ones an older version added. */
function install(dir) {
  const file = path.join(dir, '.claude', 'settings.json')
  let settings = {}
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`${file} is not valid JSON; fix it first`) }
  }
  // the hooks run outside any project folder's node_modules/.bin, so name the command that works here
  const onPath = spawnSync('sh', ['-c', 'command -v whiteboard'], { encoding: 'utf8' }).status === 0
  const bin = onPath ? 'whiteboard' : 'npx whiteboard'
  const changed = []
  settings.hooks ??= {}
  for (const [mode, event] of Object.entries(MODES)) {
    const command = `${bin} claude-code hook ${mode}`
    const groups = settings.hooks[event] ?? []
    if (groups.some(g => g.hooks?.some(h => h.command === command))) continue
    // drop the hooks of ours that run another command, and the groups that leaves empty
    const kept = groups
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !OURS.test(h.command ?? '')) }))
      .filter(g => g.hooks.length)
    settings.hooks[event] = [...kept, { hooks: [{ type: 'command', command }] }]
    changed.push(event)
  }
  if (!changed.length) { console.log(`hooks already installed: ${file}`); return }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(`${file}.tmp`, file)
  console.log(`hooks added to ${file}: ${changed.join(', ')}`)
}
