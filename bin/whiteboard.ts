#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pageId, findProjectDir, project as projectAt, configFileIn, type Project } from '../src/config.ts'
import {
  appendEvent,
  read,
  readEvents,
  follow,
  matches,
  pickedUp,
  pick,
  prune,
  editEvent,
  handOut,
  CLAIM,
  type EventFilter,
  forAgent,
} from '../src/events.ts'
import { BUILTIN_COMMANDS, createConfigLoader, pluginDir } from '../src/loader.ts'
import { pluginCommands, parseCommandArgs, usage } from '../src/plugins.ts'
import { projectToken } from '../src/auth.ts'
import { PACKAGE_DIR, packagePath } from '../src/package.ts'
import { recordedSharedPort, runningServer, sharedServer } from '../src/running.ts'
import {
  machineDir,
  machineServerFile,
  matchesEntries,
  readMachineConfig,
  serverPaths,
  stateDir,
} from '../src/entries.ts'
import { compareVersions, VERSION } from '../src/package.ts'
import { statusLines, whose } from '../src/status.ts'
import { fallback as fallbackLoop, listen } from '../src/listen.ts'
import type { Listener, PageStatus } from '../src/define.ts'

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
  whiteboard new <name>            create a page under a name no other page has (name, name-2, …), print its path
  whiteboard show <page|file>      start this project's server if needed, print the page URL
  whiteboard url <page|file>       the same: print the page URL
  whiteboard close <page>          a page that did its job: remove its file, and its events from the log
  whiteboard prune <page> [--type <t>] [--id <id>]   remove a page's events from the log, keep the page
  whiteboard build [globs…] [--out <dir>] [--skip <a,b>]   pages as a static site: plain HTML, links
                                   relative, without forms, chats, comments and drafts (the config's build)
  whiteboard edit <event id> --data <json>   change an agent's own event in place (merged into its data)
  whiteboard scroll <page|file> <where>  scroll the tabs that have the page open to a heading's text,
                                   a form's name or any text on it (opening details around it)
  whiteboard docs [plugin]         how to write pages here: markdown, and each plugin's blocks — read before writing one;
                                   with a plugin's name, only its docs
  whiteboard events [filters]      print recorded events as ndjson; --follow: then each new one as it comes
  whiteboard wait [filters]        block until the next matching event, print it, exit
  whiteboard watch [filters]       like wait, but never exits: print each matching event once
  whiteboard append --page <p> --type <t> [--data <json>]   add an event to a page's log (e.g. a reply)
  whiteboard pick <event id>       record an event as picked up, as wait does when it hands one out
  whiteboard status [--page <p>]   per page: questions without an answer, answers no agent picked up, who listens
  whiteboard serve                 run this project's server in the foreground; for a project of the
                                   machine's entries, or outside any project, the shared server
  whiteboard skill [dir]           print where the agent skill is, or link it into a skills folder
  whiteboard paths [--write|--read]  the folders the shared server needs, ':' between them, for a sandbox
                                   wrapper to grant: --write the entries' folders and its state, --read
                                   the machine config and whiteboard itself

filters: --page <page|file> (includes pages below it)  --type <type>
wait:    --timeout <seconds> (exit 2 on timeout)  --count <n> (default 1)
wait, watch without --page: the fallback, taking only what no other wait or watch would, on any
         page, also once they stop; one per project (a second exits 1), or, in a project of the
         machine's entries, one for the whole entry, each event with its project and url
events:  --since <iso time or event id>  --last <n>

Every command works on the project of the current folder: the nearest folder upward with a
.whiteboard/ folder. A project needs no config: .whiteboard/config.ts only says what differs from
the defaults (markdown with the built-in plugins). Each project runs its own server; its port is in .whiteboard/server.json.
A project the machine config's entries include (${machineDir()}/config.json) is served by the one shared
server instead, under its path (/<entry>/<folder>), with an index of every entry at /. It is started
outside the agents' sandboxes (\`whiteboard serve\` outside any project, or a login service), and
\`serve\` takes an older one over; commands never start it. A wait without a server waits for one.
A page appends events {id, ts, page, type, action, data} to .whiteboard/events.ndjson;
which types it sends is up to its plugins (\`whiteboard docs\` says). The project's plugins
can add commands of their own; \`whiteboard help\` in a project lists them.`

const [first, ...rest] = process.argv.slice(2)
// `whiteboard --help` and `-h`, where a command goes, ask for the help as `whiteboard help` does
const cmd = first === '--help' || first === '-h' ? 'help' : first
// a plugin's command parses its own arguments
const { values: opts, positionals } =
  cmd && !BUILTIN_COMMANDS.has(cmd)
    ? { values: {}, positionals: [] }
    : parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          page: { type: 'string' },
          type: { type: 'string' },
          data: { type: 'string' },
          timeout: { type: 'string' },
          count: { type: 'string' },
          since: { type: 'string' },
          last: { type: 'string' },
          follow: { type: 'boolean' },
          id: { type: 'string' },
          out: { type: 'string' },
          skip: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
          write: { type: 'boolean' },
          read: { type: 'boolean' },
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

/**
 * Is this project one of the machine's entries (see src/entries.ts)? Then the shared server serves
 * it, under its path, and no server of its own runs. A project outside every include runs its own.
 */
function isShared(proj: Project): boolean {
  const config = readMachineConfig()
  return !!config && !!matchesEntries(config, proj.dir)
}

/**
 * The running server of this project: the URL it is served at (`http://localhost:4777`, or
 * `http://localhost:4777/rg/develop` under the shared server), or null.
 */
async function running(proj: Project): Promise<string | null> {
  if (!isShared(proj)) return runningServer(proj)
  const file = machineServerFile()
  const shared = await sharedServer(file)
  if (!shared) return null
  // a project made a moment ago: the server looks again
  const mine =
    shared.projects.find(p => p.dir === proj.dir) ??
    (await sharedServer(file, { rescan: true }))?.projects.find(p => p.dir === proj.dir)
  return mine ? `${shared.origin}${mine.base}` : null
}

/**
 * This project's server, started in the background when it is not running. Under the shared server
 * nothing is started: it is started outside every agent's sandbox (a login service, or `whiteboard
 * serve` in a terminal), since it serves every project of the entries and runs their plugins; a
 * command inside one sandbox would start it boxed in there. Only `show` and a plugin's command that
 * asks for the server get here. @returns the URL it serves the project at
 */
async function ensureServer(): Promise<string> {
  const proj = needProject()
  const shared = isShared(proj)
  const base = await running(proj)
  if (shared) {
    const server = await sharedServer(machineServerFile())
    if (base) {
      // an older one goes on serving: it is replaced by restarting it, from outside the sandboxes
      if (server && compareVersions(VERSION, server.version) > 0)
        console.error(
          `whiteboard: the shared server runs ${server.version}, this is ${VERSION}; restart it to upgrade (\`whiteboard serve\` takes it over)`,
        )
      return base
    }
    throw new Error(
      server
        ? `the shared server at ${server.origin} does not serve ${proj.dir}; is it in an include of ${machineDir()}/config.json?`
        : `the shared server is not running. It is started outside the agents' sandboxes: as a login service, or with \`whiteboard serve\` in a terminal, outside any project`,
    )
  }
  if (base) return base
  // Several commands may get here at once (an agent starting three watches, say): the one that
  // creates the lock file starts the server, the others wait for it. A lock whose command is gone
  // is left over, and taken over. (Should two servers still start, the server lets one survive.)
  const lock = path.join(proj.wb, 'server.lock')
  const claim = () => {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
      return true
    } catch (err) {
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
      try {
        process.kill(owner, 0)
      } catch (err) {
        stale = (err as NodeJS.ErrnoException).code === 'ESRCH'
      }
    } catch {
      /* removed meanwhile */
    }
    if (stale) {
      try {
        fs.unlinkSync(lock)
      } catch {
        /* another command removed it first */
      }
      mine = claim()
    }
  }
  if (mine) {
    const log = fs.openSync(proj.logFile, 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
      cwd: proj.dir,
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    })
    child.unref()
  }
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200))
    const base = await running(proj)
    if (base) return base
  }
  throw new Error(`server did not start; see ${proj.logFile}`)
}

/** This project's running server, or an error saying how to start one. */
async function needServer(): Promise<string> {
  const proj = needProject()
  const base = await running(proj)
  if (base) return base
  if (isShared(proj)) {
    const port = recordedSharedPort(machineServerFile())
    throw new Error(
      port
        ? `the shared server recorded on port ${port} did not answer, or does not serve ${proj.dir}`
        : "the shared server is not running. It is started outside the agents' sandboxes: as a login service, or with `whiteboard serve` in a terminal, outside any project",
    )
  }
  throw new Error('no server runs for this project; `whiteboard show <page>` starts it')
}

/** Is there a page (a markdown file) in this folder or below it? */
function hasPages(dir: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some(e =>
    e.isDirectory() ? !e.name.startsWith('.') && hasPages(path.join(dir, e.name)) : e.name.endsWith('.md'),
  )
}

/**
 * Ask the project's server. Without one running, a server made for this one question answers it,
 * in this process, on no port: a command that only asks (status, docs, the hooks on every prompt)
 * never starts one. It has no listeners, as no server runs to hold them.
 */
async function api(route: string): Promise<any> {
  const base = await running(needProject())
  const res = base ? await fetch(`${base}${route}`) : await askInProcess(route)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

async function askInProcess(route: string): Promise<Response> {
  // a project without pages has nothing open: no need to load its config to say so (the hooks ask
  // on every prompt, in every project, most of which have no pages)
  if (route.startsWith('/api/status') && !hasPages(needProject().pagesDir)) return Response.json([])
  const { createServer } = await import('../src/server.ts')
  const server = createServer(needProject())
  const listener = http.createServer((req, res) => void server.handle(req, res))
  await new Promise<void>(r => listener.listen(0, '127.0.0.1', r))
  try {
    const { port } = listener.address() as import('node:net').AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}${route}`)
    // read now, while the server is there
    const text = await res.text()
    return new Response(text, { status: res.status, headers: res.headers })
  } finally {
    server.close()
    listener.closeAllConnections()
    listener.close()
  }
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
  if (named || home)
    fs.writeFileSync(
      path.join(wb, 'config.ts'),
      `import { defineConfig } from '@bigmistqke/whiteboard'

export default defineConfig({
${named ? `  name: '${name}',\n` : ''}${home ? '  // only .whiteboard/ is served: this folder is not a repository\n  files: false,\n' : ''}})
`,
    )
  fs.writeFileSync(
    path.join(wb, '.gitignore'),
    `# pages are working documents; remove this line to keep them in git
pages/
# events from the pages (and which ones an agent picked up), and the running server's port and output
events.ndjson
server.json
server.log
server.lock
# the secret for anything that runs code (a plugin like the terminal)
token
`,
  )
  console.log(`project: ${wb}
  pages:     ${path.join(wb, 'pages')} (gitignored); \`whiteboard show <page>\` starts the server
  config:    ${configFileIn(wb) ?? `none: the defaults (markdown with the built-in plugins); add ${path.join(wb, 'config.ts')} to change them`}`)
}

// ---- status ------------------------------------------------------------------------------------

const relFile = (file: string) => path.relative(process.cwd(), file) || file

/**
 * The project's config, as the command line needs it: for its plugins (their commands, the
 * session, which events reach an agent), so without the pages. Loaded once per command.
 */
const loaded = new Map<string, ReturnType<ReturnType<typeof createConfigLoader>['config']>>()
const projectConfig = (proj: Project) => {
  if (!loaded.has(proj.dir)) loaded.set(proj.dir, createConfigLoader(proj, { pages: false }).config())
  return loaded.get(proj.dir)!
}

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
  } catch (err) {
    console.error(`whiteboard: which session runs this: ${(err as Error).message}`)
  }
  return null
}

async function status() {
  const proj = needProject()
  const [pages, session]: [PageStatus[], string | null] = await Promise.all([
    api(`/api/status${opts.page ? `?page=${encodeURIComponent(pageId(proj, opts.page))}` : ''}`),
    currentSession(proj),
  ])
  const busy = pages.filter(p => p.unpicked.length || p.open.length)
  if (pages.some(p => p.listeners.some(l => l.fallback)))
    console.log('a fallback listens: it takes what no other wait or watch would\n')
  if (!busy.length) {
    console.log('nothing open: every question is answered, and every answer picked up')
    return
  }
  for (const p of busy) {
    console.log(`${p.page} (${whose(p, session)})`)
    for (const l of statusLines(p, relFile(p.file))) console.log(`  ${l}`)
  }
}

switch (cmd) {
  case 'serve': {
    // outside any project, with a machine config: the shared server (to start at login, say)
    if (!project && readMachineConfig()) {
      const { startShared } = await import('../src/serve.ts')
      await startShared()
      break
    }
    const proj = needProject()
    if (isShared(proj)) {
      // the shared server, for every entry's projects; it takes over from an older one itself
      const { startShared } = await import('../src/serve.ts')
      await startShared()
      break
    }
    const base = await running(proj)
    if (base) {
      console.error(`whiteboard: ${proj.name} is already served at ${base}`)
      process.exit(1)
    }
    // the server only for the commands that run one: every other command (the hooks' among them,
    // on every prompt) starts without it, a good part of its start-up time
    const { start } = await import('../src/serve.ts')
    await start(proj)
    break
  }
  case 'build': {
    // pages rendered once, as a static site: the config's `build`, with what is given here over it
    const proj = needProject()
    const { createServer } = await import('../src/server.ts') // as for serve: only when needed
    const server = createServer(proj)
    try {
      const result = await server.build({
        pages: positionals.length ? positionals : undefined,
        out: opts.out,
        skip:
          opts.skip != null
            ? opts.skip
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            : undefined,
      })
      for (const w of result.warnings) console.error(`whiteboard build: ${w}`)
      console.log(
        `built ${result.pages.length} page${result.pages.length === 1 ? '' : 's'} into ${path.relative(process.cwd(), result.out) || '.'}`,
      )
    } finally {
      server.close()
    }
    process.exit(0)
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
    const name = (positionals[0] ?? '')
      .replace(/\\/g, '/')
      .replace(/\.md$/, '')
      .replace(/^\/+|\/+$/g, '')
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
    const base = cmd === 'show' ? await ensureServer() : await needServer()
    console.log(`${base}/${pageId(project, positionals[0] ?? '')}`)
    break
  }
  case 'close': {
    // a page that has done its job: its file goes, and its events leave the log (answers, chats,
    // comments, what was read and picked up), so neither the page nor its history lingers
    const target = positionals[0]
    if (!target) throw new Error('usage: whiteboard close <page|file>')
    const proj = needProject()
    const id = pageId(proj, target)
    if (id.startsWith('-/'))
      throw new Error(
        `${target} is a file of the repository, not a page: close is for the pages in ${relFile(proj.pagesDir)}`,
      )
    const file = path.join(proj.pagesDir, `${id}.md`)
    const exists = fs.existsSync(file)
    // an agent still waiting on it would wait on nothing
    const base = await running(proj)
    if (base) {
      try {
        const listening = (
          (await (await fetch(`${base}/api/listeners?page=${encodeURIComponent(id)}`)).json()) as Listener[]
        ).filter(l => !l.fallback && l.page === id)
        if (listening.length)
          console.error(
            `whiteboard: ${listening.length} wait or watch still listens on ${id}; stop it, it will hear nothing more`,
          )
      } catch {
        /* the server is going: nothing to say */
      }
    }
    if (exists) fs.rmSync(file)
    const removed = prune(proj.eventsFile, id)
    if (!exists && !removed) {
      console.error(`whiteboard: there is no page ${id}, nor events of it`)
      process.exit(1)
    }
    console.log(
      `closed ${id}: ${exists ? 'removed its file' : 'it had no file'}, and ${removed} event${removed === 1 ? '' : 's'} from the log`,
    )
    break
  }
  case 'prune': {
    // a page's events, gone from the log, the page kept: all of them (it starts over), or one type,
    // or one event
    const target = positionals[0]
    if (!target) throw new Error('usage: whiteboard prune <page|file> [--type <type>] [--id <event id>]')
    const proj = needProject()
    const id = pageId(proj, target)
    const removed = prune(
      proj.eventsFile,
      id,
      e => (!opts.type || e.type === opts.type) && (!opts.id || e.id === opts.id),
    )
    const which = [opts.type && `of type ${opts.type}`, opts.id && `with id ${opts.id}`].filter(Boolean).join(', ')
    console.log(
      `pruned ${removed} event${removed === 1 ? '' : 's'} of ${id}${which ? ` (${which})` : ''} from the log; the page stays`,
    )
    break
  }
  case 'edit': {
    // an agent's own event, changed in place: --data is merged into its data
    const eventId = positionals[0]
    if (!eventId || !opts.data)
      throw new Error("usage: whiteboard edit <event id> --data <json>   (merged into the event's data)")
    const proj = needProject()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(opts.data)
    } catch {
      throw new Error('--data must be a JSON object')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('--data must be a JSON object')
    console.log(JSON.stringify(editEvent(proj.eventsFile, eventId, data)))
    break
  }
  case 'scroll': {
    // show the reader a place on a page they have open: every tab with it scrolls there
    const [target, ...where] = positionals
    const to = where.join(' ').trim()
    if (!target || !to) throw new Error('usage: whiteboard scroll <page|file> <heading, form name or text>')
    const proj = needProject()
    const id = pageId(proj, target)
    const base = await needServer()
    // what the page shows, to say now when nothing on it matches
    const rendered = (await (
      await fetch(`${base}/api/render?page=${encodeURIComponent(id)}`)
    )
      .json()
      .catch(() => null)) as { html?: string; data?: unknown } | null
    const text = (rendered?.html ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
    const named = new RegExp(`<form[^>]*\\bname="${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(
      rendered?.html ?? '',
    )
    if (rendered && !named && !text.includes(to.replace(/\s+/g, ' ').toLowerCase())) {
      console.error(
        `whiteboard: nothing on ${id} matches ${JSON.stringify(to)} (a heading's text, a form's name, or text on the page)`,
      )
      process.exit(1)
    }
    const res = await fetch(`${base}/api/scroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: id, to }),
    })
    const { tabs } = (await res.json()) as { tabs: number }
    if (!tabs) {
      // a tab may be open but not connected: a background tab connects again when it is shown, and
      // then scrolls there (the scroll is in the log)
      console.error(
        `whiteboard: no tab of ${id} is connected now; one that is open scrolls there once it is back (a background tab connects again when it is shown). \`whiteboard show ${target}\` prints its URL`,
      )
      process.exit(1)
    }
    console.log(`scrolled ${tabs} tab${tabs > 1 ? 's' : ''} of ${id} to ${JSON.stringify(to)}`)
    break
  }
  case 'docs': {
    // how pages are written and which plugin brings which block, then each plugin's docs (the
    // syntax of its blocks, its events, its commands); `whiteboard docs <plugin>` prints only that one
    const info = await api('/api/docs')
    for (const e of info.errors) console.error(`config error: ${e}`)
    const only = positionals[0]
    const names = (info.plugins ?? []).map((x: { name: string }) => x.name)
    if (only && !names.includes(only)) throw new Error(`no plugin named "${only}" here: ${names.join(', ')}`)
    const shown = (x: { name: string }) => !only || x.name === only
    if (!only)
      console.log(
        info.pages ? `${info.pages.trim()}\n` : 'The config failed to load, so pages show as their raw text.\n',
      )
    for (const e of (info.plugins ?? []).filter(shown)) {
      console.log(`<!-- plugin: ${e.name} -->\n# Plugin: ${e.name}\n`)
      if (e.error) console.log(`It failed to load: ${e.error}\n`)
      if (e.docs) console.log(`${e.docs.trim()}\n`)
      if (e.events?.length) {
        console.log(
          'Events it writes (handed out: a `wait` or `watch` on the page gets them, and `status` counts them; the others only when asked for by type):\n',
        )
        for (const v of e.events)
          console.log(`- \`${v.type}\`${v.handOut ? ' (handed out)' : ''}${v.description ? `: ${v.description}` : ''}`)
        console.log()
      }
      for (const c of e.commands)
        console.log(`- \`whiteboard ${[c.name, c.usage].filter(Boolean).join(' ')}\`: ${c.description}`)
      if (e.routes.length)
        console.log(`\nRoutes (\`auth\`: needs the project's token, header \`x-whiteboard-token\`):\n`)
      for (const r of e.routes) {
        const takes = [
          r.body && `body ${JSON.stringify(r.body)}`,
          r.query && `query ${JSON.stringify(r.query)}`,
          r.stream && 'server-sent events',
        ]
          .filter(Boolean)
          .join(', ')
        console.log(
          `- \`${r.method} ${r.path}\`${r.auth ? ' (auth)' : ''}: ${r.description}${takes ? ` (${takes})` : ''}`,
        )
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
    if (opts.follow)
      follow(log, end, e => {
        if (matches(e, f)) console.log(JSON.stringify(e))
      })
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
    if (pickedUp(events).has(id)) {
      console.error(`whiteboard: ${id} was picked up already`)
      break
    }
    console.log(JSON.stringify(pick(proj.eventsFile, event)))
    break
  }
  case 'wait':
  case 'watch': {
    // Each answer once, also one given before the command started, never the agent's own; of the
    // plugins' events, those they declare for an agent (see handOut). `wait` stops after --count
    // events (default 1); `watch` never does.
    const proj = needProject()
    const f = filter()
    // without --page in a project of the machine's entries: the fallback of the whole entry
    const entry = !f.page && isShared(proj) ? matchesEntries(readMachineConfig()!, proj.dir) : null
    if (entry) {
      await entryFallback(entry, f, cmd)
      break
    }
    const { handedOut } = await projectConfig(proj)
    const query = {
      command: cmd,
      ...(f.page ? { page: f.page } : {}),
      ...(f.type ? { type: f.type } : {}),
    }
    const refused = (reason: string) => {
      console.error(
        `whiteboard: ${reason}: another agent already takes what no other listener does (a wait or watch without --page; one per project). Add --page to wait on a page of your own.`,
      )
      process.exit(1)
    }
    const at = () => needServer().catch(() => null)
    const options = { count: cmd === 'wait' ? Number(opts.count ?? 1) : Infinity, forAgent: forAgent(handedOut) }
    if (opts.timeout && cmd === 'wait')
      setTimeout(
        () => {
          console.error('timeout')
          process.exit(2)
        },
        Number(opts.timeout) * 1000,
      )
    // without --page, the fallback: only what no other listener would take, on any page, as it comes
    // and once they stop listening (an answer left in the log, too)
    const fallback = !f.page
    if (fallback) {
      const update = fallbackLoop((_, handing) => {
        void handOut(proj.eventsFile, f, e => console.log(JSON.stringify(e)), { ...options, ...handing }).then(() =>
          process.exit(0),
        )
      })
      await listen({ at, query: { ...query, fallback: '' }, onSnapshot: update, onRefused: refused })
    } else {
      // registered before it reads the log, so a fallback leaves its answers to it from the first one
      await listen({ at, query, onRefused: refused }, { orNone: true })
      void handOut(proj.eventsFile, f, e => console.log(JSON.stringify(e)), options).then(async () => {
        // a wait on a page ends with an answer, and the agent acts on it; what is still unanswered
        // there needs the next wait, which is easily forgotten: say so, right with the answer
        if (cmd === 'wait') {
          try {
            const pages = (await api(`/api/status?page=${encodeURIComponent(f.page!)}`)) as PageStatus[]
            for (const p of pages)
              if (p.open.length)
                console.error(
                  `whiteboard: still unanswered on ${p.page}: ${p.open.join(', ')} → run \`whiteboard wait --page ${relFile(p.file)}\` again, in the background, once you've acted on this`,
                )
          } catch {
            /* no status: the answer is what matters */
          }
        }
        process.exit(0)
      })
    }
    break
  }
  case 'append': {
    // the agent's side of the log: anything a page's plugins understand, such as a reply to a
    // comment. Waits skip what is appended here, so an agent does not hear its own events.
    const proj = needProject()
    if (!opts.page || !opts.type)
      throw new Error("usage: whiteboard append --page <page|file> --type <type> [--data '<json>']")
    let data = {}
    if (opts.data) {
      try {
        data = JSON.parse(opts.data)
      } catch {
        throw new Error('--data must be JSON, e.g. \'{"text":"…"}\'')
      }
    }
    console.log(
      JSON.stringify(appendEvent(proj.eventsFile, { page: pageId(proj, opts.page), type: opts.type, data }, 'cli')),
    )
    break
  }
  case 'status':
    await status()
    break
  case 'paths': {
    // what the shared server needs of the disk, from the machine config: for whatever boxes it in
    // (a sandbox wrapper: `safehouse --add-dirs="$(whiteboard paths --write)" …`)
    const config = readMachineConfig()
    if (!config) throw new Error(`no machine config: ${machineDir()}/config.json`)
    const paths = serverPaths(config, { packageDir: PACKAGE_DIR })
    // a sandbox grants only folders that exist: the state folder is whiteboard's own, so it is made
    // here; an entry's folder not there yet is left out (a restart grants it once it is)
    try {
      fs.mkdirSync(stateDir(), { recursive: true })
    } catch {
      /* made by whoever may: the wrapper runs outside the agents' sandboxes */
    }
    const write = paths.write.filter(d => fs.existsSync(d))
    const read = paths.read.filter(d => fs.existsSync(d))
    if (opts.write) console.log(write.join(':'))
    else if (opts.read) console.log(read.join(':'))
    else console.log(`write: ${write.join(':')}\nread:  ${read.join(':')}`)
    break
  }
  case 'skill': {
    // the agent skill ships in this package; link it into whatever folder an agent reads skills from
    const source = packagePath('skills', 'whiteboard')
    if (!positionals[0]) {
      console.log(source)
      break
    }
    const target = path.join(path.resolve(positionals[0].replace(/^~(?=$|\/)/, os.homedir())), 'whiteboard')
    let existing = null
    try {
      existing = fs.lstatSync(target)
    } catch {}
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
        eventsFile: project.eventsFile,
        dataDir: pluginDir(project.wb, found.plugin),
        token: projectToken(project.wb),
        server: ensureServer,
        pagePath: page => `/${pageId(project, page ?? '')}`,
        status: async page => api(`/api/status${page ? `?page=${encodeURIComponent(pageId(project, page))}` : ''}`),
        handOut: async (filter, onEvent, options) =>
          handOut(project.eventsFile, { ...filter, page: filter.page ? pageId(project, filter.page) : null }, onEvent, {
            ...options,
            forAgent: forAgent((await projectConfig(project)).handedOut),
          }),
        authLink: async to =>
          `${await ensureServer()}/_/auth?token=${encodeURIComponent(projectToken(project.wb))}&to=${encodeURIComponent(to)}`,
      })
      break
    }
    // asked for, the help goes to standard output; after a command it doesn't know, to standard error
    const asked = !cmd || cmd === 'help' || opts.help
    const print = asked ? console.log : console.error
    print(HELP)
    if (commands.length) {
      print(`\nfrom this project's plugins:\n`)
      for (const c of commands)
        print(`  whiteboard ${[c.name, usage(c.command)].filter(Boolean).join(' ')}\n      ${c.command.description}`)
    }
    if (mine.length) console.error(`\nwhiteboard: ${cmd} has no command ${JSON.stringify(rest[0] ?? '')}`)
    if (!asked) process.exit(1)
  }
}

/**
 * The fallback of a whole entry: what no other wait or watch in any of its projects would take, on
 * any page, also once they stop, from each project's own log, each event with the project it is
 * from (`project`, its folder) and its page's `url`. One per entry: the shared server holds it, and
 * refuses a second (exit 1). Without a shared server running it waits for one, as any wait does: who
 * else listens is the server's to say. Projects that appear meanwhile are followed too.
 */
async function entryFallback(entry: string, f: EventFilter, command: 'wait' | 'watch') {
  const file = machineServerFile()
  const count = command === 'wait' ? Number(opts.count ?? 1) : Infinity
  const done = new AbortController()
  let total = 0
  // after the last event is recorded as picked up, which follows handing it out
  done.signal.addEventListener('abort', () => setImmediate(() => process.exit(0)))
  if (opts.timeout && command === 'wait')
    setTimeout(
      () => {
        console.error('timeout')
        process.exit(2)
      },
      Number(opts.timeout) * 1000,
    )
  let origin = ''
  const page = (id: string) => id.split('/').map(encodeURIComponent).join('/')
  // a hand-out per project of the entry, as the shared server names them, each event with its
  // project and its page's address
  const update = fallbackLoop((p, handing) => {
    const proj = projectAt(p.dir)
    if (!proj) return
    void projectConfig(proj).then(({ handedOut }) =>
      handOut(
        proj.eventsFile,
        { type: f.type },
        e => {
          console.log(JSON.stringify({ ...e, project: p.dir, url: `${origin}${p.base}/${page(e.page)}` }))
          if (++total >= count) done.abort()
        },
        { forAgent: forAgent(handedOut), ...handing, signal: AbortSignal.any([handing.signal, done.signal]) },
      ),
    )
  })
  // held at the shared server for as long as this runs (again after a restart); without one running
  // it waits for one, as any wait does: who else listens is the server's to say
  await listen({
    at: async () => {
      origin = (await sharedServer(file))?.origin ?? ''
      return origin || null
    },
    query: { entry, command, ...(f.type ? { type: f.type } : {}) },
    onSnapshot: update,
    onRefused: reason => {
      console.error(`whiteboard: ${reason}. Add --page to wait on a page of your own.`)
      process.exit(1)
    },
  })
  // keeps the command running: the connection does not
  setInterval(() => {}, 1 << 30)
}

/** The commands the project's plugins add: `whiteboard <plugin> [sub]`. */
async function projectCommands(proj: Project) {
  const { plugins, errors } = await projectConfig(proj)
  for (const e of errors) console.error(`whiteboard: config error: ${(e as Error).message}`)
  return plugins.flatMap(pluginCommands)
}
