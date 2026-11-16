// The terminal drawer, as a whiteboard extension: a terminal at the bottom of every page, running
// `claude` in a session that outlives the tab and the page server. In a config:
//
//   import terminal from '@bigmistqke/whiteboard/terminal'
//   export default defineConfig({ renderers: [markboard()], extensions: [terminal()] })
//
// `whiteboard terminal` prints the link that gives a browser the project's token; only a browser
// with it gets the drawer. The parts are whiteboard-free: server.js is a request handler, host.js the
// process that runs the session, client.js the drawer in the browser. This file wires them in.
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
      const term = createTerminal({ dir: ctx.project.dir, wb: ctx.project.wb, authorized: ctx.authorized })
      const client = ctx.asset(CLIENT)
      const style = ctx.asset(STYLE)
      return {
        handle: (req, res, url) => term.handle(req, res, url.pathname),
        async shell(req) {
          if (!ctx.authorized(req)) return null
          return { head: html`<link rel="stylesheet" href="${style}">`, body: drawer(await term.screenHtml(), client) }
        },
        // the host's socket and output
        ownFiles: ['term.sock', 'term.log'],
      }
    },
  }
}
