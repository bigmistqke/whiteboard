// A throwaway whiteboard project for a browser test: a temporary folder with a config and pages,
// its server started from source on a free port, and the command line to run in it.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

const CLI = fileURLToPath(new URL('../../bin/whiteboard.ts', import.meta.url))

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

export interface Project {
  dir: string
  /** the URL the server serves a page at */
  url(page: string): string
  /** run a command of the command line in the project; its standard output */
  cli(...args: string[]): string
  /** the same, with more in its environment (as a program in a terminal tab has) */
  cliWith(extra: Record<string, string>, ...args: string[]): string
  /** run a command with something on its standard input and more in its environment: what it printed, and how it exited */
  run(
    args: string[],
    options?: { input?: string; env?: Record<string, string> },
  ): { stdout: string; stderr: string; status: number }
  /** start a long-running command (a wait), and collect what it prints */
  spawn(...args: string[]): ChildProcess & { output(): string }
  /** the project's events, as the log has them */
  events(): Record<string, any>[]
  /** an agent acted on the reader's answers of `type`: once one is in the log, ack them all */
  handle(type: string): Promise<void>
  /** write a page */
  page(name: string, source: string): string
  /** stop its server and anything it started, and remove the folder */
  close(): Promise<void>
}

/**
 * A project with `config` as its config (none: the defaults) and `pages` by name, its server
 * running. `files` are other files in its folder, by path.
 */
export async function project({
  config,
  pages = {},
  files = {},
}: { config?: string; pages?: Record<string, string>; files?: Record<string, string> } = {}): Promise<Project> {
  // short: the terminal's socket lives in it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'))
  const port = await freePort()
  const env: NodeJS.ProcessEnv = { ...process.env, WHITEBOARD_PORT: String(port) }
  delete env.CLAUDE_CODE_SESSION_ID
  const children: ChildProcess[] = []
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8' })
  cli('init')
  if (config) fs.writeFileSync(path.join(dir, '.whiteboard', 'config.ts'), config)
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text, { mode: 0o755 })
  }
  const page = (name: string, source: string) => {
    const file = path.join(dir, '.whiteboard', 'pages', `${name}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
    return file
  }
  for (const [name, source] of Object.entries(pages)) page(name, source)
  const events = (): Record<string, any>[] => {
    const file = path.join(dir, '.whiteboard', 'events.ndjson')
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l))
      : []
  }
  cli('show', Object.keys(pages)[0] ?? '/')
  return {
    dir,
    url: name => `http://localhost:${port}/${name}`,
    cli,
    cliWith: (extra, ...args) =>
      execFileSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' }),
    run(args, { input = '', env: extra = {} } = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        env: { ...env, ...extra },
        encoding: 'utf8',
        input,
      })
      return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 }
    },
    spawn(...args) {
      const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env })
      let out = ''
      child.stdout!.on('data', d => {
        out += d
      })
      children.push(child)
      return Object.assign(child, { output: () => out })
    },
    events,
    page,
    async handle(type) {
      const ids = await until(`an answer of ${type}`, () => {
        const found = events()
          .filter(e => e.type === type && e.from !== 'cli')
          .map(e => e.id as string)
        return found.length ? found : null
      })
      cli('ack', ...ids)
    },
    async close() {
      for (const c of children) c.kill()
      // the terminal's host, if a test started one
      if (fs.existsSync(path.join(dir, '.whiteboard', 'terminal')))
        try {
          cli('terminal', 'stop')
        } catch {
          /* gone already */
        }
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(dir, '.whiteboard', 'server.json'), 'utf8'))
        process.kill(pid)
      } catch {
        /* gone already */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A browser page that records console errors. */
export async function browser(): Promise<{ browser: Browser; page: Page; errors: string[]; newPage(): Promise<Page> }> {
  const b = await chromium.launch()
  // one context for all pages: they share cookies (the project's token), like windows of one browser
  const context = await b.newContext()
  const errors: string[] = []
  const newPage = async () => {
    const page = await context.newPage()
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', e => errors.push(String(e)))
    return page
  }
  return { browser: b, page: await newPage(), errors, newPage }
}

/** Wait until `check` returns something truthy (polled), and return it; throw after `timeout` ms. */
export async function until<T>(what: string, check: () => T | Promise<T>, timeout = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}
