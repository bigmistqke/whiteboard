#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'
import http from 'node:http'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pageId, findProjectDir, project as projectAt, configFileIn } from '../src/config.js'
import { appendEvent, parseLines, readEvents, matches, pickedUp, markPicked, CLAIM } from '../src/events.js'

// a failing command prints its message, not a stack trace
const fail = err => {
  console.error(`whiteboard: ${err?.message ?? err}`)
  process.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

const HELP = `whiteboard — markdown pages in the browser, what the reader does on them as events in an ndjson log

  whiteboard init [name]           make this folder a project: .whiteboard/{config.ts,pages/}
  whiteboard root                  print where pages go (this project's .whiteboard/pages)
  whiteboard new <name>           create a page under a name no other page has (name, name-2, …), print its path
  whiteboard show <page|file>      start this project's server if needed, print the page URL
  whiteboard url <page|file>       the same: print the page URL
  whiteboard docs                  how to write pages here (for markboard: its templates) — read before writing one
  whiteboard events [filters]      print recorded events as ndjson
  whiteboard wait [filters]        block until the next matching event, print it, exit
  whiteboard watch [filters]       like wait, but never exits: print each matching event once
  whiteboard append --page <p> --type <t> [--data <json>]   add an event to a page's log (e.g. a reply)
  whiteboard status [--page <p>]   per page: questions without an answer, answers no agent picked up, who listens
  whiteboard hooks install [--user]   add Claude Code hooks that report the status (this project, or all)
  whiteboard serve                 run this project's server in the foreground
  whiteboard skill [dir]          print where the agent skill is, or link it into a skills folder

filters: --page <page|file> (includes pages below it)  --type <type>
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
events:  --since <iso time or event id>  --last <n>

Every command works on the project of the current folder: the nearest folder upward with
.whiteboard/config.ts. Each project runs its own server; its port is in .whiteboard/server.json.
A page appends events {id, ts, page, type, action, data} to .whiteboard/events.ndjson;
which types it sends is up to its renderer (\`whiteboard docs\` says).`

const [cmd, ...rest] = process.argv.slice(2)
const { values: opts, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    page: { type: 'string' }, type: { type: 'string' }, data: { type: 'string' }, timeout: { type: 'string' }, count: { type: 'string' },
    since: { type: 'string' }, last: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    hook: { type: 'string' }, user: { type: 'boolean' },
  },
})

const project = projectAt(findProjectDir())

/** The current project, or exit with how to make one. */
function needProject() {
  if (project) return project
  console.error(`whiteboard: not inside a project (no .whiteboard/config.ts in ${process.cwd()} or above it).
Run \`whiteboard init\` in the folder that should become one.`)
  process.exit(1)
}

const filter = () => ({ page: opts.page ? pageId(needProject(), opts.page) : undefined, type: opts.type })

/** The running server of this project: its base URL, or null. */
async function running(proj) {
  let port
  try { port = JSON.parse(fs.readFileSync(proj.serverFile, 'utf8')).port } catch { return null }
  const base = `http://localhost:${port}`
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) })
    // the port may since have been taken by another project's server
    return res.ok && (await res.json()).dir === proj.dir ? base : null
  } catch { return null }
}

/** This project's server, started in the background when it is not running. @returns its base URL */
async function ensureServer() {
  const proj = needProject()
  const base = await running(proj)
  if (base) return base
  // Several commands may get here at once (an agent starting three watches, say): the one that
  // creates the lock file starts the server, the others wait for it. A lock whose command is gone
  // is left over, and taken over. (Should two servers still start, the server lets one survive.)
  const lock = path.join(proj.wb, 'server.lock')
  const claim = () => {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true } catch (err) {
      if (err.code !== 'EEXIST') throw err
      return false
    }
  }
  let mine = claim()
  if (!mine) {
    // taking a stale lock over must be exclusive too: remove it, then claim it again, so that of
    // several commands finding it at once only one starts a server
    let stale = false
    try {
      const owner = Number(fs.readFileSync(lock, 'utf8'))
      try { process.kill(owner, 0) } catch (err) { stale = err.code === 'ESRCH' }
    } catch { /* removed meanwhile */ }
    if (stale) {
      try { fs.unlinkSync(lock) } catch { /* another command removed it first */ }
      mine = claim()
    }
  }
  if (mine) {
    const log = fs.openSync(proj.logFile, 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { cwd: proj.dir, detached: true, stdio: ['ignore', log, log], env: process.env })
    child.unref()
  }
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200))
    const base = await running(proj)
    if (base) return base
  }
  throw new Error(`server did not start; see ${proj.logFile}`)
}

async function api(route) {
  const res = await fetch(`${await ensureServer()}${route}`)
  // a server started from an older version of this package doesn't know newer routes
  if (!(res.headers.get('content-type') ?? '').includes('application/json'))
    throw new Error(`the running server doesn't know ${route.split('?')[0]}: it is older than this command; restart it (stop the process in .whiteboard/server.json, then run whiteboard show)`)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

/**
 * Tell the project's server that an agent is waiting, for as long as this command runs: pages show
 * what is waited for. Holds one connection open, the listener; reconnects when the server restarts.
 * Reading the log does not depend on it, so answers are never missed when the server is away.
 */
function listen(f, command) {
  const connect = async () => {
    let base
    try { base = await ensureServer() } catch { return setTimeout(connect, 2000).unref() }
    const q = new URLSearchParams({ command, ...(f.page ? { page: f.page } : {}), ...(f.type ? { type: f.type } : {}) })
    let again = false
    const retry = ms => { if (!again) { again = true; setTimeout(connect, ms).unref() } }
    const req = http.get(`${base}/api/listen?${q}`, res => {
      res.resume()
      res.on('close', () => retry(1000))
    })
    req.on('error', () => retry(2000))
    // the connection alone does not keep the command running
    req.on('socket', socket => socket.unref())
  }
  connect()
}

const logSize = log => (fs.existsSync(log) ? fs.statSync(log).size : 0)

/** The events in the first `bytes` bytes of the log. */
function readEventsUpTo(log, bytes) {
  if (!bytes) return []
  const fd = fs.openSync(log, 'r')
  const buf = Buffer.alloc(bytes)
  fs.readSync(fd, buf, 0, bytes, 0)
  fs.closeSync(fd)
  return parseLines(buf.toString('utf8'))
}

/** Follow the event log from byte `offset` (default: its current end), calling `onEvent` for each matching new line. */
function follow(onEvent, offset = logSize(needProject().eventsFile)) {
  const log = needProject().eventsFile
  const f = filter()
  let partial = ''
  const poll = () => {
    if (!fs.existsSync(log)) return
    const size = fs.statSync(log).size
    if (size < offset) offset = 0 // truncated
    if (size === offset) return
    const fd = fs.openSync(log, 'r')
    const buf = Buffer.alloc(size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = size
    const text = partial + buf.toString('utf8')
    const cut = text.lastIndexOf('\n')
    partial = text.slice(cut + 1)
    for (const e of parseLines(text.slice(0, cut + 1))) if (matches(e, f)) onEvent(e)
  }
  return setInterval(poll, 200)
}

function init(name) {
  const dir = process.cwd()
  const wb = path.join(dir, '.whiteboard')
  if (configFileIn(wb)) {
    console.log(`already a project: ${configFileIn(wb)}`)
    return
  }
  // the home folder is no repository: serving and watching all of it would be slow and expose everything
  const home = dir === os.homedir()
  // the markboard set ships in this package, and the server resolves its imports, so it always works
  fs.mkdirSync(path.join(wb, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(wb, 'config.ts'), `import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'

export default defineConfig({
${name ? `  name: '${name}',\n` : ''}${home ? '  // only .whiteboard/ is served: this folder is not a repository\n  files: false,\n' : ''}  renderers: [
    markboard(),
  ],
})
`)
  fs.writeFileSync(path.join(wb, '.gitignore'), `# pages are working documents; remove this line to keep them in git
pages/
# events from the pages (and which ones an agent picked up), and the running server's port and output
events.ndjson
server.json
server.log
server.lock
`)
  console.log(`project: ${wb}
  pages:     ${path.join(wb, 'pages')} (gitignored); \`whiteboard show <page>\` starts the server
  config:    ${path.join(wb, 'config.ts')}`)
}

/**
 * Claude Code hooks that report `whiteboard status`, none of which ever blocks: when a turn ends,
 * the reader sees what nobody listens for; a message the reader sends, and a new session, bring in
 * the answers no agent picked up. Added to the project's .claude/settings.json, or the user's.
 */
function installHooks(user, dir = user ? null : needProject().dir) {
  const file = user ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(dir, '.claude', 'settings.json')
  let settings = {}
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error(`${file} is not valid JSON; fix it first`) }
  }
  // the hooks run outside any project folder's node_modules/.bin, so name the command that works here
  const onPath = spawnSync('sh', ['-c', 'command -v whiteboard'], { encoding: 'utf8' }).status === 0
  const bin = onPath ? 'whiteboard' : 'npx whiteboard'
  const added = []
  settings.hooks ??= {}
  for (const [event, mode] of [['Stop', 'stop'], ['UserPromptSubmit', 'prompt'], ['SessionStart', 'session']]) {
    const groups = (settings.hooks[event] ??= [])
    if (groups.some(g => g.hooks?.some(h => /\bwhiteboard status --hook\b/.test(h.command ?? '')))) continue
    groups.push({ hooks: [{ type: 'command', command: `${bin} status --hook ${mode}` }] })
    added.push(event)
  }
  if (!added.length) { console.log(`hooks already installed: ${file}`); return }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(`${file}.tmp`, file)
  console.log(`hooks added to ${file}: ${added.join(', ')}`)
}

/** Ask a yes/no question on the terminal; no terminal (an agent running the command) means no. */
async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

// ---- status ------------------------------------------------------------------------------------

const SESSION = process.env.CLAUDE_CODE_SESSION_ID ?? null
const relFile = file => path.relative(process.cwd(), file) || file

/** What is open on a page, one line each; the command that picks it up comes last, once. */
function statusLines(p, { waiting = true } = {}) {
  const lines = []
  if (p.unpicked.length) lines.push(`${p.unpicked.length} answer${p.unpicked.length > 1 ? 's' : ''} no agent picked up (${[...new Set(p.unpicked.map(e => e.type))].join(', ')})`)
  if (p.unheard.length) lines.push(`nobody listens for ${p.unheard.join(', ')}`)
  if (lines.length) lines.push(`→ whiteboard wait --page ${relFile(p.file)}`)
  const heard = p.open.filter(t => !p.unheard.includes(t))
  if (waiting && heard.length) lines.push(`waiting for the reader: ${heard.join(', ')}`)
  return lines
}

const whose = (p, session) => (p.owner && p.owner === session ? 'yours' : p.owner ? `session ${p.owner.slice(0, 8)}` : 'no session')

/** stdin of a hook: the JSON Claude Code passes it, or nothing. */
function hookInput() {
  if (process.stdin.isTTY) return {}
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') } catch { return {} }
}

async function status() {
  const hook = opts.hook
  if (hook && !['stop', 'prompt', 'session'].includes(hook)) throw new Error('--hook is one of: stop, prompt, session')
  // a hook runs in every folder Claude Code works in: outside a project it has nothing to say
  if (hook && !project) return
  const proj = needProject()
  const input = hook ? hookInput() : {}
  const session = input.session_id ?? SESSION
  const pages = await api(`/api/status${opts.page ? `?page=${encodeURIComponent(pageId(proj, opts.page))}` : ''}`)
  const busy = pages.filter(p => p.unpicked.length || p.open.length)
  const mine = busy.filter(p => session && p.owner === session)

  if (!hook) {
    if (!busy.length) { console.log('nothing open: every question is answered, and every answer picked up'); return }
    for (const p of busy) {
      console.log(`${p.page} (${whose(p, session)})`)
      for (const l of statusLines(p)) console.log(`  ${l}`)
    }
    return
  }

  if (hook === 'stop') {
    // shown to the reader when a turn ends, never blocking it: what on this session's pages nobody listens for
    const loose = mine.filter(p => p.unheard.length || p.unpicked.length)
    if (!loose.length) return
    const said = p => { const l = statusLines(p, { waiting: false }); return `${l.slice(0, -1).join('; ')} ${l.at(-1)}` }
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
      for (const e of p.unpicked) markPicked(proj.eventsFile, e)
    }
    if (p.unheard.length) out.push(`Nobody listens for ${p.unheard.join(', ')} on your page ${p.page}: run \`whiteboard wait --page ${relFile(p.file)}\` in the background.`)
  }
  if (hook === 'session') {
    // a new session may carry on work another one started: say what is open elsewhere, without handing it over
    const others = busy.filter(p => !mine.includes(p))
    if (others.length) {
      out.push('Other pages in this whiteboard project with something open (not this session\'s; their answers stay for whoever waits on them):')
      for (const p of others) out.push(`- ${p.page} (${whose(p, session)}): ${statusLines(p).join(' ')}`)
    }
  }
  if (out.length) console.log(out.join('\n'))
}

switch (cmd) {
  case 'serve': {
    const proj = needProject()
    const base = await running(proj)
    if (base) { console.error(`whiteboard: ${proj.name} is already served at ${base}`); process.exit(1) }
    const { start } = await import('../src/server.js')
    await start()
    break
  }
  case 'init': {
    const before = configFileIn(path.join(process.cwd(), '.whiteboard'))
    init(positionals[0])
    if (!before && await confirm('Add Claude Code hooks that tell you and the agent what is unanswered or unheard (.claude/settings.json)?')) installHooks(false, process.cwd())
    else if (!before) console.log('  hooks:     not added; `whiteboard hooks install` adds them later')
    break
  }
  case 'root': {
    const dir = needProject().pagesDir
    fs.mkdirSync(dir, { recursive: true })
    console.log(dir)
    break
  }
  case 'new': {
    // claim a page: the exclusive create fails when the file exists, so two agents asking at once
    // never get the same page; the second gets name-2
    const name = (positionals[0] ?? '').replace(/\\/g, '/').replace(/\.md$/, '').replace(/^\/+|\/+$/g, '')
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..' || part === '-' || part === '_'))
      throw new Error('usage: whiteboard new <name>   (a page name like plan or task/plan)')
    const proj = needProject()
    // a name with submits in the log stays taken after its page is deleted, so a new page never
    // receives the answers of an old one
    const answered = new Set(readEvents(proj.eventsFile).map(e => e.page))
    for (let n = 1; ; n++) {
      const id = n === 1 ? name : `${name}-${n}`
      if (answered.has(id)) continue
      const file = path.join(proj.pagesDir, `${id}.md`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try {
        fs.writeFileSync(file, '', { flag: 'wx' })
        // the session that made the page: the hooks report a page to the session it belongs to
        if (SESSION) appendEvent(proj.eventsFile, { page: id, type: CLAIM, data: { session: SESSION } }, 'cli')
        console.log(file)
        break
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
    }
    break
  }
  case 'show':
  case 'url': {
    if (cmd === 'show' && !positionals[0]) throw new Error('usage: whiteboard show <page|file>')
    const base = await ensureServer()
    console.log(`${base}/${pageId(project, positionals[0] ?? '')}`)
    break
  }
  case 'docs': {
    // what each renderer says about writing pages for it: for markboard, the syntax of its templates
    const info = await api('/api/docs')
    for (const e of info.errors) console.error(`config error: ${e}`)
    if (!info.renderers.length) console.log('This project has no renderers: pages show as their raw text. Add them to `renderers` in .whiteboard/config.ts.')
    for (const r of info.renderers) {
      console.log(`<!-- renderer: ${r.name} -->`)
      console.log(r.docs ? r.docs.trim() : `# ${r.name}\n\n(no documentation)`)
      console.log()
    }
    break
  }
  case 'events': {
    const f = filter()
    let list = readEvents(needProject().eventsFile).filter(e => matches(e, f))
    if (opts.since) {
      const i = list.findIndex(e => e.id === opts.since)
      list = i >= 0 ? list.slice(i + 1) : list.filter(e => e.ts > opts.since)
    }
    if (opts.last) list = list.slice(-Number(opts.last))
    for (const e of list) console.log(JSON.stringify(e))
    break
  }
  case 'wait':
  case 'watch': {
    // Events nobody picked up yet come first, also those from before the command started; then new
    // ones. Handing one out appends a `whiteboard:picked` event naming it, so the log itself says
    // what was handed out: no later wait, whatever its filter, hands it out again, and an answer is
    // never lost between two commands. While it runs, a wait gets every new matching event, also
    // when another wait gets it too. `wait` stops after --count events (default 1); `watch` never does.
    const proj = needProject()
    const f = filter()
    const want = cmd === 'wait' ? Number(opts.count ?? 1) : Infinity
    let got = 0
    const hand = e => {
      console.log(JSON.stringify(e))
      markPicked(proj.eventsFile, e)
      if (++got >= want) process.exit(0)
    }
    // the backlog and the follow split the log at one offset, so no event falls between them
    const offset = logSize(proj.eventsFile)
    // events the command line wrote (an agent's own reply, say) are not answers to wait for
    const heard = e => matches(e, f) && e.from !== 'cli'
    const before = readEventsUpTo(proj.eventsFile, offset)
    const picked = pickedUp(before)
    for (const e of before.filter(e => heard(e) && !picked.has(e.id))) hand(e)
    follow(e => { if (e.from !== 'cli') hand(e) }, offset)
    listen(f, cmd)
    if (opts.timeout && cmd === 'wait') setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(opts.timeout) * 1000)
    break
  }
  case 'append': {
    // the agent's side of the log: anything a page's renderer understands, such as a reply to a
    // comment. Waits skip what is appended here, so an agent does not hear its own events.
    const proj = needProject()
    if (!opts.page || !opts.type) throw new Error("usage: whiteboard append --page <page|file> --type <type> [--data '<json>']")
    let data = {}
    if (opts.data) {
      try { data = JSON.parse(opts.data) } catch { throw new Error('--data must be JSON, e.g. \'{"text":"…"}\'') }
    }
    console.log(JSON.stringify(appendEvent(proj.eventsFile, { page: pageId(proj, opts.page), type: opts.type, data }, 'cli')))
    break
  }
  case 'status':
    // a hook that fails must not get in the way of the session it runs in: say why, and exit cleanly
    try { await status() } catch (err) {
      if (!opts.hook) throw err
      console.error(`whiteboard status: ${err.message}`)
    }
    break
  case 'hooks': {
    if (positionals[0] !== 'install') throw new Error('usage: whiteboard hooks install [--user]')
    installHooks(!!opts.user)
    break
  }
  case 'skill': {
    // the agent skill ships in this package; link it into whatever folder an agent reads skills from
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'whiteboard')
    if (!positionals[0]) { console.log(source); break }
    const target = path.join(path.resolve(positionals[0].replace(/^~(?=$|\/)/, os.homedir())), 'whiteboard')
    let existing = null
    try { existing = fs.lstatSync(target) } catch {}
    if (existing) {
      if (existing.isSymbolicLink() && path.resolve(path.dirname(target), fs.readlinkSync(target)) === source) {
        console.log(`already linked: ${target} -> ${source}`)
        break
      }
      console.error(`whiteboard: ${target} already exists; remove it first to link the skill there`)
      process.exit(1)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(source, target)
    console.log(`linked: ${target} -> ${source}`)
    break
  }
  default:
    console.log(HELP)
    if (cmd && cmd !== 'help' && !opts.help) process.exit(1)
}
