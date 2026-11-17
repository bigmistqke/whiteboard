#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pageId, findProjectDir, project as projectAt, configFileIn, type Project } from '../src/config.ts'
import { appendEvent, read, readEvents, follow, matches, pickedUp, pick, handOut, CLAIM, type EventFilter } from '../src/events.ts'
import { BUILTIN_COMMANDS, createConfigLoader, pluginDir } from '../src/renderers.ts'
import { pluginCommands, parseCommandArgs, usage } from '../src/plugins.ts'
import { projectToken } from '../src/auth.ts'
import { packagePath } from '../src/package.ts'
import { runningServer } from '../src/running.ts'
import { statusLines, whose } from '../src/status.ts'
import type { PageStatus, WbEvent } from '../src/define.ts'

// a failing command prints its message, not a stack trace
const fail = (err: unknown) => {
  console.error(`whiteboard: ${(err as Error)?.message ?? err}`)
  process.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

const HELP = `whiteboard — markdown pages in the browser, what the reader does on them as events in an ndjson log

  whiteboard init [name]           make this folder a project: .whiteboard/pages/
  whiteboard root                  print where pages go (this project's .whiteboard/pages)
  whiteboard new <name>           create a page under a name no other page has (name, name-2, …), print its path
  whiteboard show <page|file>      start this project's server if needed, print the page URL
  whiteboard url <page|file>       the same: print the page URL
  whiteboard docs                  how to write pages here (for markboard: its templates) — read before writing one
  whiteboard events [filters]      print recorded events as ndjson; --follow: then each new one as it comes
  whiteboard wait [filters]        block until the next matching event, print it, exit
  whiteboard watch [filters]       like wait, but never exits: print each matching event once
  whiteboard append --page <p> --type <t> [--data <json>]   add an event to a page's log (e.g. a reply)
  whiteboard pick <event id>       record an event as picked up, as wait does when it hands one out
  whiteboard status [--page <p>]   per page: questions without an answer, answers no agent picked up, who listens
  whiteboard serve                 run this project's server in the foreground
  whiteboard skill [dir]          print where the agent skill is, or link it into a skills folder

filters: --page <page|file> (includes pages below it)  --type <type>
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
events:  --since <iso time or event id>  --last <n>

Every command works on the project of the current folder: the nearest folder upward with a
.whiteboard/ folder. A project needs no config: .whiteboard/config.ts only says what differs from
the defaults (markdown with markboard, no plugins). Each project runs its own server; its port is in .whiteboard/server.json.
A page appends events {id, ts, page, type, action, data} to .whiteboard/events.ndjson;
which types it sends is up to its renderer (\`whiteboard docs\` says). The project's plugins
can add commands of their own; \`whiteboard help\` in a project lists them.`

const [cmd, ...rest] = process.argv.slice(2)
// a plugin's command parses its own arguments
const { values: opts, positionals } = cmd && !BUILTIN_COMMANDS.has(cmd) ? { values: {}, positionals: [] } : parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    page: { type: 'string' }, type: { type: 'string' }, data: { type: 'string' }, timeout: { type: 'string' }, count: { type: 'string' },
    since: { type: 'string' }, last: { type: 'string' }, follow: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
})

const project = projectAt(findProjectDir())

/** The current project, or exit with how to make one. */
function needProject(): Project {
  if (project) return project
  console.error(`whiteboard: not inside a project (no .whiteboard/ folder in ${process.cwd()} or above it).
Run \`whiteboard init\` in the folder that should become one.`)
  process.exit(1)
}

const filter = (): EventFilter => ({ page: opts.page ? pageId(needProject(), opts.page) : undefined, type: opts.type })

/** The running server of this project: its base URL, or null. */
const running = (proj: Project) => runningServer(proj)

/** This project's server, started in the background when it is not running. @returns its base URL */
async function ensureServer(): Promise<string> {
  const proj = needProject()
  const base = await running(proj)
  if (base) return base
  // Several commands may get here at once (an agent starting three watches, say): the one that
  // creates the lock file starts the server, the others wait for it. A lock whose command is gone
  // is left over, and taken over. (Should two servers still start, the server lets one survive.)
  const lock = path.join(proj.wb, 'server.lock')
  const claim = () => {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
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
      try { process.kill(owner, 0) } catch (err) { stale = (err as NodeJS.ErrnoException).code === 'ESRCH' }
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

async function api(route: string): Promise<any> {
  const res = await fetch(`${await ensureServer()}${route}`)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

/**
 * Tell the project's server that an agent is waiting, for as long as this command runs: pages show
 * what is waited for. Holds one connection open, the listener; reconnects when the server restarts.
 * Reading the log does not depend on it, so answers are never missed when the server is away.
 */
function listen(f: EventFilter, command: 'wait' | 'watch') {
  const connect = async () => {
    let base
    try { base = await ensureServer() } catch { return setTimeout(connect, 2000).unref() }
    const q = new URLSearchParams({ command, ...(f.page ? { page: f.page } : {}), ...(f.type ? { type: f.type } : {}) })
    let again = false
    const retry = (ms: number) => { if (!again) { again = true; setTimeout(connect, ms).unref() } }
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

function init(name: string | undefined) {
  const dir = process.cwd()
  const wb = path.join(dir, '.whiteboard')
  if (fs.existsSync(wb)) {
    console.log(`already a project: ${wb}`)
    return
  }
  // the home folder is no repository: serving and watching all of it would be slow and expose everything
  const home = dir === os.homedir()
  // a name other than the folder's
  const named = name && name !== path.basename(dir)
  fs.mkdirSync(path.join(wb, 'pages'), { recursive: true })
  // a config only for what differs from the defaults
  if (named || home) fs.writeFileSync(path.join(wb, 'config.ts'), `import { defineConfig } from '@bigmistqke/whiteboard'

export default defineConfig({
${named ? `  name: '${name}',\n` : ''}${home ? '  // only .whiteboard/ is served: this folder is not a repository\n  files: false,\n' : ''}})
`)
  fs.writeFileSync(path.join(wb, '.gitignore'), `# pages are working documents; remove this line to keep them in git
pages/
# events from the pages (and which ones an agent picked up), and the running server's port and output
events.ndjson
server.json
server.log
server.lock
# the secret for anything that runs code (a plugin like the terminal)
token
`)
  console.log(`project: ${wb}
  pages:     ${path.join(wb, 'pages')} (gitignored); \`whiteboard show <page>\` starts the server
  config:    ${configFileIn(wb) ?? `none: the defaults (markdown with markboard, no plugins); add ${path.join(wb, 'config.ts')} to change them`}`)
}

// ---- status ------------------------------------------------------------------------------------

const relFile = (file: string) => path.relative(process.cwd(), file) || file

/**
 * The project's config, as the command line needs it: for its plugins (their commands, the
 * session), so without the default renderer. Loaded once per command.
 */
let loaded: ReturnType<ReturnType<typeof createConfigLoader>['config']> | null = null
const projectConfig = (proj: Project) => (loaded ??= createConfigLoader(proj, { renderers: false }).config())

/**
 * The agent session this command runs in, as the project's plugins know it (Claude Code's
 * plugin reads it from the environment): the first one that names one. Null without any.
 */
async function currentSession(proj: Project): Promise<string | null> {
  try {
    for (const e of (await projectConfig(proj)).plugins) {
      const session = typeof e.session === 'function' ? await e.session() : null
      if (session) return String(session)
    }
  } catch (err) { console.error(`whiteboard: which session runs this: ${(err as Error).message}`) }
  return null
}


async function status() {
  const proj = needProject()
  const [pages, session]: [PageStatus[], string | null] = await Promise.all([
    api(`/api/status${opts.page ? `?page=${encodeURIComponent(pageId(proj, opts.page))}` : ''}`),
    currentSession(proj),
  ])
  const busy = pages.filter(p => p.unpicked.length || p.open.length)
  if (!busy.length) { console.log('nothing open: every question is answered, and every answer picked up'); return }
  for (const p of busy) {
    console.log(`${p.page} (${whose(p, session)})`)
    for (const l of statusLines(p, relFile(p.file))) console.log(`  ${l}`)
  }
}

switch (cmd) {
  case 'serve': {
    const proj = needProject()
    const base = await running(proj)
    if (base) { console.error(`whiteboard: ${proj.name} is already served at ${base}`); process.exit(1) }
    const { start } = await import('../src/serve.ts')
    await start(proj)
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
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
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
    if (!info.renderers.length) console.log('This project has no renderers: pages show as their raw text. Its config sets `renderers: []`.')
    for (const r of info.renderers) {
      console.log(`<!-- renderer: ${r.name} -->`)
      console.log(r.docs ? r.docs.trim() : `# ${r.name}\n\n(no documentation)`)
      console.log()
    }
    for (const e of info.plugins ?? []) {
      console.log(`<!-- plugin: ${e.name} -->\n# Plugin: ${e.name}\n`)
      if (e.error) console.log(`It failed to load: ${e.error}\n`)
      if (e.docs) console.log(`${e.docs.trim()}\n`)
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
    // the log as it is: every matching event, also the agent's own, and nothing marked as picked up
    const f = filter()
    const log = needProject().eventsFile
    const { events, end } = read(log)
    let list = events.filter(e => matches(e, f))
    if (opts.since) {
      const i = list.findIndex(e => e.id === opts.since)
      const since = opts.since
      list = i >= 0 ? list.slice(i + 1) : list.filter(e => e.ts > since)
    }
    if (opts.last) list = list.slice(-Number(opts.last))
    for (const e of list) console.log(JSON.stringify(e))
    if (opts.follow) follow(log, end, e => { if (matches(e, f)) console.log(JSON.stringify(e)) })
    break
  }
  case 'pick': {
    // what a wait does when it hands an event out, for a script that hands out events itself
    const proj = needProject()
    const id = positionals[0]
    if (!id) throw new Error('usage: whiteboard pick <event id>')
    const events = readEvents(proj.eventsFile)
    const event = events.find(e => e.id === id)
    if (!event) throw new Error(`no event ${id} in ${proj.eventsFile}`)
    if (pickedUp(events).has(id)) { console.error(`whiteboard: ${id} was picked up already`); break }
    console.log(JSON.stringify(pick(proj.eventsFile, event)))
    break
  }
  case 'wait':
  case 'watch': {
    // Each answer once, also one given before the command started, never the agent's own; see
    // handOut. `wait` stops after --count events (default 1); `watch` never does.
    const proj = needProject()
    const f = filter()
    handOut(proj.eventsFile, f, e => console.log(JSON.stringify(e)), { count: cmd === 'wait' ? Number(opts.count ?? 1) : Infinity })
      .then(() => process.exit(0))
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
    const source = packagePath('skills', 'whiteboard')
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
    // `whiteboard <plugin> [sub] …`: a command of one of the project's plugins
    const commands = project ? await projectCommands(project) : []
    const mine = commands.filter(c => c.plugin === cmd)
    const found = mine.find(c => c.sub && c.sub === rest[0]) ?? mine.find(c => !c.sub)
    if (found && project) {
      const args = found.sub ? rest.slice(1) : rest
      const { options, positionals, rest: after } = parseCommandArgs(found.command, args, found.name)
      await found.command.run({
        options,
        positionals,
        rest: after,
        project: { name: project.name, dir: project.dir, wb: project.wb },
        dataDir: pluginDir(project.wb, found.plugin),
        token: projectToken(project.wb),
        server: ensureServer,
        pagePath: page => `/${pageId(project, page ?? '')}`,
        status: async page => api(`/api/status${page ? `?page=${encodeURIComponent(pageId(project, page))}` : ''}`),
        handOut: (filter, onEvent, options) => handOut(project.eventsFile, { ...filter, page: filter.page ? pageId(project, filter.page) : null }, onEvent, options),
        authLink: async to => `${await ensureServer()}/_/auth?token=${encodeURIComponent(projectToken(project.wb))}&to=${encodeURIComponent(to)}`,
      })
      break
    }
    // asked for, the help goes to standard output; after a command it doesn't know, to standard error
    const asked = !cmd || cmd === 'help' || opts.help
    const print = asked ? console.log : console.error
    print(HELP)
    if (commands.length) {
      print(`\nfrom this project's plugins:\n`)
      for (const c of commands) print(`  whiteboard ${[c.name, usage(c.command)].filter(Boolean).join(' ')}\n      ${c.command.description}`)
    }
    if (mine.length) console.error(`\nwhiteboard: ${cmd} has no command ${JSON.stringify(rest[0] ?? '')}`)
    if (!asked) process.exit(1)
  }
}

/** The commands the project's plugins add: `whiteboard <plugin> [sub]`. */
async function projectCommands(proj: Project) {
  const { plugins, errors } = await projectConfig(proj)
  for (const e of errors) console.error(`whiteboard: config error: ${(e as Error).message}`)
  return plugins.flatMap(pluginCommands)
}
