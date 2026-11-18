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
