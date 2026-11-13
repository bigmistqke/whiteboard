#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { pageId, findProjectDir, project as projectAt, configFileIn } from '../src/config.js'
import { parseLines, readEvents, matches } from '../src/events.js'

const HELP = `visualize — markdown pages in the browser, form submits in an ndjson log

  visualize init [name]           make this folder a project: .visualize/{config.ts,pages/}
  visualize root                  print where pages go (this project's .visualize/pages)
  visualize show <page|file>      start this project's server if needed, print the page URL
  visualize url <page|file>       the same: print the page URL
  visualize docs [template…]      print template syntax (readmes) — read before writing a page
  visualize templates             list the templates this project's pages can use
  visualize events [filters]      print recorded submits as ndjson
  visualize wait [filters]        block until the next matching submit, print it, exit
  visualize watch [filters]       print matching submits as they arrive (never exits)
  visualize serve                 run this project's server in the foreground

filters: --page <page|file> (includes pages below it)  --form <name>
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
events:  --since <iso time or event id>  --last <n>

Every command works on the project of the current folder: the nearest folder upward with
.visualize/config.ts. Each project runs its own server; its port is in .visualize/server.json.
Submitting a <form name="…"> on a page appends {id, ts, page, form, action, data} to
.visualize/events.ndjson.`

const [cmd, ...rest] = process.argv.slice(2)
const { values: opts, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    page: { type: 'string' }, form: { type: 'string' }, timeout: { type: 'string' }, count: { type: 'string' },
    since: { type: 'string' }, last: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
})

const project = projectAt(findProjectDir())

/** The current project, or exit with how to make one. */
function needProject() {
  if (project) return project
  console.error(`visualize: not inside a project (no .visualize/config.ts in ${process.cwd()} or above it).
Run \`visualize init\` in the folder that should become one.`)
  process.exit(1)
}

const filter = () => ({ page: opts.page ? pageId(needProject(), opts.page) : undefined, form: opts.form })

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

/** Follow the event log from its current end, calling `onEvent` for each matching new line. */
function follow(onEvent) {
  const log = needProject().eventsFile
  const f = filter()
  let offset = fs.existsSync(log) ? fs.statSync(log).size : 0
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
  const vz = path.join(dir, '.visualize')
  if (configFileIn(vz)) {
    console.log(`already a project: ${configFileIn(vz)}`)
    return
  }
  // the home folder is no repository: serving and watching all of it would be slow and expose everything
  const home = dir === os.homedir()
  // offer the basic set when this project can import it
  let basic = false
  try { createRequire(path.join(dir, 'package.json')).resolve('@visualize/templates-basic'); basic = true } catch {}
  fs.mkdirSync(path.join(vz, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(vz, 'config.ts'), `import { defineConfig } from '@visualize/engine/config'
${basic ? '' : '// '}import basic from '@visualize/templates-basic'

export default defineConfig({
${name ? `  name: '${name}',\n` : ''}${home ? '  // only .visualize/ is served: this folder is not a repository\n  files: false,\n' : ''}  templates: [
    ${basic ? '' : '// '}basic(),
  ],
})
`)
  fs.writeFileSync(path.join(vz, '.gitignore'), `# pages are working documents; remove this line to keep them in git
pages/
# form submits from the pages, and the running server's port and output
events.ndjson
server.json
server.log
`)
  console.log(`project: ${vz}
  pages:     ${path.join(vz, 'pages')} (gitignored); \`visualize show <page>\` starts the server
  config:    ${path.join(vz, 'config.ts')}${basic ? '' : `
  templates: none yet. Install a set (npm i -D @visualize/templates-basic) and uncomment it in config.ts`}`)
}

switch (cmd) {
  case 'serve': {
    const proj = needProject()
    const base = await running(proj)
    if (base) { console.error(`visualize: ${proj.name} is already served at ${base}`); process.exit(1) }
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
  case 'show':
  case 'url': {
    if (cmd === 'show' && !positionals[0]) throw new Error('usage: visualize show <page|file>')
    const base = await ensureServer()
    console.log(`${base}/${pageId(project, positionals[0] ?? '')}`)
    break
  }
  case 'templates': {
    const info = await api('/api/templates')
    for (const e of info.errors) console.error(`config error: ${e}`)
    for (const t of info.templates)
      console.log(`${t.name.padEnd(14)} ${[t.html && 'html', t.props && 'props', t.client && 'client', t.code && 'code'].filter(Boolean).join('+').padEnd(18)} ${t.source}`)
    if (!info.templates.length) console.log('no templates; add them to the templates array of .visualize/config.ts')
    break
  }
  case 'docs': {
    const info = await api('/api/templates')
    for (const e of info.errors) console.error(`config error: ${e}`)
    const chosen = positionals.length ? info.templates.filter(t => positionals.includes(t.name)) : info.templates
    if (!chosen.length) console.log(positionals.length ? `no template named ${positionals.join(', ')}` : 'no templates configured for this project')
    for (const t of chosen) {
      console.log(`<!-- template: ${t.name} -->`)
      console.log(t.readme ? t.readme.trim() : `# ${t.name}\n\n(no readme)`)
      console.log()
    }
    console.log('Also: plain markdown, GFM tables, <details>, and raw HTML <form name="…"> work without templates.')
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
  case 'wait': {
    const want = Number(opts.count ?? 1)
    let got = 0
    follow(e => {
      console.log(JSON.stringify(e))
      if (++got >= want) process.exit(0)
    })
    if (opts.timeout) setTimeout(() => { console.error('timeout'); process.exit(2) }, Number(opts.timeout) * 1000)
    break
  }
  case 'watch':
    follow(e => console.log(JSON.stringify(e)))
    break
  default:
    console.log(HELP)
    if (cmd && cmd !== 'help' && !opts.help) process.exit(1)
}
