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
terminal at the bottom of the page, is a plugin.

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
  config.ts       optional: what differs from the defaults (plugins, a stylesheet, options)
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
- **Markdown, extended by plugins.** A page is markdown, and plugins add
  blocks to it: `:::form`, `:::grid`, `:::chat`, ```` ```mermaid ```` and
  the rest are built-in plugins, and a project can add its own.
- **Live pages.** Every save of a page updates the open tab in place, and
  blocks that changed are marked until you've seen them.
- **Repository files render too.** `/-/README.md` shows that file as a page,
  `/-/src/` lists a folder, and other text files show as highlighted code.
  Relative links between documents work the way they do in the repository.
- **Markdown never breaks a page.** A block nobody brings renders its
  content as plain markdown, and one that throws shows an error in place of
  that block only. A config that fails to load leaves pages as their raw
  text, with the error above it.

## Forms and answers

A form with a `name` and no `action` attribute is recorded when submitted:

```json
{"id":"…","ts":"2026-…","page":"plan","type":"ship","action":"Decide","data":{"when":"this week"}}
```

`type` is the form's name, `action` is the button that was pressed and
`data` holds the fields. The log is an event stream: a plugin can append
events of other types too, through `api.append(type, data)`. Those types
are named after their plugin, `<plugin>:<what>` (`chat:message`,
`comments:reply`, whiteboard's own `whiteboard:picked`), so a form's name
can't contain a colon and its answers never mix with them. The built-in
`form` plugin writes forms as markdown with inputs inline
(`:::form{name=ship}` … `:radio[this week]{name=when}` … `:::`); a
hand-written `<form name="…">` works without it.

A plugin says which of its events are for an agent (`handOut: true`): chat
messages and comments are, so a `wait` on the page hands them out like
answers. Others, such as a vote, stay in the log, for `whiteboard events`
or a `wait --type` that asks for them.

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

The terminal is a plugin: add it to the config.

```ts
import terminal from '@bigmistqke/whiteboard/terminal'

export default defineConfig({
  plugins: [terminal()],
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

Every tab is your shell. The tabs sit at the bar's right, "+" at its end
opens one, and "×" closes a tab and ends what runs in it. A tab started with
a program runs it inside your shell, and the shell takes over when it exits:
leaving `claude` leaves a prompt in the same tab, not a dead one. A tab whose
shell exited offers to start it again, as it was.

```sh
whiteboard terminal [page]             # the link that opens the drawer in this browser
whiteboard terminal --new              # a new tab with the shell
whiteboard terminal -- <program> …     # run a program in a new tab: -- claude --resume <id>
whiteboard terminal open <page>        # show a page where the drawer you used last is
whiteboard terminal stop               # end every tab and their host
```

An agent can show you a page: `whiteboard terminal open <page>` takes the
browser tab whose drawer you used last to that page, and the drawer comes
along. A program in a tab knows which tab it runs in (`WHITEBOARD_TERMINAL`)
and opens it where that tab's drawer is; without it, where you were last.

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
| `whiteboard docs [name]` | print how to write pages in this project: the blocks, then each plugin's docs; with a name, only that plugin's |
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

A project needs no config. Without one it has the defaults: the built-in
plugins and the folder's name. Add `.whiteboard/config.ts` to change any of
that; it takes effect at once, also while the server runs. Every field is
optional:

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import terminal from '@bigmistqke/whiteboard/terminal'
import code from '@bigmistqke/whiteboard/code'

export default defineConfig({
  name: 'my-project',            // shown in titles (default: the folder name)
  plugins: [                     // added to the built-in ones
    terminal(),
    code({ themes: { light: 'github-light', dark: 'github-dark' } }),   // same name: replaces the built-in
  ],
  style: new URL('./site.css', import.meta.url),   // a stylesheet on every page, after the others
  files: true,                   // serve and watch the rest of the project at /-/ (default: true)
})
```

The built-in plugins are callout, chat, code, comments, details, form,
gallery, grid, mermaid and quiet: every project has them, and
`whiteboard docs` shows how to write each. A config's `plugins` add to them,
and one with a built-in's name replaces it. The terminal and the Claude Code
plugin are opt-in, since they run code or are about one agent.

Named forms need nothing in the config: the core sends a submit of any
`<form name>` as an event, on any page.

Set `files: false` for a project whose folder is not a repository, such as
your home folder. Then only `.whiteboard/` is served and watched.
`whiteboard init` sets it when run in the home folder.

## Writing a plugin

Everything that extends whiteboard is a plugin: syntax for pages,
behaviour on every page, commands, events. A plugin is an object with a
name, and everything it adds lives under that name, so two plugins can't
collide: its block `:::name`, its events `name:…`, its command
`whiteboard name`, its routes `/api/name/…` and its data folder
`.whiteboard/name/`. Local plugins go in `.whiteboard/plugins/`.

### A block: a checklist the reader ticks

A block is syntax: `:::name` around content, `::name` on a line, `:name`
inside a line, or a code fence of that name. It renders on the server, and
with a `client` it is mounted in the browser too.

```ts
// .whiteboard/plugins/checklist/index.ts
import { definePlugin, html, type DirectiveContext } from '@bigmistqke/whiteboard'

const toText = (node: any): string => node.value ?? (node.children ?? []).map(toText).join('')

export default function checklist() {
  return definePlugin({
    name: 'checklist',
    blocks: {
      checklist: {
        // what the browser part gets: the block's list items as text
        props: ctx => {
          const c = ctx as DirectiveContext   // a block (`:::checklist`), not a code fence
          return {
            name: c.attrs.name ?? 'checklist',
            items: (c.children as any[]).filter(n => n.type === 'list')
              .flatMap(list => list.children.map((item: any) => toText(item))),
          }
        },
        // shown until the client mounts, then replaced
        html: () => html`<ul class="checklist"></ul>`,
        client: new URL('./client.js', import.meta.url),
      },
    },
    // its events, and whether a `wait` on the page hands them out (a tick is information: no)
    events: { 'checklist:tick': { description: '`{ checklist, item, checked }`' } },
    // for `whiteboard docs`, under a `# Plugin: checklist` heading the core adds
    docs: () => 'A list the reader ticks:\n\n    :::checklist{name=launch}\n    - Write the changelog\n    :::\n',
  })
}
```

```js
// .whiteboard/plugins/checklist/client.js: plain JavaScript, served as it is
export default function mount(el, { name, items }, api) {
  const ticked = () => {
    const state = new Map()
    for (const e of api.events()) if (e.type === 'checklist:tick' && e.data.checklist === name) state.set(e.data.item, e.data.checked)
    return state
  }
  const draw = () => {
    const state = ticked()
    el.replaceChildren(...items.map(item => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!state.get(item) })
      box.addEventListener('change', () => api.append('checklist:tick', { checklist: name, item, checked: box.checked }))
      const label = document.createElement('label')
      label.append(box, ' ', item)
      return label
    }))
  }
  draw()
  // the page's events, also the ones it appends itself, come back here
  return api.onEvents(draw)
}
```

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard'
import checklist from './plugins/checklist/index.ts'

export default defineConfig({ plugins: [checklist()] })
```

An agent can wait for a tick by asking for it: `whiteboard wait --page
<file> --type checklist:tick`.

### Behaviour on every page: votes

A plugin can also put something on every page, and add commands:

```ts
// .whiteboard/plugins/votes.ts
import { definePlugin } from '@bigmistqke/whiteboard'
import { read } from '@bigmistqke/whiteboard/log'

export default function votes() {
  return definePlugin({
    name: 'votes',
    events: { 'votes:up': { description: 'the reader voted the page up' } },
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
    docs: () => 'The reader can vote a page up: a `votes:up` event. `whiteboard votes` counts them.',
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
  api.onEvents(draw)
  draw()
}
```

### What a plugin can have

- **`blocks`**, by name. A block has `html(ctx)` (the server's HTML; `ctx`
  has the block's attributes, label, content as mdast nodes, `toHtml`,
  `sections` and more), `props(ctx)` (JSON for its client), `client` (a
  browser module, mounted per block), `style` (linked on pages that use it),
  and `fence: 'any'` for the block that takes every code fence nobody else
  claims. Block names are unique across a project's plugins.
- **`events`**, by type (`<plugin>:<what>`): a description each, and
  `handOut: true` for those an agent should get unasked, like a chat
  message. `whiteboard docs` lists them.
- **`style`**: a stylesheet on every page.
- **`docs`**: markdown for agents: how to write its blocks, what its events
  mean, how to answer.
- **`commands`**: `whiteboard <name>` and `whiteboard <name> <sub>`, with
  declared options that the core parses and checks. A command gets the
  project, its event log (`ctx.eventsFile`, for
  `@bigmistqke/whiteboard/log`), its token and server, what is open on each
  page (`ctx.status`), and handing out (`ctx.handOut`, what `wait` does).
- **`session()`**: the agent session a command runs in, for a plugin that
  knows how its agent says so.
- **`setup(ctx)`**, which runs once per loaded config on the server and
  returns:
  - `routes`, by method and path (`'POST /start'` is mounted at
    `/api/<name>/start`), each with what it does, whether it needs the
    project's token (`auth`), and the types of its body and query; the core
    checks all of that before the route's code runs;
  - `shell`, markup at the end of every page's `<head>` and `<body>`;
  - `client`, a module on every page, run once per page load.

**Browser code is plain JavaScript**: the server sends it as it is, so one
written in TypeScript needs building first. A block's `client` gets
`mount(element, props, api)` and may return a cleanup, run when the block
is replaced on a live update; it replaces the server's HTML when it mounts.
A page module (`setup`'s `client`) gets `mount(root, page, api)`. Both get
the page's `api`: its events and `append` (which comes back through
`onEvents`), the listeners, `onRendered` (after a live update, to put back
what it adds), `corner()` for floating buttons, `badge()` for counts in the
tab title, and the theme. Files beside a browser module that are browser
assets (scripts, styles, images, fonts) are served too.

Something that covers the bottom of the window says how much in
`--wb-inset-bottom`, and the page keeps clear of it. A plugin can't be
named like a built-in command or a folder of the core.

## Pages

Each page is a conversation between you and the agent that writes it:
forms you answer, a chat under each form, comments on any passage, and a
page that shows at a glance what waits on whom.

````markdown
# Release plan

:::callout[Status: one question open]{.note}
The parser is done; the docs wait on the question below.
:::

:::grid{cols=2}
### Parser {done}
Rewritten, all tests pass.

### Docs {todo}
Not started.
:::

:::form{name=ship}
**When do we ship?**

- :radio[This week]{name=when recommended}
  The docs are small; ship and follow up.
- :radio[Next week]{name=when}
  Ship with the docs complete.
:::
````

- **Forms.** The writer's recommended option is tagged, never preselected,
  so a choice is only made by picking it. What you type is kept until you
  send it, across live updates and reloads. Sending confirms itself.
- **A chat under every form,** to ask about a question without answering
  it: a message is never a submit. `:::chat{name=…}` puts one anywhere.
- **What waits on whom.** A form is waiting for you (an agent listens for
  it), nobody listening, waiting for the agent (answered, not yet picked
  up), or decided: then it folds to one line quoting the answer, with its
  chat still under it, and a click opens it again. A line above the page
  counts them, a button jumps to the next form waiting for you, and the tab
  title gets a `(!n)` prefix.
- **Comments.** Select any passage and comment on it; the agent replies in
  the thread or edits the page. Passages are found again after edits.
- **What changed.** A block you haven't seen gets a bar until it has been
  in view a moment, remembered per page, so coming back shows what changed
  since. `:::quiet` content never counts as new.
- **Reading.** Updates keep your place: focus, typed values, open
  `<details>` and scroll. A frame with breadcrumbs, the time of the last
  update and a theme toggle. Numbered headings. An overview of the
  project's pages and markdown documents, and repository files rendered at
  `/-/`.

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
the package (the plugins), so a project needs nothing of its
own for this. What a change takes:

| what you change | what it takes |
| --- | --- |
| a plugin's server side (its blocks, commands, routes) | nothing: the server reloads open pages |
| browser code (a plugin's `client.ts`/`client.tsx`, `src/client/`) | `npm run dev` running; open pages reload |
| the core (`src/`, `bin/`, the markdown engine in `src/pages/`) | restart the project's server; commands pick it up on their next run |

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
- `npm run release`: type-check and test, then ask for the new version
  ([bumpp](https://github.com/antfu-collective/bumpp)), commit and tag it as
  `Release vX.Y.Z`, push, and publish to npm. Publishing reads the token from
  `NPM_TOKEN` (`.npmrc`); it needs a granular token that may publish without
  a one-time password

## Design

[DESIGN.md](https://github.com/bigmistqke/whiteboard/blob/main/DESIGN.md)
records how whiteboard works and why: the principles, the engine, the
plugin contract and the page in the browser.

## License

MIT
