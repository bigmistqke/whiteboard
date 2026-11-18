// Running a project's server as a process of its own (`whiteboard serve`, which `whiteboard show`
// starts in the background): one server per project, on the port it had last time, else the
// default, else the next free one, recorded in .whiteboard/server.json so the command line finds it.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DEFAULT_PORT, type Project } from './config.ts'
import { createServer } from './server.ts'
import { recordedPort, runningServer } from './running.ts'

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
