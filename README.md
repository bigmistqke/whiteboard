# whiteboard

A whiteboard for you and your agent.

Some things are too much for text in a terminal: a plan with open questions,
a comparison, the state of a long-running task. With whiteboard the agent
writes them as a markdown page, and you read the page live in your browser
next to the conversation. Every save updates the open page, and what changed
is marked until you've seen it. When the agent needs something from you, it
puts a form on the page. Your answer goes into a log the agent is waiting on.

It stays small: markdown files, one server per project, and one way to
interact (submitting a form). Everything else, from cards and diagrams to a
canvas you could sketch on together, is a template.

## Install

In the repository you work in:

```sh
npm i -D @bigmistqke/whiteboard
npx whiteboard init                # creates .whiteboard/ with a pages folder
```

Then give your agent the skill that tells it how to use the whiteboard
([below](#the-agent-skill)).

Requires Node 22.18 or later (it runs the TypeScript config itself).

<details>
<summary>Without npm in the repository, or for every project at once</summary>

Install the command globally instead and run it as `whiteboard`:

```sh
npm i -g @bigmistqke/whiteboard
whiteboard init
```

A project needs no `node_modules` of its own: the server resolves the
package's imports in `.whiteboard/config.ts` itself, so a Rust or Go
repository can have a whiteboard too.

</details>

## Quick start

Write a page:

````sh
cat > .whiteboard/pages/plan.md <<'EOF'
# Release plan

:::grid{cols=2}
### Parser {done}
Rewritten, all tests pass.

### Docs {todo}
Not started.
:::

:::form{name=ship}
Ship it this week? :radio[this week]{name=when} :radio[next week]{name=when}

:button[Decide]
:::
EOF
npx whiteboard show plan           # starts the server, prints http://localhost:4777/plan
````

Open the URL, then wait for the answer in another terminal:

```sh
npx whiteboard wait --page plan --type ship
# {"id":"…","ts":"…","page":"plan","type":"ship","action":"Decide","data":{"when":"this week"}}
```

That round trip is the whole idea. In practice the agent writes the page and
runs `wait`; you read and answer.

Agents claim their pages with `whiteboard new <name>`, which creates the file
under a name no other page has: `plan`, else `plan-2`, and so on. Several
agents can work in one project without writing into each other's pages or
waking on each other's answers.

## How it works

A project is a folder with a `.whiteboard/` folder in it. Everything
whiteboard keeps is there; nothing is written outside the project.

```
.whiteboard/
  config.ts       optional: what differs from the defaults (renderers, plugins, options)
  pages/          the pages: pages/plan.md is served at /plan
  events.ndjson   the events, one JSON object per line: form submits, comments, replies,
                  and which ones an agent picked up
  token           the secret for what runs code (the terminal)
  server.json     the port and process of the running server
  server.log      that server's output
```

Pages, the event log and the server files are gitignored by default.

- **One server per project.** `whiteboard show` starts the project's server
  when it isn't running. It takes the port it had last time, else 4777 (or
  `$WHITEBOARD_PORT`), else the next free one.
- **Stored as markdown, shown by a renderer.** The core keeps pages as text
  and hands them to a renderer, which decides what they become. `markboard()`,
  which ships with the package, renders markdown with templates; another
  renderer could make slides or a canvas of the same files.
- **Live pages.** Every save of a page updates the open tab in place; with
  markboard, blocks that changed are marked until you've seen them.
- **Repository files render too.** `/-/README.md` shows that file as a page,
  `/-/src/` lists a folder, and other text files show as highlighted code.
  Relative links between documents work the way they do in the repository.
- **Markdown never breaks a page.** An unknown template renders its content
  as plain markdown, and a template that throws shows an error in place of
  that block only. A page no renderer takes shows as its raw text.

## Forms and answers

A form with a `name` and no `action` attribute is recorded when submitted:

```json
{"id":"…","ts":"2026-…","page":"plan","type":"ship","action":"Decide","data":{"when":"this week"}}
```

`type` is the form's name, `action` is the button that was pressed and
`data` holds the fields. The log is an event stream: a template or a plugin
can append events of other types too, through `api.append(type, data)`.
Those types are named after their owner, `<owner>:<what>` (`chat:message`,
`comments:reply`, whiteboard's own `whiteboard:picked`), so a form's name
can't contain a colon and its answers never mix with them. The
`form` template (in `markboard()`) writes them as markdown with inputs inline
(`:::form{name=ship}` … `:radio[this week]{name=when}` … `:::`); a
hand-written `<form name="…">` works without it.

Reading answers:

```sh
whiteboard wait --page plan --type ship     # the next answer to that form
whiteboard watch --page plan                # streams submits, never exits
whiteboard events --page plan --last 1      # what was already submitted
```

`wait` never misses an answer and never hands one out twice. Handing an
answer out is itself an event in the log (`whiteboard:picked`), and when a
wait starts it first returns the answers nobody picked up yet, including
ones given before it started, whatever filter handed out the others. So an
agent can ask, do other work, and wait later.

`wait` is built from smaller pieces that are commands too, for a script that
wants to use the log its own way (pick an answer up only once it has acted
on it, say):

```sh
whiteboard events --follow --page plan      # every new event as it comes, marking nothing
whiteboard pick <event id>                  # record one as picked up, as wait does
whiteboard append --page plan --type <t>    # write one
```

The same pieces are a module, `@bigmistqke/whiteboard/log`: `read`,
`follow`, `appendEvent`, `pick`, and `handOut`, which is `wait` itself.

## A terminal on every page

The terminal is a plugin: add it to the config, with the program a new tab
starts. Without `command`, a tab is just your shell.

```ts
import terminal from '@bigmistqke/whiteboard/terminal'

export default defineConfig({
  plugins: [terminal({ command: 'claude' })],   // or ['npm', 'run', 'dev'], with arguments
})
```

`whiteboard terminal` prints a link that unlocks a terminal drawer at the
bottom of every page of the project, in that browser. Collapsed it's a bar;
open, it shows a terminal with tabs. Each tab is a session in a
pseudo-terminal, in a small host process of its own that the server starts.
So the sessions outlive the browser tab (switching pages, reloading or
opening a second browser tab shows the same ones) and the server: a
restarted server finds them where they were. The browser morphs the drawer
from one page into the next (a view transition across the page load), and
the server writes the current screens into each page, so it never shows
empty. Ctrl+\` opens and closes it.

Several browser windows can show the same tab. A tab has one size, the
size of the window you used last (opened the drawer, clicked or typed in
it); the others show it at that size, with a margin or cut off at the right,
until you use them.

A tab runs the command inside your shell, and the shell takes over when the
command exits: leaving `claude` leaves a prompt in the same tab, not a dead
one. "+" opens a tab with just the shell, "×" closes a tab and ends what
runs in it, and a tab whose shell exited offers to start again.

```sh
whiteboard terminal [page]             # the link; the drawer starts the command on demand
whiteboard terminal --new              # start the command in a new tab
whiteboard terminal -- <arguments>     # the same, with these arguments after its own
whiteboard terminal --new --shell      # a new tab with just the shell
whiteboard terminal open <page>        # from inside a tab: show a page where its drawer is
whiteboard terminal stop               # end every tab and their host
```

With `command: 'claude'`, `whiteboard terminal -- --resume <id>` continues
a Claude Code session in a new tab.

Programs in a tab know which tab they run in (`WHITEBOARD_TERMINAL`), so an
agent there can show you a page: `whiteboard terminal open <page>` takes the
browser tab whose drawer you used last to that page, and the drawer comes
along.

The terminal runs code, so it needs the project's token: `.whiteboard/token`,
made on first use and gitignored. The link (`/_/auth`) sets it as a cookie
that is only sent from the project's own pages, and requests from another
origin are refused. Any plugin can ask the core whether a request has it.

It needs `node-pty`, an optional dependency; without it the drawer says what
to install. The host listens on `.whiteboard/terminal/host.sock`, readable
by its owner only, and leaves ten minutes after the last tab's program ended.

The token keeps other websites out, not agents: it is in the project, and so
is the config the server runs. **whiteboard runs with the rights of whoever
started its server, and adds none**, so start the server where your agents
run. If they run in a sandbox, start it from inside that sandbox (an agent
running `whiteboard show` does); the terminal and everything else it starts
are then boxed in the same way. A server started outside the sandbox lets an
agent reach past it, through the terminal or simply by editing `config.ts`.

## Claude Code hooks

The Claude Code plugin tells an agent session what is open on its pages,
from outside the agent, so a forgotten wait gets noticed:

```ts
import claudeCode from '@bigmistqke/whiteboard/claude-code'

export default defineConfig({
  plugins: [claudeCode()],
})
```

With it, `whiteboard new` claims the page it makes for the Claude Code
session that ran it, and `whiteboard status` marks that session's pages.
`whiteboard claude-code install` adds three hooks to the project's
`.claude/settings.json`. None of
them ever blocks:

- when a turn ends with something on the session's pages nobody listens for,
  you see a one-line warning;
- when you send a message, answers on the session's pages that no wait
  picked up come with it, and count as picked up from then on;
- a new session starts with the same, plus what is open on other sessions'
  pages (not handed over: those answers stay for whoever waits on them).

## Commands

Every command works on the project of the current folder: the nearest folder
upward with a `.whiteboard/` folder.

| command | does |
| --- | --- |
| `whiteboard init [name]` | make this folder a project |
| `whiteboard root` | print the folder pages go into |
| `whiteboard new <name>` | create a page under a name no other page has (`name`, else `name-2`, …), print its path |
| `whiteboard show <page\|file>` | start the server if needed, print the page's URL |
| `whiteboard url <page\|file>` | the same |
| `whiteboard docs` | print how to write pages in this project (for markboard: its templates' syntax) |
| `whiteboard events [filters] [--follow]` | print recorded events; with `--follow`, then each new one as it comes, marking nothing |
| `whiteboard wait [filters]` | print the next matching event not handed out before, waiting for it if needed |
| `whiteboard watch [filters]` | like `wait`, but never exits: print each matching event once |
| `whiteboard append --page <p> --type <t> [--data <json>]` | add an event to a page's log, such as a reply to a comment |
| `whiteboard pick <event id>` | record an event as picked up, as `wait` does when it hands one out |
| `whiteboard status [--page <p>]` | per page: questions without an answer, answers no agent picked up, who is listening |
| `whiteboard serve` | run the server in the foreground |
| `whiteboard skill [dir]` | print where the agent skill is, or link it into a skills folder |

Filters: `--page <page|file>` (includes pages below it), `--type <type>` (a form's type is its name).
`wait` also takes `--timeout <seconds>` (exits 2 on timeout) and `--count <n>`;
`events` takes `--since <time or event id>` and `--last <n>`.

## Configuration

A project needs no config. Without one it has the defaults: markdown with
markboard, no plugins, and the folder's name. Add `.whiteboard/config.ts`
to change any of that; it takes effect at once, also while the server runs.
Every field is optional:

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import markboard from '@bigmistqke/whiteboard/markboard'
import comments from '@bigmistqke/whiteboard/comments'

export default defineConfig({
  name: 'my-project',    // shown in titles (default: the folder name)
  renderers: [markboard()],  // the default; the first is a page's renderer unless it picks another with `renderer: <name>` in its frontmatter
  files: true,           // serve and watch the rest of the project at /-/ (default: true)
  plugins: [comments()], // behaviour on every page, whatever the renderer: also terminal({ command }), claudeCode()
})
```

A page without a renderer shows as its raw text, live.

Named forms need nothing in the config: the core sends a submit of any
`<form name>` as an event, on a page of any renderer. `comments()` lets you
select any passage and comment on it; the agent replies in the thread.

Set `files: false` for a project whose folder is not a repository, such as
your home folder. Then only `.whiteboard/` is served and watched.
`whiteboard init` sets it when run in the home folder.

## Writing a plugin

A plugin is behaviour on every page, whatever renderer draws it, and
commands of its own. It's an object with a name; everything it adds lives
under that name, so two plugins can't collide. Local plugins go in
`.whiteboard/plugins/` (`.whiteboard/<plugin name>/` is a plugin's data
folder, ignored by git). This one lets the reader vote a page up:

```ts
// .whiteboard/plugins/votes.ts
import { definePlugin } from '@bigmistqke/whiteboard'
import { read } from '@bigmistqke/whiteboard/log'

export default function votes() {
  return definePlugin({
    name: 'votes',
    // on the plugin itself: what works without a server running
    commands: {
      '': {
        description: 'print the votes per page',
        run(ctx) {
          const counts = new Map<string, number>()
          for (const e of read(ctx.eventsFile).events) if (e.type === 'votes:up') counts.set(e.page, (counts.get(e.page) ?? 0) + 1)
          for (const [page, n] of counts) console.log(`${page}: ${n}`)
        },
      },
    },
    // for `whiteboard docs`, under a `# Plugin: votes` heading the core adds
    docs: () => '## Votes\n\nThe reader can vote a page up: a `votes:up` event. `whiteboard votes` counts them.',
    // from setup: what the running server adds (routes, markup, the browser module)
    setup: () => ({ client: new URL('./votes.client.js', import.meta.url) }),
  })
}
```

```js
// .whiteboard/plugins/votes.client.js: plain JavaScript, served as it is
export default function mount(root, page, api) {
  const button = document.createElement('button')
  const draw = () => { button.textContent = `👍 ${api.events().filter(e => e.type === 'votes:up').length}` }
  button.addEventListener('click', () => api.append('votes:up'))
  api.corner().append(button)   // the page's corner, for floating buttons
  api.onEvents(draw)            // every event on the page, the ones it appends too
  draw()
}
```

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import votes from './plugins/votes.ts'

export default defineConfig({ plugins: [votes()] })
```

What a plugin can have:

- **On the plugin:** `commands` (`whiteboard <name>` and `whiteboard <name>
  <sub>`, with declared options the core parses and checks), `docs`
  (markdown for agents: what the plugin sends to the log, and how to answer
  it), and `session()` (the agent session a command runs in).
- **From `setup(ctx)`**, which runs once per loaded config on the server:
  - `routes`, by method and path (`'POST /start'` is mounted at
    `/api/<name>/start`), each with what it does, whether it needs the
    project's token (`auth`), and the types of its body and query; the core
    checks all of that before the route's code runs;
  - `shell`, markup at the end of every page's `<head>` and `<body>`;
  - `client`, a browser module the page imports after the renderer's.
- **A command gets** the project, its event log (`ctx.eventsFile`, for
  `@bigmistqke/whiteboard/log`), its token and server, what is open on each
  page (`ctx.status`), and handing out (`ctx.handOut`, what `wait` does).
- **A browser module** is plain JavaScript (the server sends it as it is; one
  written in TypeScript needs building first). Its default export runs once
  per page load with the page and the same `api` a renderer gets: the page's
  events and `append`, the listeners, `onRendered` (after the renderer
  patched the page, to put back what it adds), `corner()` for floating
  buttons, and `badge()` for counts in the tab title. Files beside it that are
  browser assets (scripts, styles, images, fonts) are served too.
- **Its events** are named after it, `<plugin name>:<what>`. For now
  `whiteboard status` and `wait` treat them like a form's answers.

Something that covers the bottom of the window says how much in
`--wb-inset-bottom`, and markboard keeps clear of it. A plugin can't be
named like a built-in command or a folder of the core.

## Writing a renderer

A renderer turns a stored page into what the reader sees. It's chosen per
page: the config's first renderer, or the one a page names in its
frontmatter (`renderer: plain`). Local renderers go in
`.whiteboard/renderers/`. This one shows a page as its text:

```ts
// .whiteboard/renderers/plain.ts
import { defineRenderer, html } from '@bigmistqke/whiteboard'

export default function plain() {
  return defineRenderer({
    name: 'plain',
    // server: the page's first HTML, for every kind of stored page
    render: page => ({
      html: page.kind === 'page' ? html`<pre>${page.body}</pre>`
        : page.kind === 'file' ? html`<pre>${page.source}</pre>`
        : html`<p>${page.id}</p>`,
    }),
    client: new URL('./plain.client.js', import.meta.url),
    docs: () => '# plain\n\nA page with `renderer: plain` in its frontmatter shows as its text.',
  })
}
```

```js
// .whiteboard/renderers/plain.client.js: plain JavaScript, served as it is
export default function mount(root, page, api) {
  // the stored page changed: render it again, then say so, so named forms and plugins put back
  // what they add
  page.onChange(async () => {
    root.innerHTML = (await page.render()).html
    api.rendered()
  })
}
```

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import markboard from '@bigmistqke/whiteboard/markboard'
import plain from './renderers/plain.ts'

export default defineConfig({ renderers: [markboard(), plain()] })   // the first is the default
```

- **What `render` gets** is the page as stored (`StoredPage`): a markdown
  page (`kind: 'page'`, with `source`, its `body` without the frontmatter,
  and the `frontmatter`), another text file (`file`), a folder (`folder`),
  or the overview (`pages`). It returns the HTML, and optionally a `title`,
  markup for `<head>`, and `data` for the client. `html`, `raw` and `escape`
  build HTML safely; `ctx.asset(file)` serves a file next to it.
- **The client** (plain JavaScript) mounts once per page load. Without one,
  the core puts a new render in place itself when the page changes.
- **Named forms work on every renderer:** a `<form name="…">` in the HTML is
  sent as an event when submitted, and marked with where it stands. For
  `whiteboard status` and the hooks to know which questions a page asks,
  give the renderer `expects(page)`, returning the forms' names.
- **`docs`** is what `whiteboard docs` prints for agents: how to write a page
  for this renderer. `whiteboard docs plain` prints only this one.

## markboard

`markboard()`, the renderer that ships with the package, renders pages as
markdown extended by templates (forms, grids, callouts, diagrams,
highlighted code and more), and makes each page a conversation: a thread
under every form, comments on any passage, and a page that shows what waits
on whom, folds decided questions away and marks what changed since you
looked. Its own [README](https://github.com/bigmistqke/whiteboard/blob/main/markboard/README.md)
describes all of it, its options, and how to write a template.

## The agent skill

The package includes a skill: instructions that teach an agent where pages
go, how to write them, and how to wait for answers. It is a folder with a
`SKILL.md`, the format several coding agents read.

```sh
npx whiteboard skill                      # prints where the skill folder is
npx whiteboard skill ~/.claude/skills     # links it into Claude Code's skills folder
```

Link it into whichever folder your agent reads skills from. The link points
into the installed package, so the skill updates when you update whiteboard.
Agents that don't read skills can be pointed at the `SKILL.md` file directly.

## Working on whiteboard

Whiteboard is TypeScript. An installed package runs its build from
`dist/`, because Node won't run TypeScript inside `node_modules`. A clone
can run from source instead, so a change needs no build:

```sh
git clone https://github.com/bigmistqke/whiteboard && cd whiteboard
npm install
ln -sf "$PWD/bin/whiteboard.ts" "$(npm prefix -g)/bin/whiteboard"   # your global `whiteboard` runs the source
npm run dev            # rebuilds the browser code as you change it
```

`whiteboard` then runs from source in every project on your machine. That
includes the server it starts, and what a project's config imports from
the package (markboard and the plugins), so a project needs nothing of its
own for this. What a change takes:

| what you change | what it takes |
| --- | --- |
| markboard, a template, a plugin's server side | nothing: the server reloads open pages |
| browser code (`client.ts`, `markboard/client/`) | `npm run dev` running; open pages reload |
| the core (`src/`, `bin/`) | restart the project's server; commands pick it up on their next run |

Don't use `npm link` for this: it links `whiteboard` to the build, which
changes only when you run `npm run build`. Without a global command,
`node bin/whiteboard.ts <command>` works from inside the clone.

- `npm test`: the unit tests (`node:test`)
- `npm run test:browser`: forms, comments and the terminal in a real browser
  (Playwright; `npx playwright install chromium` once). Each test runs a
  throwaway project with its own server, from source
- `npm run check`: type-check everything
- `npm run build`: build `dist/`, what the package ships; `node
  dist/bin/whiteboard.js` runs it as an installed copy would

## Design

[DESIGN.md](https://github.com/bigmistqke/whiteboard/blob/main/DESIGN.md)
records how whiteboard works and why: the principles, the engine, the
template contract and the page client.

## License

MIT
