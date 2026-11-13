#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ROOT, BASE_URL, EVENTS_FILE, pageId, findProjectDir, projectName, register, configFileIn } from '../src/config.js'
import { parseLines, readEvents, matches } from '../src/events.js'

const HELP = `visualize — markdown pages in the browser, form submits in an ndjson log

  visualize init [name]           make this folder a project: .visualize/{config.ts,pages/}
  visualize root                  print where pages go (this project's pages folder, else ${ROOT})
  visualize show <page|file>      start the server if needed, print the page URL
  visualize url <page|file>       print the page URL
  visualize docs [template…]      print template syntax (readmes) — read before writing a page
  visualize templates             list the templates this project's pages can use
  visualize events [filters]      print recorded submits as ndjson
  visualize wait [filters]        block until the next matching submit, print it, exit
  visualize watch [filters]       print matching submits as they arrive (never exits)
  visualize serve                 run the server in the foreground

filters: --page <page|file> (includes pages below it)  --form <name>
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
events:  --since <iso time or event id>  --last <n>

Inside a project, a bare page name means a page of that project: \`visualize show plan\` → /<project>/plan.
Submitting a <form name="…"> on a page appends {id, ts, page, form, action, data} to ${EVENTS_FILE}.`

const [cmd, ...rest] = process.argv.slice(2)
const { values: opts, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    page: { type: 'string' }, form: { type: 'string' }, timeout: { type: 'string' }, count: { type: 'string' },
    since: { type: 'string' }, last: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
})

// keep the registry pointing at this project, so a cloned or moved repo just works
const projectDir = findProjectDir()
const project = projectDir ? { dir: projectDir, name: projectName(projectDir) } : null
if (project && cmd !== 'init') register(project.name, project.dir)

const filter = { page: opts.page ? pageId(opts.page) : undefined, form: opts.form }
const urlFor = target => `${BASE_URL}/${pageId(target)}`

async function healthy() {
  try { return (await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(800) })).ok } catch { return false }
}

async function ensureServer() {
  if (await healthy()) return
  const log = fs.openSync(path.join(ROOT, 'server.log'), 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (await healthy()) return
  }
  throw new Error(`server did not start; see ${path.join(ROOT, 'server.log')}`)
}

async function api(route) {
  await ensureServer()
  const res = await fetch(`${BASE_URL}${route}`)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

/** Follow events.ndjson from its current end, calling `onEvent` for each matching new line. */
function follow(onEvent) {
  let offset = fs.existsSync(EVENTS_FILE) ? fs.statSync(EVENTS_FILE).size : 0
  let partial = ''
  const poll = () => {
    if (!fs.existsSync(EVENTS_FILE)) return
    const size = fs.statSync(EVENTS_FILE).size
    if (size < offset) offset = 0 // truncated
    if (size === offset) return
    const fd = fs.openSync(EVENTS_FILE, 'r')
    const buf = Buffer.alloc(size - offset)
    fs.readSync(fd, buf, 0, buf.length, offset)
    fs.closeSync(fd)
    offset = size
    const text = partial + buf.toString('utf8')
    const cut = text.lastIndexOf('\n')
    partial = text.slice(cut + 1)
    for (const e of parseLines(text.slice(0, cut + 1))) if (matches(e, filter)) onEvent(e)
  }
  return setInterval(poll, 200)
}

function init(name) {
  const dir = process.cwd()
  const vz = path.join(dir, '.visualize')
  if (configFileIn(vz)) {
    console.log(`already a project: ${configFileIn(vz)}`)
    register(projectName(dir), dir)
    return
  }
  name ||= path.basename(dir).toLowerCase().replace(/[^\w.-]+/g, '-')
  // offer the basic set when this project can import it
  let basic = false
  try { createRequire(path.join(dir, 'package.json')).resolve('@visualize/templates-basic'); basic = true } catch {}
  fs.mkdirSync(path.join(vz, 'pages'), { recursive: true })
  fs.writeFileSync(path.join(vz, 'config.ts'), `import { defineConfig } from '@visualize/engine/config'
${basic ? '' : '// '}import basic from '@visualize/templates-basic'

export default defineConfig({
  name: '${name}',
  templates: [
    ${basic ? '' : '// '}basic(),
  ],
})
`)
  fs.writeFileSync(path.join(vz, '.gitignore'), '# pages are working documents; remove this line to keep them in git\npages/\n')
  register(name, dir)
  console.log(`project "${name}": ${vz}
  pages:     ${path.join(vz, 'pages')} (gitignored)  →  ${BASE_URL}/${name}/
  config:    ${path.join(vz, 'config.ts')}${basic ? '' : `
  templates: none yet. Install a set (npm i -D @visualize/templates-basic) and uncomment it in config.ts`}`)
}

switch (cmd) {
  case 'serve': {
    const { start } = await import('../src/server.js')
    start()
    break
  }
  case 'init':
    init(positionals[0])
    break
  case 'root': {
    const dir = project ? path.join(project.dir, '.visualize', 'pages') : ROOT
    fs.mkdirSync(dir, { recursive: true })
    console.log(dir)
    break
  }
  case 'show': {
    if (!positionals[0]) throw new Error('usage: visualize show <page|file>')
    await ensureServer()
    console.log(urlFor(positionals[0]))
    break
  }
  case 'url':
    console.log(urlFor(positionals[0] ?? ''))
    break
  case 'templates': {
    const info = await api(`/api/templates${project ? `?project=${encodeURIComponent(project.name)}` : ''}`)
    for (const e of info.errors) console.error(`config error: ${e}`)
    for (const t of info.templates)
      console.log(`${t.name.padEnd(14)} ${[t.html && 'html', t.props && 'props', t.client && 'client'].filter(Boolean).join('+').padEnd(18)} ${t.source}`)
    if (!info.templates.length) console.log('no templates; add them to the templates array of .visualize/config.ts')
    break
  }
  case 'docs': {
    const info = await api(`/api/templates${project ? `?project=${encodeURIComponent(project.name)}` : ''}`)
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
    let list = readEvents().filter(e => matches(e, filter))
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
