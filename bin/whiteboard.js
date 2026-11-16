#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pageId, findProjectDir, project as projectAt, configFileIn } from '../src/config.js'
import { appendEvent, parseLines, readEvents, matches, pickedUp, markPicked, CLAIM } from '../src/events.js'
import { BUILTIN_COMMANDS, createConfigLoader, extensionDir } from '../src/renderers.js'
import { extensionCommands, parseCommandArgs, usage } from '../src/extensions.js'
import { projectToken } from '../src/auth.js'

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
  whiteboard serve                 run this project's server in the foreground
  whiteboard skill [dir]          print where the agent skill is, or link it into a skills folder

filters: --page <page|file> (includes pages below it)  --type <type>
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
events:  --since <iso time or event id>  --last <n>

Every command works on the project of the current folder: the nearest folder upward with
.whiteboard/config.ts. Each project runs its own server; its port is in .whiteboard/server.json.
A page appends events {id, ts, page, type, action, data} to .whiteboard/events.ndjson;
which types it sends is up to its renderer (\`whiteboard docs\` says). The project's extensions
can add commands of their own; \`whiteboard help\` in a project lists them.`

const [cmd, ...rest] = process.argv.slice(2)
// an extension's command parses its own arguments
const { values: opts, positionals } = cmd && !BUILTIN_COMMANDS.has(cmd) ? { values: {}, positionals: [] } : parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    page: { type: 'string' }, type: { type: 'string' }, data: { type: 'string' }, timeout: { type: 'string' }, count: { type: 'string' },
    since: { type: 'string' }, last: { type: 'string' }, help: { type: 'boolean', short: 'h' },
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
# the secret for anything that runs code (an extension like the terminal)
token
`)
  console.log(`project: ${wb}
  pages:     ${path.join(wb, 'pages')} (gitignored); \`whiteboard show <page>\` starts the server
  config:    ${path.join(wb, 'config.ts')}`)
}

// ---- status ------------------------------------------------------------------------------------

const relFile = file => path.relative(process.cwd(), file) || file

/**
 * The agent session this command runs in, as the project's extensions know it (Claude Code's
 * extension reads it from the environment): the first one that names one. Null without any.
 */
async function currentSession(proj) {
  try {
    const { config } = createConfigLoader(proj.configFile)
    for (const e of (await config()).extensions) {
      const session = typeof e.session === 'function' ? await e.session() : null
      if (session) return String(session)
    }
  } catch (err) { console.error(`whiteboard: which session runs this: ${err.message}`) }
  return null
}

/** What is open on a page, one line each; the command that picks it up comes last, once. */
function statusLines(p) {
  const lines = []
  if (p.unpicked.length) lines.push(`${p.unpicked.length} answer${p.unpicked.length > 1 ? 's' : ''} no agent picked up (${[...new Set(p.unpicked.map(e => e.type))].join(', ')})`)
  if (p.unheard.length) lines.push(`nobody listens for ${p.unheard.join(', ')}`)
  if (lines.length) lines.push(`→ whiteboard wait --page ${relFile(p.file)}`)
  const heard = p.open.filter(t => !p.unheard.includes(t))
  if (heard.length) lines.push(`waiting for the reader: ${heard.join(', ')}`)
  return lines
}

const whose = (p, session) => (p.owner && p.owner === session ? 'yours' : p.owner ? `session ${p.owner.slice(0, 8)}` : 'no session')

async function status() {
  const proj = needProject()
  const [pages, session] = await Promise.all([
    api(`/api/status${opts.page ? `?page=${encodeURIComponent(pageId(proj, opts.page))}` : ''}`),
    currentSession(proj),
  ])
  const busy = pages.filter(p => p.unpicked.length || p.open.length)
  if (!busy.length) { console.log('nothing open: every question is answered, and every answer picked up'); return }
  for (const p of busy) {
    console.log(`${p.page} (${whose(p, session)})`)
    for (const l of statusLines(p)) console.log(`  ${l}`)
  }
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
    init(positionals[0])
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
        // the session that made the page: what is open on it is reported to that session
        const session = await currentSession(proj)
        if (session) appendEvent(proj.eventsFile, { page: id, type: CLAIM, data: { session } }, 'cli')
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
    for (const e of info.extensions ?? []) {
      console.log(`<!-- extension: ${e.name} -->\n# Extension: ${e.name}\n`)
      if (e.error) console.log(`It failed to load: ${e.error}\n`)
      for (const c of e.commands) console.log(`- \`whiteboard ${[c.name, c.usage].filter(Boolean).join(' ')}\`: ${c.description}`)
      if (e.routes.length) console.log(`\nRoutes (\`auth\`: needs the project's token, header \`x-whiteboard-token\`):\n`)
      for (const r of e.routes) {
        const takes = [r.body && `body ${JSON.stringify(r.body)}`, r.query && `query ${JSON.stringify(r.query)}`, r.stream && 'server-sent events'].filter(Boolean).join(', ')
        console.log(`- \`${r.method} ${r.path}\`${r.auth ? ' (auth)' : ''}: ${r.description}${takes ? ` (${takes})` : ''}`)
      }
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
    await status()
    break
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
  default: {
    // `whiteboard <extension> [sub] …`: a command of one of the project's extensions
    const commands = project ? await projectCommands(project) : []
    const mine = commands.filter(c => c.extension === cmd)
    const found = mine.find(c => c.sub && c.sub === rest[0]) ?? mine.find(c => !c.sub)
    if (found) {
      const args = found.sub ? rest.slice(1) : rest
      const { options, positionals, rest: after } = parseCommandArgs(found.command, args, found.name)
      await found.command.run({
        options,
        positionals,
        rest: after,
        project: { name: project.name, dir: project.dir, wb: project.wb },
        dataDir: extensionDir(project.wb, found.extension),
        token: projectToken(project.wb),
        server: ensureServer,
        pagePath: page => `/${pageId(project, page ?? '')}`,
        status: async page => api(`/api/status${page ? `?page=${encodeURIComponent(pageId(project, page))}` : ''}`),
        pickUp: event => { markPicked(project.eventsFile, event) },
        authLink: async to => `${await ensureServer()}/_/auth?token=${encodeURIComponent(projectToken(project.wb))}&to=${encodeURIComponent(to)}`,
      })
      break
    }
    // asked for, the help goes to standard output; after a command it doesn't know, to standard error
    const asked = !cmd || cmd === 'help' || opts.help
    const print = asked ? console.log : console.error
    print(HELP)
    if (commands.length) {
      print(`\nfrom this project's extensions:\n`)
      for (const c of commands) print(`  whiteboard ${[c.name, usage(c.command)].filter(Boolean).join(' ')}\n      ${c.command.description}`)
    }
    if (mine.length) console.error(`\nwhiteboard: ${cmd} has no command ${JSON.stringify(rest[0] ?? '')}`)
    if (!asked) process.exit(1)
  }
}

/** The commands the project's extensions add: `whiteboard <extension> [sub]`. */
async function projectCommands(proj) {
  const { config } = createConfigLoader(proj.configFile)
  const { extensions, errors } = await config()
  for (const e of errors) console.error(`whiteboard: config error: ${e.message}`)
  return extensions.flatMap(extensionCommands)
}
