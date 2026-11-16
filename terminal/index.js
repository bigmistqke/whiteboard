// The terminal drawer, as a whiteboard extension: a terminal at the bottom of every page, running
// `claude` in a session that outlives the tab and the page server. In a config:
//
//   import terminal from '@bigmistqke/whiteboard/terminal'
//   export default defineConfig({ renderers: [markboard()], extensions: [terminal()] })
//
// `whiteboard terminal` prints the link that gives a browser the project's token; only a browser
// with it gets the drawer. The host's socket and log are in `.whiteboard/terminal/`.
//
// The parts are whiteboard-free: server.js is a request handler, host.js the process that runs the
// session, client.ts the drawer in the browser. This file wires them in.
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
const drawer = (screen, client) => html`<aside id="wb-terminal" aria-label="Terminal">
<div class="wb-term-grip" title="drag to resize"></div>
<div class="wb-term-bar"><button type="button" class="wb-term-toggle" title="Toggle the terminal (Ctrl+\`)"><span class="wb-term-chevron"></span>terminal</button><span class="wb-term-status"></span><span class="wb-term-actions"></span></div>
<div class="wb-term-screen">${screen && html`<div class="wb-term-placeholder" aria-hidden="true">${raw(screen)}</div>`}</div>
</aside>
<script>try{const t=document.getElementById('wb-terminal'),s=sessionStorage,o=new URLSearchParams(location.search).get('terminal')==='open'||s.getItem('wb-terminal-open')==='1';t.dataset.state=o?'open':'collapsed';const h=+s.getItem('wb-terminal-height');if(h)document.documentElement.style.setProperty('--wb-term-h',h+'px')}catch{}</script>
<script type="module" src="${client}"></script>`

export default function terminal() {
  return {
    name: 'terminal',
    setup(ctx) {
      const term = createTerminal({ dir: ctx.project.dir, home: ctx.dataDir })
      const client = ctx.asset(CLIENT)
      const style = ctx.asset(STYLE)
      return {
        // all of them run code or show what runs, so all need the project's token
        routes: {
          'GET /status': { description: 'whether a session runs, its command and when it started', auth: true, run: () => term.status() },
          'POST /start': {
            description: 'start claude with these arguments; with restart, replace the running session',
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
          return { head: html`<link rel="stylesheet" href="${style}">`, body: drawer(await term.screenHtml(), client) }
        },
      }
    },
    commands: {
      '': {
        description: "print a link that opens the terminal drawer in this browser (it gives the browser the project's token); start claude in it, or continue a session",
        args: '[page]',
        options: {
          resume: { type: 'string?', value: 'id', description: 'continue this Claude Code session' },
          continue: { type: 'boolean?', description: 'continue the latest session in this folder' },
          restart: { type: 'boolean?', description: 'replace the running session' },
        },
        async run(ctx) {
          const { resume, restart } = ctx.options
          const args = resume ? ['--resume', resume] : ctx.options.continue ? ['--continue'] : null
          if (args || restart) {
            const body = await call(ctx, 'POST', '/start', { args: args ?? [], restart: !!restart })
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
