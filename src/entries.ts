// The machine's entries: the projects one shared server serves, found from include and exclude globs
// in the machine config (`config.json` in the machine folder, see machineDir).
//
//   { "port": 4777,
//     "entries": { "rg": {
//       "include": ["~/rg/develop", "~/rg/develop/.claude/worktrees/*", "~/rg/worksite/jobs/*"],
//       "exclude": ["~/rg/worksite/archive/**"] } } }
//
// Every folder an include matches, that no exclude matches and that has a `.whiteboard/` folder, is
// a project of that entry. It is served at /<entry>/<path>/: <path> is the include's last literal
// folder and what its wildcards matched (`develop`, `worktrees/cmux`, `jobs/2026-11-19-x`), with
// `-2`, `-3` on a collision. Discovery is a pure function of the config and the disk, so the server
// runs it again to see projects come and go.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** One entry of the machine config: which folders are its projects. */
export interface EntryConfig {
  include: string[]
  exclude?: string[]
}

/** The machine config: the shared server's port and its entries. */
export interface MachineConfig {
  port?: number
  entries: Record<string, EntryConfig>
}

/** A project found for an entry: its folder, and the path it is served under (`/rg/develop`). */
export interface EntryProject {
  entry: string
  /** the include's last plain folder: what kind of checkout it is (`develop`, `worktrees`, `jobs`) */
  group: string
  /** what its wildcards matched (`cmux`); '' for an include without any */
  name: string
  dir: string
  /** the URL path it is served under, without a trailing slash: /<entry>/<path> */
  base: string
}

/**
 * The machine folder: the machine config, `config.json`. `$WHITEBOARD_HOME`, else
 * `$XDG_CONFIG_HOME/whiteboard`, else `~/.config/whiteboard`. The shared server only reads it: what
 * runs in the server (any project's plugins) must not change which folders it serves, nor how it is
 * started (see Entries in DESIGN.md).
 */
export function machineDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WHITEBOARD_HOME) return path.resolve(env.WHITEBOARD_HOME)
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdg, 'whiteboard')
}

/**
 * The shared server's own folder, which it writes: its record (`server.json`), its log, the lock of
 * a start, and the overview's project. `$WHITEBOARD_STATE`, else `state/` in `$WHITEBOARD_HOME`
 * when that is set (a throwaway machine, in tests), else `$XDG_STATE_HOME/whiteboard`, else
 * `~/.local/state/whiteboard`.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WHITEBOARD_STATE) return path.resolve(env.WHITEBOARD_STATE)
  if (env.WHITEBOARD_HOME) return path.join(path.resolve(env.WHITEBOARD_HOME), 'state')
  const xdg = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')
  return path.join(xdg, 'whiteboard')
}

export const machineConfigFile = (dir = machineDir()) => path.join(dir, 'config.json')
export const machineServerFile = (dir = stateDir()) => path.join(dir, 'server.json')
export const machineLogFile = (dir = stateDir()) => path.join(dir, 'server.log')

const NAME = /^[a-z0-9][a-z0-9._-]*$/i
// a served path's first part is an entry's name: these are the server's own
const RESERVED = new Set(['api', '_', '-'])

/** The machine config, checked; null when there is none. Throws on one that is malformed. */
export function readMachineConfig(dir = machineDir()): MachineConfig | null {
  const file = machineConfigFile(dir)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: must be an object`)
  const entries: Record<string, EntryConfig> = {}
  for (const [name, e] of Object.entries((raw.entries ?? {}) as Record<string, any>)) {
    if (!NAME.test(name) || RESERVED.has(name))
      throw new Error(`${file}: entry name ${JSON.stringify(name)}: letters, digits, . _ - only, and not api, _ or -`)
    const list = (v: unknown, what: string): string[] => {
      if (v == null) return []
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string'))
        throw new Error(`${file}: entries.${name}.${what} must be a list of globs`)
      return v
    }
    entries[name] = { include: list(e?.include, 'include'), exclude: list(e?.exclude, 'exclude') }
  }
  const port = raw.port == null ? undefined : Number(raw.port)
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
    throw new Error(`${file}: port must be a port number`)
  return { ...(port !== undefined && { port }), entries }
}

/** `~` and `~/…` as the home folder; the rest resolved, with / separators. */
export const expandHome = (p: string, home = os.homedir()): string =>
  path
    .resolve(p.replace(/^~(?=$|[\\/])/, home))
    .split(path.sep)
    .join('/')

const isGlobPart = (part: string) => /[*?[\]{}!]/.test(part)

const hasWhiteboard = (dir: string) => {
  try {
    return fs.statSync(path.join(dir, '.whiteboard')).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where a folder an include matched goes in its entry: its group, the include's last plain folder
 * before the first wildcard (`worktrees`), and its name, what the wildcards matched (`cmux`). An
 * include without wildcards is a group of one, named by the folder (`develop`).
 */
function placeOf(include: string, dir: string): { group: string; name: string } {
  const parts = include.split('/')
  const wild = parts.findIndex(isGlobPart)
  if (wild < 0) return { group: path.basename(dir), name: '' }
  const literal = parts.slice(0, wild).join('/')
  return { group: parts[wild - 1] ?? '', name: path.relative(literal, dir).split(path.sep).join('/') }
}

/** Is this folder one an exclude glob leaves out (the folder itself, or one it is inside)? */
const excluded = (dir: string, excludes: string[]) =>
  excludes.some(g => {
    for (let d = dir; ; d = path.posix.dirname(d)) {
      if (path.posix.matchesGlob(d, g)) return true
      if (path.posix.dirname(d) === d) return false
    }
  })

/**
 * Every project of the machine config's entries, in config order: the folders an include matches,
 * no exclude matches, with a `.whiteboard/` folder. A folder two includes match is one project, the
 * first include's. `home`: what `~` means (for tests).
 */
export function discover(config: MachineConfig, { home = os.homedir() }: { home?: string } = {}): EntryProject[] {
  const out: EntryProject[] = []
  const seen = new Set<string>()
  const taken = new Set<string>()
  for (const [entry, { include, exclude = [] }] of Object.entries(config.entries)) {
    const excludes = exclude.map(g => expandHome(g, home))
    for (const glob of include.map(g => expandHome(g, home))) {
      const dirs = glob.split('/').some(isGlobPart)
        ? fs
            .globSync(glob)
            .map(d => path.resolve(d))
            .toSorted()
        : [glob]
      for (const dir of dirs) {
        const posix = dir.split(path.sep).join('/')
        if (seen.has(dir) || excluded(posix, excludes) || !hasWhiteboard(dir)) continue
        seen.add(dir)
        const place = placeOf(glob, posix)
        const wanted = `/${entry}/${[place.group, place.name].filter(Boolean).join('/')}`
        let base = wanted
        let n = 1
        while (taken.has(base)) base = `${wanted}-${++n}`
        taken.add(base)
        // a second one wanting the same path is named apart the same way
        const name = n > 1 ? (place.name ? `${place.name}-${n}` : '') : place.name
        out.push({ entry, group: n > 1 && !place.name ? `${place.group}-${n}` : place.group, name, dir, base })
      }
    }
  }
  return out
}

/** Does any include of the machine config match this folder, no exclude leaving it out? Cheap: no globbing of the disk. */
export function matchesEntries(config: MachineConfig, dir: string, { home = os.homedir() } = {}): string | null {
  const posix = path.resolve(dir).split(path.sep).join('/')
  for (const [entry, { include, exclude = [] }] of Object.entries(config.entries)) {
    const excludes = exclude.map(g => expandHome(g, home))
    if (include.some(g => path.posix.matchesGlob(posix, expandHome(g, home))) && !excluded(posix, excludes))
      return entry
  }
  return null
}

/**
 * Follow the entries' projects: `onChange` gets the projects each time the set changes. Watching
 * globs over the disk in general would mean watching every folder they could match, so it looks
 * again every `interval` ms (cheap: a few folder listings), and at once when told (`rescan`).
 */
export function followEntries(
  read: () => MachineConfig | null,
  onChange: (projects: EntryProject[]) => void,
  { interval = 1500, home }: { interval?: number; home?: string } = {},
) {
  let last = ''
  let current: EntryProject[] = []
  const rescan = () => {
    let projects: EntryProject[] = []
    try {
      const config = read()
      projects = config ? discover(config, { home }) : []
    } catch (err) {
      console.error(`whiteboard: entries: ${(err as Error).message}`)
      return current
    }
    const key = JSON.stringify(projects)
    if (key !== last) {
      last = key
      current = projects
      onChange(projects)
    }
    return current
  }
  rescan()
  const timer = setInterval(rescan, interval)
  timer.unref()
  return { rescan, projects: () => current, stop: () => clearInterval(timer) }
}

/**
 * The folders the entries' projects can be in: each include up to its first wildcard (all of it
 * when it has none), without those inside another. What the shared server must be able to write,
 * whatever folders appear below them later.
 */
export function entryFolders(config: MachineConfig, { home = os.homedir() }: { home?: string } = {}): string[] {
  const roots = Object.values(config.entries).flatMap(e =>
    e.include.map(g => {
      const parts = expandHome(g, home).split('/')
      const wild = parts.findIndex(isGlobPart)
      return wild < 0 ? parts.join('/') : parts.slice(0, wild).join('/') || '/'
    }),
  )
  const unique = [...new Set(roots)].toSorted()
  return unique.filter(r => !unique.some(o => o !== r && (r.startsWith(o + '/') || o === '/')))
}

/**
 * What the shared server needs of the disk, for whatever boxes it in (a sandbox wrapper, see
 * `whiteboard paths`): `write`, the entries' folders and its own state folder; `read`, the machine
 * config and whiteboard itself.
 */
export function serverPaths(
  config: MachineConfig,
  { home, packageDir, env = process.env }: { home?: string; packageDir: string; env?: NodeJS.ProcessEnv },
): { write: string[]; read: string[] } {
  return { write: [...entryFolders(config, { home }), stateDir(env)], read: [machineDir(env), packageDir] }
}
