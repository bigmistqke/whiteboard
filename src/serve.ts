// Running a project's server as a process of its own (`whiteboard serve`, which `whiteboard show`
// starts in the background): one server per project, on the port it had last time, else the
// default, else the next free one, recorded in .whiteboard/server.json so the command line finds it.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DEFAULT_PORT, type Project } from './config.ts'
import { createServer } from './server.ts'
import { recordedPort, recordedSharedPort, runningServer, sharedServer, type SharedServer } from './running.ts'
import { machineConfigFile, machineDir, machineServerFile, readMachineConfig, stateDir } from './entries.ts'
import { createHub } from './hub.ts'
import { compareVersions, VERSION } from './package.ts'

/** Listen on the previous port, else the default, else the next free one; then record it in server.json. */
export async function start(project: Project): Promise<number> {
  // one server per project: another may have started a moment ago
  const other = await runningServer(project, { except: process.pid })
  if (other) {
    console.log(`whiteboard: ${project.name} is already served at ${other}`)
    process.exit(0)
  }
  fs.mkdirSync(project.pagesDir, { recursive: true })
  const wb = createServer(project)
  await wb.config()
  const server = http.createServer((req, res) => {
    void wb.handle(req, res)
  })
  server.on('upgrade', (req, conn, head) => wb.upgrade(req, conn, head))
  const candidates = [
    ...new Set(
      [recordedPort(project), DEFAULT_PORT, ...Array.from({ length: 50 }, (_, i) => DEFAULT_PORT + 1 + i)].filter(
        (p): p is number => !!p,
      ),
    ),
  ]
  for (const port of candidates) {
    const ok = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        err.code === 'EADDRINUSE' ? resolve(false) : reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
    if (!ok) continue
    fs.writeFileSync(project.serverFile, JSON.stringify({ port, pid: process.pid }, null, 2) + '\n')
    // the command that started this server waits for it; others can now find it
    try {
      fs.unlinkSync(path.join(project.wb, 'server.lock'))
    } catch {}
    const cleanup = () => {
      try {
        if (JSON.parse(fs.readFileSync(project.serverFile, 'utf8')).pid === process.pid)
          fs.unlinkSync(project.serverFile)
      } catch {}
    }
    process.on('exit', cleanup)
    // one server per project: should another have started at the same moment, whichever one
    // server.json names last stays, and the others leave (their clients reconnect to it)
    const yieldToOther = async () => {
      if (await runningServer(project, { except: process.pid })) {
        console.log('whiteboard: another server of this project took over')
        process.exit(0)
      }
    }
    setTimeout(yieldToOther, 1500).unref()
    setInterval(yieldToOther, 30000).unref()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(0))
    console.log(`whiteboard: ${project.name} (${project.dir}) at http://localhost:${port}`)
    return port
  }
  throw new Error(`no free port from ${DEFAULT_PORT} to ${DEFAULT_PORT + 50}`)
}

// ---- the shared server ---------------------------------------------------------------------------
// One per machine (see entries.ts and hub.ts): on the machine config's port, else the default, else
// the next free one, recorded in the machine folder's server.json with its version. A newer
// whiteboard takes over from an older one: it asks it to exit, then listens in its place. An older
// one, or one as new, leaves a running one be.

/** Run the shared server. Exits (0) when one as new or newer runs already. */
export async function startShared(dir = machineDir(), state = stateDir()): Promise<number> {
  const file = machineServerFile(state)
  const other = await sharedServer(file, { except: process.pid })
  if (other) {
    if (compareVersions(VERSION, other.version) <= 0) {
      console.log(`whiteboard: the shared server ${other.version} runs at ${other.origin}`)
      process.exit(0)
    }
    await takeOver(other)
  }
  const config = readMachineConfig(dir)
  if (!config) throw new Error(`no machine config: ${machineConfigFile(dir)}`)
  fs.mkdirSync(state, { recursive: true })
  const hub = createHub({ dir, state, onShutdown: () => process.exit(0) })
  const server = http.createServer((req, res) => {
    void hub.handle(req, res)
  })
  server.on('upgrade', (req, conn, head) => hub.upgrade(req, conn, head))
  const first = config.port ?? DEFAULT_PORT
  const candidates = [
    ...new Set(
      [
        other ? Number(new URL(other.origin).port) : null,
        recordedSharedPort(file),
        first,
        ...Array.from({ length: 50 }, (_, i) => first + 1 + i),
      ].filter((p): p is number => !!p),
    ),
  ]
  for (const port of candidates) {
    if (!(await listenOn(server, port))) continue
    fs.writeFileSync(file, JSON.stringify({ port, pid: process.pid, version: VERSION }, null, 2) + '\n')
    try {
      fs.unlinkSync(path.join(state, 'server.lock'))
    } catch {}
    process.on('exit', () => {
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file)
      } catch {}
    })
    // should another of the same version have started at the same moment, the one server.json
    // names stays; one newer than this takes over by asking
    const yieldToOther = async () => {
      if (await sharedServer(file, { except: process.pid })) {
        console.log('whiteboard: another shared server took over')
        process.exit(0)
      }
    }
    setTimeout(yieldToOther, 1500).unref()
    setInterval(yieldToOther, 30000).unref()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => process.exit(0))
    console.log(`whiteboard ${VERSION}: the shared server at http://localhost:${port}`)
    for (const p of hub.projects()) console.log(`  http://localhost:${port}${p.base}/  ${p.dir}`)
    return port
  }
  throw new Error(`no free port from ${first} to ${first + 50}`)
}

/** Ask an older shared server to make way, and wait until it has (else end its process). */
async function takeOver(other: SharedServer) {
  console.log(`whiteboard ${VERSION}: taking over from the shared server ${other.version} at ${other.origin}`)
  try {
    await fetch(`${other.origin}/api/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: VERSION }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {}
  const gone = async () => {
    try {
      await fetch(`${other.origin}/api/health`, { signal: AbortSignal.timeout(300) })
      return false
    } catch {
      return true
    }
  }
  for (let i = 0; i < 25; i++) {
    if (await gone()) return
    await new Promise(r => setTimeout(r, 200))
  }
  // one from before /api/shutdown: its process, by the pid it gave
  try {
    process.kill(other.pid, 'SIGTERM')
  } catch {}
  for (let i = 0; i < 25 && !(await gone()); i++) await new Promise(r => setTimeout(r, 200))
}

function listenOn(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening)
      err.code === 'EADDRINUSE' ? resolve(false) : reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}
