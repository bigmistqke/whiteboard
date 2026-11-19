// Finding a project's running server: the port in .whiteboard/server.json, checked by asking the
// server which project it serves (the port may since have been taken by another project's). The
// command line uses it to reach the server, and a starting server to see whether one runs already.
import fs from 'node:fs'
import type { Project } from './config.ts'

/** The port the last server of this project recorded, or null. */
export function recordedPort(project: Project): number | null {
  try {
    return Number(JSON.parse(fs.readFileSync(project.serverFile, 'utf8')).port) || null
  } catch {
    return null
  }
}

/** The base URL of this project's running server, or null. `except`: a process to not count (the asking server itself). */
export async function runningServer(project: Project, { except }: { except?: number } = {}): Promise<string | null> {
  const port = recordedPort(project)
  if (!port) return null
  const base = `http://localhost:${port}`
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(800) })
    const health = res.ok ? await res.json() : null
    return health?.dir === project.dir && health.pid !== except ? base : null
  } catch {
    return null
  }
}

/** The shared server as its health says: where it is, its version, the projects it serves. */
export interface SharedServer {
  origin: string
  pid: number
  version: string
  projects: { entry: string; dir: string; base: string }[]
}

/** The port the shared server recorded in the machine folder, or null. */
export function recordedSharedPort(file: string): number | null {
  try {
    return Number(JSON.parse(fs.readFileSync(file, 'utf8')).port) || null
  } catch {
    return null
  }
}

/**
 * The machine's running shared server, or null: the port in its record, checked by asking it.
 * `rescan`: have it look for projects first (one just made, say). `except`: a process not to count.
 */
export async function sharedServer(
  file: string,
  { rescan = false, except }: { rescan?: boolean; except?: number } = {},
): Promise<SharedServer | null> {
  const port = recordedSharedPort(file)
  if (!port) return null
  const origin = `http://localhost:${port}`
  try {
    const res = await fetch(`${origin}/api/health${rescan ? '?rescan' : ''}`, { signal: AbortSignal.timeout(800) })
    const health = res.ok ? await res.json() : null
    if (!health?.hub || health.pid === except) return null
    return { origin, pid: health.pid, version: String(health.version ?? '0.0.0'), projects: health.projects ?? [] }
  } catch {
    return null
  }
}
