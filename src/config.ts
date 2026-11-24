// The project, its files, and page ids.
//
// A project is a folder (usually a repository root) with a `.whiteboard/` folder in it.
// Everything whiteboard keeps lives in that folder:
//   config.ts      what the project changes from the defaults (optional)
//   pages/         the pages, served at /<page>
//   events.ndjson  the events: form submits, chat messages, comments, and what agents received and handled
//   token          the secret for what runs code (the terminal), made on first use
//   server.json    the port and process of this project's running server
//   server.log     that server's output
// Each project runs its own server; nothing is shared between projects.
import path from 'node:path'
import fs from 'node:fs'

/** A project: its folders and files. */
export interface Project {
  /** the project folder */
  dir: string
  /** its .whiteboard folder */
  wb: string
  readonly configFile: string | null
  pagesDir: string
  eventsFile: string
  serverFile: string
  logFile: string
  readonly name: string
}

export const CONFIG_NAMES = ['config.ts', 'config.mts', 'config.js', 'config.mjs']
/** the port a project's server tries first; it takes the next free one when that is taken */
export const DEFAULT_PORT = Number(process.env.WHITEBOARD_PORT || 4777)

/** The config file in a `.whiteboard` folder, or null. */
export function configFileIn(whiteboardDir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const f = path.join(whiteboardDir, name)
    if (fs.existsSync(f)) return f
  }
  return null
}

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The project folder a path is in: the nearest folder upward with a `.whiteboard/` folder. */
export function findProjectDir(from: string = process.cwd()): string | null {
  let dir = path.resolve(from)
  for (;;) {
    if (isDir(path.join(dir, '.whiteboard'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** Everything about the project in `dir`, or null when `dir` is not one. */
export function project(dir: string | null | undefined): Project | null {
  if (!dir) return null
  const wb = path.join(dir, '.whiteboard')
  if (!isDir(wb)) return null
  return {
    dir,
    wb,
    /** the config file, or null: looked up each time, since one can be added or removed while a server runs */
    get configFile() {
      return configFileIn(wb)
    },
    pagesDir: path.join(wb, 'pages'),
    eventsFile: path.join(wb, 'events.ndjson'),
    serverFile: path.join(wb, 'server.json'),
    logFile: path.join(wb, 'server.log'),
    /** shown in titles and the overview: `name` in the config if it is a plain literal, else the folder name */
    get name() {
      const file = configFileIn(wb)
      return (
        (file && (/\bname\s*:\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(file, 'utf8')) ?? [])[1]) || path.basename(dir)
      )
    },
  }
}

// ---- page ids ----------------------------------------------------------------------------------

const strip = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/\.md$/, '')
    .replace(/^\/+|\/+$/g, '')

/**
 * A file path or page name → the page id used in URLs and events.
 * - a file inside the pages folder → "<path>" without .md
 * - any other file inside the project folder → "-/<path>" (shown from the repository)
 * - anything else → the name as given, without .md
 */
export function pageId(proj: Project | null, input: unknown, cwd: string = process.cwd()): string {
  if (!input) return ''
  const s = String(input)
  const looksLikeFile = path.isAbsolute(s) || s.startsWith('.') || /\.\w+$/.test(s)
  if (!looksLikeFile || !proj) return strip(s)
  const abs = path.resolve(cwd, s)
  if (abs.startsWith(proj.pagesDir + path.sep)) return strip(path.relative(proj.pagesDir, abs))
  if (abs === proj.dir || abs.startsWith(proj.dir + path.sep))
    return `-/${path.relative(proj.dir, abs).replace(/\\/g, '/')}`.replace(/\/$/, '')
  return strip(s)
}
