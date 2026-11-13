// Locations, the project registry, and page ids.
//
// A project is a folder (usually a repo root) with `.visualize/config.{ts,js,mjs}`. Its pages live
// in `.visualize/pages/` and are served at `/<name>/…`. The registry `<root>/projects.json` maps
// names to folders so the one server can find every project; the CLI keeps it up to date.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const ROOT = path.resolve(process.env.VISUALIZE_DIR || path.join(os.homedir(), '.visualize'))
export const PORT = Number(process.env.VISUALIZE_PORT || 4777)
export const EVENTS_FILE = path.join(ROOT, 'events.ndjson')
export const REGISTRY_FILE = path.join(ROOT, 'projects.json')
export const BASE_URL = `http://localhost:${PORT}`
export const CONFIG_NAMES = ['config.ts', 'config.mts', 'config.js', 'config.mjs']

fs.mkdirSync(ROOT, { recursive: true })

/** The config file in a `.visualize` folder, or null. */
export function configFileIn(visualizeDir) {
  for (const name of CONFIG_NAMES) {
    const f = path.join(visualizeDir, name)
    if (fs.existsSync(f)) return f
  }
  return null
}

/** The global config (`<root>/config.ts`), optional. */
export const globalConfigFile = () => configFileIn(ROOT)

// ---- registry ----------------------------------------------------------------------------------

/** @returns {Record<string, string>} project name → project folder */
export function readRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) } catch { return {} }
}

export function register(name, dir) {
  const reg = readRegistry()
  if (reg[name] === dir) return
  if (reg[name] && reg[name] !== dir && fs.existsSync(reg[name]))
    console.error(`visualize: project name "${name}" moves from ${reg[name]} to ${dir}`)
  reg[name] = dir
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n')
}

/** Registered projects whose folder still has a config. */
export function projects() {
  return Object.entries(readRegistry())
    .filter(([, dir]) => configFileIn(path.join(dir, '.visualize')))
    .map(([name, dir]) => ({ name, dir, pagesDir: path.join(dir, '.visualize', 'pages'), configFile: configFileIn(path.join(dir, '.visualize')) }))
}

export const projectByName = name => projects().find(p => p.name === name) ?? null

/** The project a path is in: the nearest folder upward with `.visualize/config.*`. */
export function findProjectDir(from = process.cwd()) {
  let dir = path.resolve(from)
  for (;;) {
    if (configFileIn(path.join(dir, '.visualize'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** A project's name: `name` in its config if it is a plain literal, else the folder name. */
export function projectName(dir) {
  const file = configFileIn(path.join(dir, '.visualize'))
  const m = file && /\bname\s*:\s*['"]([\w.-]+)['"]/.exec(fs.readFileSync(file, 'utf8'))
  return m ? m[1] : path.basename(dir)
}

// ---- page ids ----------------------------------------------------------------------------------

const strip = p => p.replace(/\\/g, '/').replace(/\.md$/, '').replace(/^\/+|\/+$/g, '')

/**
 * A file path or page name → the page id used in URLs and events.
 * - a file inside a project's pages folder → "<project>/<path>"
 * - any other file inside a project's folder → "<project>/-/<path>" (rendered from the repository)
 * - a file inside the root → "<path>"
 * - a bare name while inside a project → "<project>/<name>"; a leading "/" opts out
 */
export function pageId(input, cwd = process.cwd()) {
  if (!input) return ''
  const s = String(input)
  const looksLikeFile = path.isAbsolute(s) || s.startsWith('.') || s.endsWith('.md')
  if (looksLikeFile) {
    const abs = path.resolve(cwd, s)
    for (const p of projects()) {
      if (abs.startsWith(p.pagesDir + path.sep)) return `${p.name}/${strip(path.relative(p.pagesDir, abs))}`
    }
    const projectDir = findProjectDir(path.dirname(abs))
    const pages = projectDir && path.join(projectDir, '.visualize', 'pages')
    if (pages && abs.startsWith(pages + path.sep)) return `${projectName(projectDir)}/${strip(path.relative(pages, abs))}`
    // any other file in a project's folder is a repository file: /<project>/-/<path>, extension kept
    if (projectDir) return `${projectName(projectDir)}/-/${path.relative(projectDir, abs).replace(/\\/g, '/')}`
    if (abs.startsWith(ROOT + path.sep)) return strip(path.relative(ROOT, abs))
    return strip(s)
  }
  if (s.startsWith('/')) return strip(s)
  const projectDir = findProjectDir(cwd)
  if (projectDir) {
    const name = projectName(projectDir)
    return s === name || s.startsWith(name + '/') ? strip(s) : `${name}/${strip(s)}`
  }
  return strip(s)
}
