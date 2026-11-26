// Which conversation a Claude Code process is on now. Claude Code puts the id in the environment
// of what it starts (`CLAUDE_CODE_SESSION_ID`), but an MCP server keeps the environment it was
// started with: on an interactive resume Claude Code starts its servers with a provisional id and
// then switches the conversation to the resumed one, so the channel would follow nobody's pages.
// A hook always gets the current id on its standard input (`session_id`), and it runs under the
// same claude process as the channel. So each hook records the id under that process, and the
// channel reads it back every round.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * The claude process this one runs under, as `<pid>-<start time>` (a pid is reused, its start time
 * tells the two apart): the nearest ancestor named `claude`, or the parent when there is none (a
 * claude run through node, a test). One wrapper in between (`npx whiteboard`) is looked past by name.
 */
export function claudeProcess(): string {
  let pid = process.ppid
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  if (ps.status === 0) {
    const parent = new Map<number, [number, string]>()
    for (const line of ps.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (m) parent.set(Number(m[1]), [Number(m[2]), path.basename(m[3])])
    }
    for (let p = process.ppid; p > 1 && parent.has(p); p = parent.get(p)![0])
      if (parent.get(p)![1] === 'claude') {
        pid = p
        break
      }
  }
  const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  const at = started.status === 0 ? Date.parse(started.stdout.trim()) : NaN
  return Number.isNaN(at) ? String(pid) : `${pid}-${at / 1000}`
}

const sessionsDir = (dataDir: string) => path.join(dataDir, 'sessions')

/** The conversation a hook says this claude process is on; records of processes that ended go. */
export function recordSession(dataDir: string, session: string) {
  const dir = sessionsDir(dataDir)
  const file = path.join(dir, claudeProcess())
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === session) return
  fs.mkdirSync(dir, { recursive: true })
  for (const name of fs.readdirSync(dir)) if (!alive(Number(name.split('-')[0]))) fs.rmSync(path.join(dir, name))
  fs.writeFileSync(`${file}.tmp`, session)
  fs.renameSync(`${file}.tmp`, file)
}

/** The conversation the hooks last recorded for this claude process, or null when none ran yet. */
export function recordedSession(dataDir: string, claude: string): string | null {
  try {
    return fs.readFileSync(path.join(sessionsDir(dataDir), claude), 'utf8') || null
  } catch {
    return null
  }
}

function alive(pid: number) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
