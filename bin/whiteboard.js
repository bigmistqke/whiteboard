#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pageId, findProjectDir, project as projectAt, configFileIn } from '../src/config.js'
import { parseLines, readEvents, matches } from '../src/events.js'

// a failing command prints its message, not a stack trace
const fail = err => {
  console.error(`whiteboard: ${err?.message ?? err}`)
  process.exit(1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

const HELP = `whiteboard — markdown pages in the browser, form submits and other events in an ndjson log

  whiteboard init [name]           make this folder a project: .whiteboard/{config.ts,pages/}
  whiteboard root                  print where pages go (this project's .whiteboard/pages)
  whiteboard new <name>           create a page under a name no other page has (name, name-2, …), print its path
  whiteboard show <page|file>      start this project's server if needed, print the page URL
  whiteboard url <page|file>       the same: print the page URL
  whiteboard docs                  how to write pages here (for basic: its templates) — read before writing one
  whiteboard events [filters]      print recorded events as ndjson
  whiteboard wait [filters]        block until the next matching event, print it, exit
  whiteboard watch [filters]       like wait, but never exits: print each matching event once
  whiteboard serve                 run this project's server in the foreground
  whiteboard skill [dir]          print where the agent skill is, or link it into a skills folder

filters: --page <page|file> (includes pages below it)  --type <type>  (a form's type is its name)
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
events:  --since <iso time or event id>  --last <n>

Every command works on the project of the current folder: the nearest folder upward with
.whiteboard/config.ts. Each project runs its own server; its port is in .whiteboard/server.json.
Submitting a <form name="…"> on a page appends {id, ts, page, type, action, data} to
.whiteboard/events.ndjson, with the form's name as its type.`

const [cmd, ...rest] = process.argv.slice(2)
if (rest.some(a => a === '--form' || a.startsWith('--form=')))
  throw new Error('--form is now --type: a form\'s events have its name as their type (--type <name>)')
const { values: opts, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    page: { type: 'string' }, type: { type: 'string' }, timeout: { type: 'string' }, count: { type: 'string' },
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
  const log = fs.openSync(proj.logFile, 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { cwd: proj.dir, detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200))
    const base = await running(proj)
    if (base) return base
  }
  throw new Error(`server did not start; see ${proj.logFile}`)
}

async function api(route) {
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
  // the basic set ships in this package, and the server resolves its imports, so it always works
  fs.mkdirSync(path.join(wb, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(wb, 'config.ts'), `import { defineConfig } from '@bigmistqke/whiteboard/config'
import basic from '@bigmistqke/whiteboard/basic'

export default defineConfig({
${name ? `  name: '${name}',\n` : ''}${home ? '  // only .whiteboard/ is served: this folder is not a repository\n  files: false,\n' : ''}  renderers: [
    basic(),
  ],
})
`)
  fs.writeFileSync(path.join(wb, '.gitignore'), `# pages are working documents; remove this line to keep them in git
pages/
# form submits from the pages, which ones \`whiteboard wait\` handed out, and the running server's port and output
events.ndjson
delivered.json
server.json
server.log
`)
  console.log(`project: ${wb}
  pages:     ${path.join(wb, 'pages')} (gitignored); \`whiteboard show <page>\` starts the server
  config:    ${path.join(wb, 'config.ts')}`)
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
  case 'init':
    init(positionals[0])
    break
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
    // what each renderer says about writing pages for it: for basic, the syntax of its templates
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
    // Events this filter has not handed out yet come first, also those from before the command
    // started; then new ones. What was handed out is kept per filter in delivered.json, so an
    // answer is neither lost between two commands (a wait after a wait, a watch restarted) nor
    // handed out twice. `wait` stops after --count events (default 1); `watch` never does.
    const proj = needProject()
    const f = filter()
    const key = `${f.page ?? ''}\0${f.type ?? ''}`
    let delivered = {}
    try { delivered = JSON.parse(fs.readFileSync(proj.deliveredFile, 'utf8')) } catch {}
    const want = cmd === 'wait' ? Number(opts.count ?? 1) : Infinity
    let got = 0
    const hand = e => {
      console.log(JSON.stringify(e))
      // another command may have handed out others meanwhile: merge, don't overwrite
      try { delivered = JSON.parse(fs.readFileSync(proj.deliveredFile, 'utf8')) } catch {}
      delivered[key] = { id: e.id, ts: e.ts }
      fs.writeFileSync(proj.deliveredFile, JSON.stringify(delivered, null, 2) + '\n')
      if (++got >= want) process.exit(0)
    }
    // the backlog and the follow split the log at one offset, so no event falls between them
    const offset = logSize(proj.eventsFile)
    const matching = readEventsUpTo(proj.eventsFile, offset).filter(e => matches(e, f))
    const last = delivered[key]
    const at = last ? matching.findIndex(e => e.id === last.id) : -1
    const backlog = !last ? matching : at >= 0 ? matching.slice(at + 1) : matching.filter(e => e.ts > last.ts)
    for (const e of backlog) hand(e)
    follow(hand, offset)
    listen(f, cmd)
    if (opts.timeout && cmd === 'wait') setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(opts.timeout) * 1000)
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
