// The project, its files, and page ids.
//
// A project is a folder (usually a repository root) with `.whiteboard/config.{ts,js,mjs}`.
// Everything whiteboard keeps lives in that `.whiteboard/` folder:
//   config.ts      templates and options
//   pages/         the pages, served at /<page>
//   events.ndjson  form submits
//   server.json    the port and process of this project's running server
//   server.log     that server's output
// Each project runs its own server; nothing is shared between projects.
import path from 'node:path'
import fs from 'node:fs'

export const CONFIG_NAMES = ['config.ts', 'config.mts', 'config.js', 'config.mjs']
/** the port a project's server tries first; it takes the next free one when that is taken */
export const DEFAULT_PORT = Number(process.env.WHITEBOARD_PORT || 4777)

/** The config file in a `.whiteboard` folder, or null. */
export function configFileIn(whiteboardDir) {
  for (const name of CONFIG_NAMES) {
    const f = path.join(whiteboardDir, name)
    if (fs.existsSync(f)) return f
  }
  return null
}

/** The project folder a path is in: the nearest folder upward with `.whiteboard/config.*`. */
export function findProjectDir(from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    if (configFileIn(path.join(dir, '.whiteboard'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** Everything about the project in `dir`, or null when `dir` is not one. */
export function project(dir) {
  if (!dir) return null
  const wb = path.join(dir, '.whiteboard')
  const configFile = configFileIn(wb)
  if (!configFile) return null
  return {
    dir,
    configFile,
    wb,
    pagesDir: path.join(wb, 'pages'),
    eventsFile: path.join(wb, 'events.ndjson'),
    serverFile: path.join(wb, 'server.json'),
    logFile: path.join(wb, 'server.log'),
    styleFile: path.join(wb, 'style.css'),
    /** shown in titles and the overview: `name` in the config if it is a plain literal, else the folder name */
    name: (/\bname\s*:\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(configFile, 'utf8')) ?? [])[1] ?? path.basename(dir),
  }
}

// ---- page ids ----------------------------------------------------------------------------------

const strip = p => p.replace(/\\/g, '/').replace(/\.md$/, '').replace(/^\/+|\/+$/g, '')

/**
 * A file path or page name → the page id used in URLs and events.
 * - a file inside the pages folder → "<path>" without .md
 * - any other file inside the project folder → "-/<path>" (shown from the repository)
 * - anything else → the name as given, without .md
 */
export function pageId(proj, input, cwd = process.cwd()) {
  if (!input) return ''
  const s = String(input)
  const looksLikeFile = path.isAbsolute(s) || s.startsWith('.') || /\.\w+$/.test(s)
  if (!looksLikeFile || !proj) return strip(s)
  const abs = path.resolve(cwd, s)
  if (abs.startsWith(proj.pagesDir + path.sep)) return strip(path.relative(proj.pagesDir, abs))
  if (abs === proj.dir || abs.startsWith(proj.dir + path.sep)) return `-/${path.relative(proj.dir, abs).replace(/\\/g, '/')}`.replace(/\/$/, '')
  return strip(s)
}
