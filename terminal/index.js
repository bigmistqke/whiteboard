// The terminal drawer, as a whiteboard plugin: a terminal at the bottom of every page, running a
// program in a session that outlives the tab and the page server. In a config:
//
//   import terminal from '@bigmistqke/whiteboard/terminal'
//   export default defineConfig({ renderers: [markboard()], plugins: [terminal({ command: 'htop' })] })
//
// `command` is the program a session starts: a name or path, or an array with its first arguments
// (`['npm', 'run', 'dev']`). Without it, the user's shell.
//
// `whiteboard terminal` prints the link that gives a browser the project's token; only a browser
// with it gets the drawer. The host's socket and log are in `.whiteboard/terminal/`.
//
// The parts are whiteboard-free: server.js is a request handler, host.js the process that runs the
// session, client.ts the drawer in the browser. This file wires them in.
import path from 'node:path'
import { html, raw } from '../src/html.js'
import { createTerminal } from './server.js'

const CLIENT = new URL('../dist/terminal/client.js', import.meta.url)
const STYLE = new URL('../dist/terminal/style.css', import.meta.url)

/**
 * The drawer's markup, written by the server so that it is there when the page first renders and
 * the browser can morph it from the previous page (a view transition across the page load). Its
 * open state and height come from this tab's sessionStorage, set before the first render, and the
 * session's screen is in it as HTML, so a page shows it from its first render on; client.js puts the
 * live terminal in its place.
 */
const drawer = (screen, client, label) => html`<aside id="wb-terminal" aria-label="Terminal" data-command="${label}">
<div class="wb-term-grip" title="drag to resize"></div>
<div class="wb-term-bar"><button type="button" class="wb-term-toggle" title="Toggle the terminal (Ctrl+\`)"><span class="wb-term-chevron"></span>terminal</button><span class="wb-term-status"></span><span class="wb-term-actions"></span></div>
<div class="wb-term-screen">${screen && html`<div class="wb-term-placeholder" aria-hidden="true">${raw(screen)}</div>`}</div>
</aside>
<script>try{const t=document.getElementById('wb-terminal'),s=sessionStorage,o=new URLSearchParams(location.search).get('terminal')==='open'||s.getItem('wb-terminal-open')==='1';t.dataset.state=o?'open':'collapsed';const h=+s.getItem('wb-terminal-height');if(h)document.documentElement.style.setProperty('--wb-term-h',h+'px')}catch{}</script>
<script type="module" src="${client}"></script>`

/** @param {{ command?: string | string[] }} [options] */
export default function terminal(options = {}) {
  const command = [options.command ?? process.env.SHELL ?? '/bin/sh'].flat().map(String)
  if (!command[0]) throw new Error('terminal: command is empty')
  // what the drawer calls the session: the program's name
  const label = path.basename(command[0])
  return {
    name: 'terminal',
    setup(ctx) {
      const term = createTerminal({ dir: ctx.project.dir, home: ctx.dataDir, command })
      const client = ctx.asset(CLIENT)
      const style = ctx.asset(STYLE)
      return {
        // all of them run code or show what runs, so all need the project's token
        routes: {
          'GET /status': { description: 'whether a session runs, its command and when it started', auth: true, run: () => term.status() },
          'POST /start': {
            description: `start ${command.join(' ')}, with these arguments after its own; with restart, replace the running session`,
            auth: true,
            body: { args: 'string[]?', restart: 'boolean?' },
            run: ({ body }) => term.start(body),
          },
          'POST /input': { description: 'keystrokes, as the terminal sends them', auth: true, body: { data: 'string' }, run: ({ body }) => term.input(body.data) },
          'POST /resize': { description: 'the size of the terminal in the page', auth: true, body: { cols: 'number', rows: 'number' }, run: ({ body }) => term.resize(body.cols, body.rows) },
          'GET /stream': {
            description: 'the whole screen, then the output as it comes (events screen, data, exit; none without a session)',
            auth: true,
            stream: true,
            run: ({ req, res }) => term.stream(req, res),
          },
          'POST /stop': { description: 'end the session and its host', auth: true, run: () => term.stop() },
        },
        async shell(req) {
          if (!ctx.authorized(req)) return null
          return { head: html`<link rel="stylesheet" href="${style}">`, body: drawer(await term.screenHtml(), client, label) }
        },
      }
    },
    commands: {
      '': {
        description: `print a link that opens the terminal drawer in this browser (it gives the browser the project's token); with --restart or arguments after --, start ${command.join(' ')} in it`,
        args: '[page]',
        options: {
          restart: { type: 'boolean?', description: 'replace the running session' },
        },
        rest: `<arguments for ${label}>`,
        async run(ctx) {
          const { restart } = ctx.options
          if (restart || ctx.rest.length) {
            const body = await call(ctx, 'POST', '/start', { args: ctx.rest, restart: !!restart })
            if (body.already) console.error(`whiteboard: a session runs already (${body.command}); --restart replaces it`)
          }
          console.log(await ctx.authLink(`${ctx.pagePath(ctx.positionals[0])}?terminal=open`))
        },
      },
      stop: {
        description: 'end the session and its host',
        async run(ctx) {
          const { stopped } = await call(ctx, 'POST', '/stop')
          console.log(stopped ? 'stopped' : 'no session ran')
        },
      },
    },
  }
}

/** A request to one of the terminal's routes, from a command. */
async function call(ctx, method, route, body) {
  const res = await fetch(`${await ctx.server()}/api/terminal${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-whiteboard-token': ctx.token },
    body: body ? JSON.stringify(body) : undefined,
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error ?? res.statusText)
  return out
}
