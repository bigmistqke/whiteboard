// The terminal drawer, as a whiteboard plugin: a terminal at the bottom of every page, with tabs, each
// a session that outlives the browser tab and the page server. In a config:
//
//   import terminal from '@bigmistqke/whiteboard/terminal'
//   export default defineConfig({ plugins: [terminal({ command: 'claude' })] })
//
// `command` is the program a new tab starts: a name or path, or an array with its first arguments
// (`['npm', 'run', 'dev']`). It runs in the user's shell, which takes over when it exits, so a tab
// ends at a prompt. Without `command`, a tab is just the shell. "+" in the drawer opens a shell
// next to the others.
//
// `whiteboard terminal` prints the link that gives a browser the project's token; only a browser
// with it gets the drawer. The host's socket and log are in `.whiteboard/terminal/`. What the
// terminal can do is what the server can: it runs with the rights of whoever started the server.
//
// The parts are whiteboard-free: server.ts is a request handler, host.ts the process that runs the
// sessions, client.ts the drawer in the browser. This file wires them in.
import { html, raw } from '../../src/html.ts'
import { packagePath } from '../../src/package.ts'
import { createTerminal, type Sessions, type StartOptions } from './server.ts'
import type { CommandContext, Plugin } from '../../src/define.ts'

const CLIENT = packagePath('dist/plugins/terminal/client.js')
const STYLE = packagePath('dist/plugins/terminal/style.css')

/**
 * The drawer's markup, written by the server so that it is there when the page first renders and
 * the browser can morph it from the previous page (a view transition across the page load). Its
 * open state, height and tab come from this browser tab's sessionStorage, set before the first
 * render, and each session's screen is in it as HTML, so a page shows it from its first render on;
 * client.js puts the live terminal in its place.
 */
const drawer = (state: Sessions, screens: Record<string, string>, client: string, label: string) => html`<aside id="wb-terminal" aria-label="Terminal" data-command="${label}" data-sessions="${JSON.stringify(state)}">
<div class="wb-term-grip" title="drag to resize"></div>
<div class="wb-term-bar"><button type="button" class="wb-term-toggle" title="Toggle the terminal (Ctrl+\`)"><span class="wb-term-chevron"></span>terminal</button><span class="wb-term-tabs">${state.sessions.map(s => html`<button type="button" class="wb-term-tab" data-id="${s.id}">${s.label}</button>`)}</span><span class="wb-term-status"></span><span class="wb-term-actions"></span></div>
<div class="wb-term-screen">${state.sessions.map(s => screens[s.id] && html`<div class="wb-term-placeholder" data-id="${s.id}" aria-hidden="true">${raw(screens[s.id])}</div>`)}</div>
</aside>
<script>try{const t=document.getElementById('wb-terminal'),s=sessionStorage,o=new URLSearchParams(location.search).get('terminal')==='open'||s.getItem('wb-terminal-open')==='1';t.dataset.state=o?'open':'collapsed';const h=+s.getItem('wb-terminal-height');if(h)document.documentElement.style.setProperty('--wb-term-h',h+'px');const tabs=[...t.querySelectorAll('.wb-term-tab')],k=s.getItem('wb-terminal-tab'),a=tabs.find(b=>b.dataset.id===k)??tabs[0];if(a){t.dataset.tab=a.dataset.id;a.classList.add('wb-current');t.querySelector('.wb-term-placeholder[data-id="'+a.dataset.id+'"]')?.classList.add('wb-current')}}catch{}</script>
<script type="module" src="${client}"></script>`

export interface TerminalOptions {
  /** the program a new tab starts, with its first arguments; the shell without one */
  command?: string | string[]
}

export default function terminal(options: TerminalOptions = {}): Plugin {
  const command = [options.command ?? process.env.SHELL ?? '/bin/sh'].flat().map(String)
  if (!command[0]) throw new Error('terminal: command is empty')
  return {
    name: 'terminal',
    // the drawer's look: on every page, since every page can have the drawer
    style: STYLE,
    setup(ctx) {
      const term = createTerminal({ dir: ctx.project.dir, home: ctx.dataDir, command })
      const client = ctx.asset(CLIENT)
      return {
        // all of them run code or show what runs, so all need the project's token
        routes: {
          'GET /sessions': { description: 'the sessions (the drawer\'s tabs): id, label, whether each runs', auth: true, run: () => term.sessions() },
          'POST /start': {
            description: `start ${command.join(' ')} (or the shell alone, with shell) in session id, a new tab without one; with restart, replace a running session`,
            auth: true,
            body: { id: 'string?', args: 'string[]?', restart: 'boolean?', shell: 'boolean?' },
            run: ({ body }) => term.start(body as StartOptions),
          },
          'POST /input': { description: 'keystrokes for a session, as the terminal sends them', auth: true, body: { id: 'string', data: 'string' }, run: ({ body }) => term.input(body.id as string, body.data as string) },
          'POST /resize': {
            description: 'the size that fits the terminal in a page (`viewer`: that drawer); `active`: the reader uses this drawer now, so the session takes its size',
            auth: true,
            body: { id: 'string', viewer: 'string', cols: 'number', rows: 'number', active: 'boolean?' },
            run: ({ body }) => term.resize(body.id as string, body.viewer as string, body.cols as number, body.rows as number, !!body.active),
          },
          'GET /stream': {
            description: 'the tabs and a session\'s whole screen, then its output as it comes (events sessions, screen, data, size, navigate, exit; none without that session)',
            auth: true,
            stream: true,
            query: { id: 'string?', viewer: 'string?' },
            run: ({ req, res, query }) => term.stream(req, res!, query.id as string | undefined, query.viewer as string | undefined),
          },
          'POST /close': { description: 'end a session and drop its tab', auth: true, body: { id: 'string' }, run: ({ body }) => term.close(body.id as string) },
          'POST /stop': { description: 'end every session and their host', auth: true, run: () => term.stop() },
          'POST /open': {
            description: 'show the page at path in the browser tab whose drawer the reader used last, for session id or, without one, of all; how many were shown',
            auth: true,
            body: { id: 'string?', path: 'string' },
            run: ({ body }) => term.open(body.id as string | undefined, body.path as string),
          },
        },
        async shell(req) {
          if (!ctx.authorized(req)) return null
          const state = await term.sessions()
          return { body: drawer(state, await term.screens(state.sessions), client, term.label) }
        },
      }
    },
    commands: {
      '': {
        description: `print a link that opens the terminal drawer in this browser (it gives the browser the project's token); with --new or arguments after --, start ${command.join(' ')} in a new tab`,
        args: '[page]',
        options: {
          new: { type: 'boolean?', description: 'start it in a new tab' },
          shell: { type: 'boolean?', description: 'with --new: the shell alone' },
        },
        rest: `<arguments for ${command[0]}>`,
        async run(ctx) {
          if (ctx.options.new || ctx.rest.length) {
            const body = await call(ctx, 'POST', '/start', { args: ctx.rest, shell: !!ctx.options.shell }) as { session: string }
            console.error(`whiteboard: started in tab ${body.session}`)
          }
          console.log(await ctx.authLink(`${ctx.pagePath(ctx.positionals[0])}?terminal=open`))
        },
      },
      open: {
        description: 'show a page in the browser tab whose drawer the reader used last (from a program in a terminal tab: that tab\'s drawer)',
        args: '<page|file>',
        async run(ctx) {
          if (!ctx.positionals[0]) throw new Error('usage: whiteboard terminal open <page|file>')
          // a program in a tab knows its tab; anything else gets the drawer the reader used last
          const id = process.env.WHITEBOARD_TERMINAL || undefined
          const path = ctx.pagePath(ctx.positionals[0])
          const { shown } = await call(ctx, 'POST', '/open', { id, path }) as { shown: number }
          if (!shown) throw new Error(`no browser shows ${id ? `terminal tab ${id}` : 'the terminal drawer'} right now; the page is at ${await ctx.server()}${path}`)
          console.log(`opened ${path} ${id ? `where tab ${id}'s drawer is` : 'where the drawer you used last is'}`)
        },
      },
      stop: {
        description: 'end every session and their host',
        async run(ctx) {
          const { stopped } = await call(ctx, 'POST', '/stop') as { stopped: boolean }
          console.log(stopped ? 'stopped' : 'no session ran')
        },
      },
    },
  }
}

/** A request to one of the terminal's routes, from a command. */
async function call(ctx: CommandContext, method: string, route: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${await ctx.server()}/api/terminal${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-whiteboard-token': ctx.token },
    body: body ? JSON.stringify(body) : undefined,
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error ?? res.statusText)
  return out
}
