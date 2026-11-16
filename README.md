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
npx whiteboard init                # creates .whiteboard/ with a config and a pages folder
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
  config.ts       renderers and options
  pages/          the pages: pages/plan.md is served at /plan
  events.ndjson   every form submit, one JSON object per line, and which ones an agent picked up
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
`data` holds the fields. The log is an event stream: a template can append
events of other types too, through `api.append(type, data)`. The
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

## A terminal on every page

The terminal is a plugin: add it to the config, with the program a
session starts. Without `command` it starts your shell.

```ts
import terminal from '@bigmistqke/whiteboard/terminal'

export default defineConfig({
  renderers: [markboard()],
  plugins: [terminal({ command: 'claude' })],   // or ['npm', 'run', 'dev'], with arguments
})
```

`whiteboard terminal` prints a link that unlocks a terminal drawer at the
bottom of every page of the project, in that browser. Collapsed it's a bar;
open, it runs the command in a pseudo-terminal, in a small host process of
its own that the server starts. So the session outlives the tab (switching
pages, reloading or opening a second tab shows the same session) and the
server: a restarted server finds the session where it was. The browser
morphs the drawer from one page into the next (a view transition across the
page load), and the server writes the current screen into each page, so it
never shows empty. Ctrl+\` opens and closes it.

```sh
whiteboard terminal [page]             # the link; the drawer starts the command on demand
whiteboard terminal -- <arguments>     # start it with these arguments after its own
whiteboard terminal --restart          # replace the running session (with -- <arguments> too)
whiteboard terminal stop               # end the session and its host
```

With `command: 'claude'`, `whiteboard terminal --restart -- --resume <id>`
continues a Claude Code session in the drawer.

The terminal runs code, so it needs the project's token: `.whiteboard/token`,
made on first use and gitignored. The link (`/_/auth`) sets it as a cookie
that is only sent from the project's own pages, and requests from another
origin are refused. Any plugin can ask the core whether a request has it.
It needs `node-pty`, an optional dependency; without it the drawer says what
to install. The host listens on `.whiteboard/terminal/host.sock`, readable
by its owner only, and leaves ten minutes after its program ended.

## Claude Code hooks

The Claude Code plugin tells an agent session what is open on its pages,
from outside the agent, so a forgotten wait gets noticed:

```ts
import claudeCode from '@bigmistqke/whiteboard/claude-code'

export default defineConfig({
  renderers: [markboard()],
  plugins: [claudeCode()],
})
```

With it, `whiteboard new` claims the page it makes for the Claude Code
session that ran it, and `whiteboard status` marks that session's pages.
`whiteboard claude-code install` adds three hooks to the project's
`.claude/settings.json`, and replaces the ones older versions added. None of
them ever blocks:

- when a turn ends with something on the session's pages nobody listens for,
  you see a one-line warning;
- when you send a message, answers on the session's pages that no wait
  picked up come with it, and count as picked up from then on;
- a new session starts with the same, plus what is open on other sessions'
  pages (not handed over: those answers stay for whoever waits on them).

## Commands

Every command works on the project of the current folder: the nearest folder
upward with `.whiteboard/config.ts`.

| command | does |
| --- | --- |
| `whiteboard init [name]` | make this folder a project |
| `whiteboard root` | print the folder pages go into |
| `whiteboard new <name>` | create a page under a name no other page has (`name`, else `name-2`, …), print its path |
| `whiteboard show <page\|file>` | start the server if needed, print the page's URL |
| `whiteboard url <page\|file>` | the same |
| `whiteboard docs` | print how to write pages in this project (for markboard: its templates' syntax) |
| `whiteboard events [filters]` | print recorded events |
| `whiteboard wait [filters]` | print the next matching event not handed out before, waiting for it if needed |
| `whiteboard watch [filters]` | like `wait`, but never exits: print each matching event once |
| `whiteboard append --page <p> --type <t> [--data <json>]` | add an event to a page's log, such as a reply to a comment |
| `whiteboard status [--page <p>]` | per page: questions without an answer, answers no agent picked up, who is listening |
| `whiteboard serve` | run the server in the foreground |
| `whiteboard skill [dir]` | print where the agent skill is, or link it into a skills folder |

Filters: `--page <page|file>` (includes pages below it), `--type <type>` (a form's type is its name).
`wait` also takes `--timeout <seconds>` (exits 2 on timeout) and `--count <n>`;
`events` takes `--since <time or event id>` and `--last <n>`.

## Configuration

```ts
// .whiteboard/config.ts
import { defineConfig } from '@bigmistqke/whiteboard/config'
import markboard from '@bigmistqke/whiteboard/markboard'
import comments from '@bigmistqke/whiteboard/comments'

export default defineConfig({
  name: 'my-project',    // shown in titles (default: the folder name)
  renderers: [markboard()],  // the first is the default; a page picks another with `renderer: <name>` in its frontmatter
  files: true,           // serve and watch the rest of the project at /-/ (default: true)
  plugins: [comments()], // behaviour on every page, whatever the renderer: also terminal({ command }), claudeCode()
})
```

A page without a renderer shows as its raw text, live.

Named forms need nothing in the config: the core sends a submit of any
`<form name>` as an event, on a page of any renderer. `comments()` lets you
select any passage and comment on it; the agent replies in the thread.
`whiteboard init` adds it.

A plugin (`definePlugin` from `@bigmistqke/whiteboard/config`)
declares what it adds, and everything lives under its name, so two
plugins can't collide:

- `routes`, by method and path (`'POST /start'`), are mounted at
  `/api/<name>/start`. Each says what it does, whether it needs the token
  (`auth`), and the types of its body and query fields. The core checks all
  of that before the route's code runs.
- `commands` are `whiteboard <name>` and `whiteboard <name> <sub>`, with
  declared options that the core parses and checks.
- `shell` adds markup at the end of every page's `<head>` and `<body>`.
- `docs` is markdown that `whiteboard docs` prints after the renderers':
  what the plugin sends to the log, and how an agent answers it.
- `client` is a browser module the page imports after the renderer's, with
  the page and the same api a renderer gets: events, listeners, a signal
  after the renderer patched the page, the page's corner for floating
  buttons, and counts in the tab title.
- Its files go in `.whiteboard/<name>/`, which git ignores and which reloads
  nothing when it changes.

`whiteboard help` lists the commands and `whiteboard docs` the routes. An
plugin can't be named like a built-in command or a folder of the core.
Something that covers the bottom of the window says how much in
`--wb-inset-bottom`, and markboard keeps clear of it.

Set `files: false` for a project whose folder is not a repository, such as
your home folder. Then only `.whiteboard/` is served and watched.
`whiteboard init` sets it when run in the home folder.

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

## Design

[DESIGN.md](https://github.com/bigmistqke/whiteboard/blob/main/DESIGN.md)
records how whiteboard works and why: the principles, the engine, the
template contract and the page client.

## License

MIT
